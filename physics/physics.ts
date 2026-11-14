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
 * The plasma is already advanced to the current time (Keplerian shear, density-wave arms, orbiting flares);
 * the shader does not rotate it. Renderer uniforms: uPlasma, uPlasmaMix, uPlasmaSize (set by bindUniforms).
 *
 * Usage:
 *   const plasma = new PlasmaDisk({ spin: 0.9, outerRg: 30 });
 *   each frame:  plasma.step(dtSeconds, rgSeconds);   // rgSeconds = G*M/c^3 of the hole (R_g / c in seconds)
 *                plasma.upload(gl);                    // only re-uploads when step() changed the data
 *                gl.useProgram(blackholeProgram); plasma.bindUniforms(gl, blackholeProgram, 4, 1.0);
 */
import { iscoRadiusRg } from '../graphics/shaders';

const TAU = Math.PI * 2;
/** Shear is bounded by cross-fading two phases of this length (R_g/c): keeps structure resolvable in the texture. */
const FLOW_CYCLE = 120;
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
  /** Maximum texture refresh rate (Hz of real time). Default 8. */
  readonly updateHz?: number;
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

// ---------------------------------------------------------------------------------------------
export class PlasmaDisk {
  readonly rIn: number;
  readonly rOut: number;
  readonly width: number;
  readonly height: number;
  /** Mip level 0, RGBA float32, row-major: index ((j * width + i) * 4), i = radial (u), j = azimuth (v). */
  readonly data: Float32Array;

  private readonly spin: number;
  private readonly seed: number;
  private readonly minInterval: number;
  private readonly lnIn: number;
  private readonly lnSpan: number;
  private readonly levels: Float32Array[] = [];
  private readonly levelSizes: [number, number][] = [];
  private timeRg = 0;
  private sinceUpdate = Infinity;
  private dirty = true;

  private texture: WebGLTexture | null = null;
  private readonly uniformCache = new WeakMap<WebGLProgram, Record<'tex' | 'mix' | 'size', WebGLUniformLocation | null>>();

  constructor(options: PlasmaOptions) {
    this.spin = Math.min(Math.max(options.spin, 0), 0.998);
    this.rIn = options.innerRg !== undefined && options.innerRg > 0 ? options.innerRg : iscoRadiusRg(this.spin);
    this.rOut = Math.max(options.outerRg, this.rIn * 1.5);
    this.width = Math.max(8, options.width ?? 256);
    this.height = Math.max(8, options.height ?? 256);
    this.seed = options.seed ?? 1337;
    this.minInterval = 1 / Math.max(options.updateHz ?? 8, 0.1);
    this.lnIn = Math.log(this.rIn);
    this.lnSpan = Math.log(this.rOut / this.rIn);
    this.data = new Float32Array(this.width * this.height * 4);

    let w = this.width, h = this.height;
    this.levels.push(this.data);
    this.levelSizes.push([w, h]);
    while (w > 1 || h > 1) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.levels.push(new Float32Array(w * h * 4));
      this.levelSizes.push([w, h]);
    }
    this.rebuild();
  }

  /** Simulation time in R_g / c. */
  get time(): number {
    return this.timeRg;
  }

  /**
   * Advance the plasma. dtSeconds = simulated seconds, rgSeconds = G*M/c^3 of the black hole (the time light needs
   * to cross one R_g; ~21 s for Sgr A*). Returns true when the texture data was regenerated.
   */
  step(dtSeconds: number, rgSeconds: number): boolean {
    this.timeRg += dtSeconds / Math.max(rgSeconds, 1e-9);
    this.sinceUpdate += dtSeconds > 0 ? Math.min(dtSeconds, 1) : 0;
    return this.maybeRebuild();
  }

  /** Jump to an absolute simulation time (R_g / c) and rebuild immediately. */
  setTime(timeRg: number): void {
    this.timeRg = timeRg;
    this.rebuild();
  }

  private maybeRebuild(): boolean {
    if (this.sinceUpdate < this.minInterval) return false;
    this.rebuild();
    return true;
  }

  private omega(r: number): number {
    return 1 / (Math.pow(r, 1.5) + this.spin);
  }

  private rebuild(): void {
    this.sinceUpdate = 0;
    const { width: W, height: H, data, seed } = this;
    const t = this.timeRg;
    const phase = (t / FLOW_CYCLE) % 1;
    const tau0 = FLOW_CYCLE * phase;
    const tau1 = FLOW_CYCLE * (phase - 1);
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
        amp: 3 * env * env * (0.6 + 0.8 * hash(k, epoch, 5, seed)),
      });
    }

    // Pass 1: raw density, temperature noise (stored temporarily in B), hot spots.
    let sumW = 0, sumRho = 0;
    for (let j = 0; j < H; j++) {
      const phi = ((j + 0.5) / H - 0.5) * TAU;
      for (let i = 0; i < W; i++) {
        const lnR = this.lnIn + ((i + 0.5) / W) * this.lnSpan;
        const r = Math.exp(lnR);
        const om = this.omega(r);
        let rho = 0, tn = 0;
        for (let layer = 0; layer < 2; layer++) {
          const tau = layer === 0 ? tau0 : tau1;
          const wgt = layer === 0 ? 1 - phase : phase;
          const p0 = phi - om * tau;
          const x = r * Math.cos(p0) * 0.35, y = r * Math.sin(p0) * 0.35;
          const n = fbm(x, y, lnR * 0.9, 4, seed);
          const n2 = fbm(x * 1.7 + 11, y * 1.7 + 3, lnR * 2.1, 3, seed + 101);
          rho += wgt * Math.exp(1.6 * (n - 0.5));
          tn += wgt * (n2 - 0.5);
        }
        const armPhase = ARMS * (phi - patternOmega * t - lnR / 0.35);
        const taper = Math.sin(Math.PI * Math.min(Math.max((lnR - this.lnIn) / this.lnSpan, 0), 1));
        rho *= 1 + 0.45 * Math.cos(armPhase) * taper;
        const g = (lnR - lnGap) / 0.05;
        rho *= 1 - 0.75 * Math.exp(-g * g);

        let flare = 0;
        for (const s of spots) {
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
        sumW += area;
        sumRho += area * rho;
      }
    }

    // Pass 2: normalise the mean density to 1, derive temperature, finish channels.
    const inv = sumW / Math.max(sumRho, 1e-9);
    for (let k = 0; k < W * H; k++) {
      const o = k * 4;
      const rho = Math.min(Math.max(data[o]! * inv, 0.04), 6);
      const armShock = Math.max(data[o + 1]!, 0);
      const tn = data[o + 3]!;
      const temp = 1 + 0.3 * Math.tanh(0.7 * Math.log(rho)) + 0.15 * armShock + 0.3 * tn;
      data[o] = rho;
      data[o + 1] = Math.min(Math.max(temp, 0.6), 1.8);
      data[o + 3] = 1;
    }

    this.buildMips();
    this.dirty = true;
  }

  private buildMips(): void {
    for (let l = 1; l < this.levels.length; l++) {
      const src = this.levels[l - 1]!, dst = this.levels[l]!;
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
  /** Creates the RGBA16F texture on first call, afterwards re-uploads only when the data changed. */
  upload(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.texture) {
      const tex = gl.createTexture();
      if (!tex) throw new Error('PlasmaDisk: could not create texture');
      this.texture = tex;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, this.levels.length, gl.RGBA16F, this.width, this.height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, this.levels.length - 1);
      this.dirty = true;
    }
    if (this.dirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      const prevAlign = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      for (let l = 0; l < this.levels.length; l++) {
        const [w, h] = this.levelSizes[l]!;
        gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, w, h, gl.RGBA, gl.FLOAT, this.levels[l]!);
      }
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, prevAlign);
      this.dirty = false;
    }
    return this.texture;
  }

  /**
   * Binds the texture to `unit` and sets uPlasma, uPlasmaMix, uPlasmaSize on `program`.
   * Call gl.useProgram(program) first. mix = 0 gives the flat procedural disk, 1 full plasma.
   */
  bindUniforms(gl: WebGL2RenderingContext, program: WebGLProgram, unit: number, mix = 1): void {
    const tex = this.upload(gl);
    let locs = this.uniformCache.get(program);
    if (!locs) {
      locs = {
        tex: gl.getUniformLocation(program, 'uPlasma'),
        mix: gl.getUniformLocation(program, 'uPlasmaMix'),
        size: gl.getUniformLocation(program, 'uPlasmaSize'),
      };
      this.uniformCache.set(program, locs);
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(locs.tex, unit);
    gl.uniform1f(locs.mix, Math.min(Math.max(mix, 0), 1));
    gl.uniform2f(locs.size, this.width, this.height);
  }

  dispose(gl: WebGL2RenderingContext): void {
    if (this.texture) gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
