/**
 * physics.ts: accretion-disk PLASMA for the blackhole shader (see the PLASMA contract in graphics/shaders.ts).
 *
 * Writes ONE RGBA16F texture, mipmapped, LINEAR, wrap S = CLAMP_TO_EDGE, wrap T = REPEAT:
 *   u = ln(r / rIn) / ln(rOut / rIn)      r in gravitational radii (R_g), rIn = innerRg or iscoRadiusRg(spin)
 *   v = azimuth / TAU + 0.5               azimuth = atan2(y, x) in the frame whose z axis is the spin axis
 *   R = density / mean density (clumps, spiral arms, a gap; area-weighted mean = 1)
 *   G = temperature / Novikov-Thorne temperature (~1; heating + arm shocks)
 *   B = hot-spot / flare brightness (>= 0; orbiting, shearing blobs)
 *   A = 1 (reserved)
 * The plasma is already advanced to the time it was built for (Keplerian shear, density-wave arms, orbiting
 * flares); the shader does not rotate it.
 *
 * The texture is generated on the CPU, but in small time slices, so a rebuild never stalls a frame:
 *   const plasma = new PlasmaDisk({ spin: 0.9, outerRg: 30, timeRg });
 *   each frame:  plasma.step(dtSeconds, rgSeconds);   // advances time; starts a new build once the plasma has moved enough
 *                plasma.work(budgetMs);                // continues the running build for at most budgetMs
 *                if (plasma.ready) tex = plasma.upload(gl);   // binds the texture on the active unit, re-uploads only a finished build
 * A finished build is swapped in whole (double buffered), so the GPU never sees a half-built texture.
 */
import { iscoRadiusRg } from '../graphics/shaders';

const TAU = Math.PI * 2;
/** Shear is bounded by cross-fading two phases of this length (R_g/c): keeps structure resolvable in the texture. */
const FLOW_CYCLE = 50;
const HOTSPOTS = 6;
const ARMS = 2;

export interface PlasmaOptions {
  /** Dimensionless spin a/M, 0..0.998 (sets the ISCO and Keplerian rate). */
  readonly spin: number;
  /** Outer disk radius in R_g (the shader's uDiskOuterRg). */
  readonly outerRg: number;
  /** Inner radius in R_g; omit to use the ISCO (must match the shader's uDiskInnerRg). */
  readonly innerRg?: number;
  /** Texels along radius (u) and azimuth (v). Powers of two recommended. Default 256 x 256. */
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  /** Simulation time (R_g / c) the first build is made for. Default 0. */
  readonly timeRg?: number;
}

// ---------------------------------------------------------------------------------------------
// Deterministic noise (integer hash, quintic value noise, fbm)
// ---------------------------------------------------------------------------------------------
function hash(a: number, b: number, c: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const u = quintic(x - ix), v = quintic(y - iy), w = quintic(z - iz);
  const h = (dx: number, dy: number, dz: number): number => hash(ix + dx, iy + dy, iz + dz, seed);
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * u;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * u;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * u;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function fbm(x: number, y: number, z: number, octaves: number, seed: number): number {
  let a = 0.5, s = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    s += a * noise3(x, y, z, seed + i * 31);
    norm += a;
    x = x * 2.03 + 5.1;
    y = y * 2.03 + 1.7;
    z = z * 2.03 + 9.3;
    a *= 0.5;
  }
  return s / norm;
}

function wrapPi(a: number): number {
  return a - TAU * Math.round(a / TAU);
}

interface HotSpot {
  lnR: number;
  phi: number;
  sigmaLnR: number;
  sigmaPhi: number;
  amp: number;
}

/** One texture build in progress: the frozen inputs, where it is, and the buffers it writes. */
interface BuildJob {
  readonly t: number;
  readonly tau0: number;
  readonly tau1: number;
  readonly phase: number;
  readonly lnGap: number;
  readonly patternOmega: number;
  readonly spots: readonly HotSpot[];
  readonly out: Float32Array[];
  /** 0: density / hot spots, one row per step; 1: normalise and derive temperature, one row per step. */
  stage: 0 | 1;
  row: number;
  sumW: number;
  sumRho: number;
}

// ---------------------------------------------------------------------------------------------
export class PlasmaDisk {
  readonly rIn: number;
  readonly rOut: number;
  readonly width: number;
  readonly height: number;

  private readonly spin: number;
  private readonly seed: number;
  private readonly lnIn: number;
  private readonly lnSpan: number;
  /** The plasma has to move this far (R_g / c) before another build is worth starting: half a texel in azimuth at the fastest orbit. */
  private readonly minStepRg: number;
  private readonly levelSizes: [number, number][] = [];
  /** The mip chain the GPU texture is uploaded from, and the one the next build writes into. */
  private frontChain: Float32Array[];
  private backChain: Float32Array[];
  private timeRg: number;
  private builtTimeRg: number;
  private job: BuildJob | null = null;
  private isReady = false;
  private dirty = false;

  private texture: WebGLTexture | null = null;

  constructor(options: PlasmaOptions) {
    this.spin = Math.min(Math.max(options.spin, 0), 0.998);
    this.rIn = options.innerRg !== undefined && options.innerRg > 0 ? options.innerRg : iscoRadiusRg(this.spin);
    this.rOut = Math.max(options.outerRg, this.rIn * 1.5);
    this.width = Math.max(8, options.width ?? 256);
    this.height = Math.max(8, options.height ?? 256);
    this.seed = options.seed ?? 1337;
    this.lnIn = Math.log(this.rIn);
    this.lnSpan = Math.log(this.rOut / this.rIn);
    this.minStepRg = Math.PI / this.height / this.omega(this.rIn);
    this.timeRg = options.timeRg ?? 0;
    this.builtTimeRg = this.timeRg;

    let w = this.width, h = this.height;
    this.levelSizes.push([w, h]);
    while (w > 1 || h > 1) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.levelSizes.push([w, h]);
    }
    const make = (): Float32Array[] => this.levelSizes.map(([lw, lh]) => new Float32Array(lw * lh * 4));
    this.frontChain = make();
    this.backChain = make();
    this.beginBuild();
  }

  /** True once the first build has finished; until then there is nothing to upload. */
  get ready(): boolean {
    return this.isReady;
  }

  /**
   * Advance the plasma clock. dtSeconds = simulated seconds, rgSeconds = G*M/c^3 of the black hole (the time light
   * needs to cross one R_g; ~21 s for Sgr A*). Starts a new build when none is running and the plasma has moved at
   * least half a texel at the fastest orbit since the last one started. Does no heavy work itself: call work().
   */
  step(dtSeconds: number, rgSeconds: number): void {
    if (!(dtSeconds > 0)) return;
    this.timeRg += dtSeconds / Math.max(rgSeconds, 1e-9);
    if (this.job === null && Math.abs(this.timeRg - this.builtTimeRg) >= this.minStepRg) this.beginBuild();
  }

  /**
   * Continue the running build for about budgetMs (at least one row). Returns true when a build finished during
   * this call, i.e. when upload() will push new data.
   */
  work(budgetMs: number): boolean {
    const job = this.job;
    if (job === null) return false;
    const end = performance.now() + Math.max(budgetMs, 0);
    do {
      if (job.stage === 0) this.densityRow(job, job.row);
      else this.finishRow(job, job.row);
      job.row += 1;
      if (job.row >= this.height) {
        if (job.stage === 0) {
          job.stage = 1;
          job.row = 0;
        } else {
          this.complete(job);
          return true;
        }
      }
    } while (performance.now() < end);
    return false;
  }

  private omega(r: number): number {
    return 1 / (Math.pow(r, 1.5) + this.spin);
  }

  /** Freeze the inputs for the current time (flow phase, hot spots) and start a build into the back buffer. */
  private beginBuild(): void {
    const t = this.timeRg;
    this.builtTimeRg = t;
    const { seed } = this;
    const phase = (((t / FLOW_CYCLE) % 1) + 1) % 1;
    const lnGap = this.lnIn + this.lnSpan * 0.55;
    const patternOmega = this.omega(Math.exp(this.lnIn + this.lnSpan * 0.4));

    const spots: HotSpot[] = [];
    for (let k = 0; k < HOTSPOTS; k++) {
      const life = 350 + 300 * hash(k, 7, 3, seed);
      const shifted = t + k * 97.3;
      const epoch = Math.floor(shifted / life);
      const age = (shifted - epoch * life) / life;
      const lnR = this.lnIn + this.lnSpan * (0.04 + 0.5 * hash(k, epoch, 1, seed));
      const env = Math.sin(Math.PI * age);
      spots.push({
        lnR,
        phi: TAU * hash(k, epoch, 2, seed) + this.omega(Math.exp(lnR)) * t,
        sigmaLnR: 0.05 + 0.03 * hash(k, epoch, 4, seed),
        sigmaPhi: 0.12 + 0.35 * age,
        amp: 4 * env * env * (0.6 + 0.8 * hash(k, epoch, 5, seed)),
      });
    }

    this.job = {
      t,
      tau0: FLOW_CYCLE * phase,
      tau1: FLOW_CYCLE * (phase - 1),
      phase,
      lnGap,
      patternOmega,
      spots,
      out: this.backChain,
      stage: 0,
      row: 0,
      sumW: 0,
      sumRho: 0,
    };
  }

  /** Pass 1, one azimuth row: raw density, temperature noise (stored temporarily in A), hot spots. */
  private densityRow(job: BuildJob, j: number): void {
    const { width: W, height: H, seed } = this;
    const data = job.out[0]!;
    const phi = ((j + 0.5) / H - 0.5) * TAU;
    for (let i = 0; i < W; i++) {
      const lnR = this.lnIn + ((i + 0.5) / W) * this.lnSpan;
      const r = Math.exp(lnR);
      const om = this.omega(r);
      let rho = 0, tn = 0;
      for (let layer = 0; layer < 2; layer++) {
        const tau = layer === 0 ? job.tau0 : job.tau1;
        const wgt = layer === 0 ? 1 - job.phase : job.phase;
        const p0 = phi - om * tau;
        const x = r * Math.cos(p0) * 0.5, y = r * Math.sin(p0) * 0.5;
        const n = fbm(x, y, lnR * 2.2, 4, seed);
        const n2 = fbm(x * 1.7 + 11, y * 1.7 + 3, lnR * 3.5, 3, seed + 101);
        rho += wgt * Math.exp(2.4 * (n - 0.5));
        tn += wgt * (n2 - 0.5);
      }
      const armPhase = ARMS * (phi - job.patternOmega * job.t - lnR / 0.35);
      const taper = Math.sin(Math.PI * Math.min(Math.max((lnR - this.lnIn) / this.lnSpan, 0), 1));
      rho *= 1 + 0.45 * Math.cos(armPhase) * taper;
      const g = (lnR - job.lnGap) / 0.05;
      rho *= 1 - 0.75 * Math.exp(-g * g);

      let flare = 0;
      for (const s of job.spots) {
        const dr = (lnR - s.lnR) / s.sigmaLnR;
        const dp = wrapPi(phi - s.phi) / s.sigmaPhi;
        flare += s.amp * Math.exp(-0.5 * (dr * dr + dp * dp));
      }

      const o = (j * W + i) * 4;
      data[o] = rho;
      data[o + 1] = 0.5 * Math.cos(armPhase) * taper;
      data[o + 2] = flare;
      data[o + 3] = tn;
      const area = r * r;
      job.sumW += area;
      job.sumRho += area * rho;
    }
  }

  /** Pass 2, one azimuth row: normalise the mean density to 1, derive temperature, finish the channels. */
  private finishRow(job: BuildJob, j: number): void {
    const W = this.width;
    const data = job.out[0]!;
    const inv = job.sumW / Math.max(job.sumRho, 1e-9);
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4;
      const rho = Math.min(Math.max(data[o]! * inv, 0.2), 6);
      const armShock = Math.max(data[o + 1]!, 0);
      const tn = data[o + 3]!;
      const temp = 1 + 0.3 * Math.tanh(0.7 * Math.log(rho)) + 0.15 * armShock + 0.4 * tn;
      data[o] = rho;
      data[o + 1] = Math.min(Math.max(temp, 0.6), 1.8);
      data[o + 3] = 1;
    }
  }

  /** Mips of the finished back buffer, then swap it to the front. */
  private complete(job: BuildJob): void {
    this.buildMips(job.out);
    const old = this.frontChain;
    this.frontChain = job.out;
    this.backChain = old;
    this.job = null;
    this.isReady = true;
    this.dirty = true;
  }

  private buildMips(levels: Float32Array[]): void {
    for (let l = 1; l < levels.length; l++) {
      const src = levels[l - 1]!, dst = levels[l]!;
      const [sw, sh] = this.levelSizes[l - 1]!;
      const [dw, dh] = this.levelSizes[l]!;
      for (let y = 0; y < dh; y++) {
        const y0 = Math.min(2 * y, sh - 1), y1 = Math.min(2 * y + 1, sh - 1);
        for (let x = 0; x < dw; x++) {
          const x0 = Math.min(2 * x, sw - 1), x1 = Math.min(2 * x + 1, sw - 1);
          const o = (y * dw + x) * 4;
          for (let c = 0; c < 4; c++) {
            dst[o + c] =
              (src[(y0 * sw + x0) * 4 + c]! + src[(y0 * sw + x1) * 4 + c]! +
               src[(y1 * sw + x0) * 4 + c]! + src[(y1 * sw + x1) * 4 + c]!) * 0.25;
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // WebGL2 side
  // -------------------------------------------------------------------------------------------
  /**
   * Creates the RGBA16F texture on first call, binds it on the ACTIVE texture unit every call, and re-uploads
   * only when a build finished since the last call. Call it only once ready is true.
   */
  upload(gl: WebGL2RenderingContext): WebGLTexture {
    let tex = this.texture;
    if (tex === null) {
      const made = gl.createTexture();
      if (!made) throw new Error('PlasmaDisk: could not create texture');
      tex = made;
      this.texture = made;
      gl.bindTexture(gl.TEXTURE_2D, made);
      gl.texStorage2D(gl.TEXTURE_2D, this.levelSizes.length, gl.RGBA16F, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.levelSizes.length - 1);
      this.dirty = true;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    if (this.dirty) {
      const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      for (let l = 0; l < this.levelSizes.length; l++) {
        const [w, h] = this.levelSizes[l]!;
        gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, w, h, gl.RGBA, gl.FLOAT, this.frontChain[l]!);
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
      this.dirty = false;
    }
    return tex;
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
