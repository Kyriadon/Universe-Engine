/**
 * graphics/renderer.ts — Universe Engine graphics engine (WebGL2, single canvas).
 *
 * What it does each frame
 *   1. Computes every object's camera-relative position in float64 via coords.ts (deltaInto).
 *   2. LOD: anything smaller than ~1.5 px becomes a magnitude-correct point source (so a galaxy
 *      billions of light-years away is a faint dot with the right flux); everything else is drawn
 *      as an analytic impostor (ray-sphere / raymarch / geodesic in the fragment shader), sorted
 *      far to near, with logarithmic depth from 0.1 m to 1e27 m.
 *   3. Draws into an RGBA16F HDR target (sub-pixel jittered when temporal upscaling is on): sky (star
 *      map + CMB, motion blurred) -> star tiles + far points (streaked by camera motion) -> impostors.
 *      Compact objects and wormholes grab the scene drawn so far and bend it (lensing). Pulsars also draw
 *      their dipole field lines. Stars with `activity` get prominences and flares.
 *   4. Post: temporal upscale (TAAU, history at canvas resolution) -> camera motion blur (depth
 *      reprojection) -> GPU auto-exposure (no read-back) -> dual-filter bloom + lens-flare ghosts ->
 *      ACES tone map, sRGB, dither.
 *
 * Conventions
 *   - Units: metres, seconds, Kelvin. Luminosity in solar luminosities.
 *   - Camera: orthonormal right/up/forward in WORLD axes (the same axes coords.ts uses).
 *   - Equirectangular maps: u = atan2(z, x) / 2pi + 0.5, v = acos(y) / pi, so +Y is the north pole.
 *     Spin axes are world-space vectors.
 *
 * Data sources to put in your assets folder (this engine only loads them; nothing is bundled):
 *   Sky:      NASA SVS "Deep Star Maps" (Gaia / Hipparcos / Tycho), equirectangular.
 *   CMB:      ESA/NASA Planck CMB map (SMICA), saved as an equirectangular image.
 *   Planets:  NASA Visible Earth / Blue Marble (Earth), NASA/USGS Astrogeology and NASA/JPL maps for
 *             the Moon, Mars, Mercury, etc. Solar System Scope publishes CC BY 4.0 maps derived
 *             from NASA data. Check each licence before shipping.
 *   Rings:    a radial colour+alpha strip (e.g. from Cassini data), e.g. 1024x1 or 1024x16 RGBA.
 */

import { deltaInto, type Vec3, type WorldPos } from '../packages/core/src/coords';
import { Prog, createTarget, destroyTarget, loadTexture, solidTexture, type Target, type TexOptions } from './gl';
import * as S from './shaders';

const AU = 1.495978707e11;

// ------------------------------------------------------------------ public scene types

export interface Camera {
  pos: WorldPos;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** Vertical field of view, radians. */
  fovY: number;
}

/** Atmosphere in physical units (metres, 1/metre). EARTH_ATMOSPHERE is a ready-made preset. */
export interface Atmosphere {
  height: number;
  betaR: Vec3;
  betaM: number;
  hR: number;
  hM: number;
  /** Mie asymmetry, 0.7 to 0.8 typical. */
  g: number;
}
export const EARTH_ATMOSPHERE: Atmosphere = {
  height: 1.2e5,
  betaR: [5.8e-6, 13.5e-6, 33.1e-6],
  betaM: 21e-6,
  hR: 8000,
  hM: 1200,
  g: 0.76,
};

export interface BodyTextures {
  /** Colour map (load with srgb: true). */
  albedo?: WebGLTexture;
  /** City lights (srgb: true). */
  night?: WebGLTexture;
  /** Cloud coverage in the red channel (srgb: false). */
  clouds?: WebGLTexture;
  /** Ocean specular mask in the red channel (srgb: false). */
  mask?: WebGLTexture;
  /** Elevation in the red channel, used for bump shading (srgb: false). */
  height?: WebGLTexture;
  /** Stars only: plasma-filament detail map in the red channel (srgb: false). Modulates prominence threads and flare kernels. */
  flare?: WebGLTexture;
}

interface Common {
  pos: WorldPos;
  /** Metres. Meaning per kind: body/star = radius, galaxy/nebula/glow = visual radius,
   *  compact = Schwarzschild radius, wormhole = throat radius, ring = parent planet radius,
   *  pulsar = beam length. */
  radius: number;
  /** Total luminosity in solar luminosities, used when the object is too far to resolve. 0 = vanish. */
  lum?: number;
  /** Colour temperature in K for the far point-source proxy. */
  temp?: number;
}

/** Cosmic-web blob (galaxy cluster / supercluster) or filament (set `axis`). `color` is radiance. */
export interface GlowObj extends Common {
  kind: 'glow';
  color: Vec3;
  /** Half-length vector of the filament axis, metres. Omit for a round blob. */
  axis?: Vec3;
  seed?: number;
}
export interface GalaxyObj extends Common {
  kind: 'galaxy';
  type: 'spiral' | 'elliptical' | 'irregular';
  /** Disc normal (spiral) or polar axis. */
  normal: Vec3;
  /** Mean surface radiance. Physical value: lum * AU^2 / (pi * radius^2). */
  color: Vec3;
  arms?: number;
  pitch?: number;
  bulge?: number;
  /** Spiral: disc scale height / radius (default 0.04). Elliptical: axis ratio (default 0.7). */
  flat?: number;
  seed?: number;
}
/** Emission nebula, dust cloud, supernova remnant. noise: 0 = smooth ball (boson star), 1 = wispy. */
export interface NebulaObj extends Common {
  kind: 'nebula';
  color: Vec3;
  color2?: Vec3;
  density?: number;
  noise?: number;
  seed?: number;
}
/** Resolved star: granulation, limb darkening, spots, corona. Quasi-stars: huge radius, spots 0, cell 3. */
export interface StarObj extends Common {
  kind: 'star';
  temp: number;
  spin?: Vec3;
  spots?: number;
  cell?: number;
  seed?: number;
  /**
   * Magnetic activity 0..1: prominence loops above the limb and flares (bright footpoints on the disc).
   * Default 0 = none. Loops live on a compressed 70-160 s lifecycle of scene time so they are visible.
   */
  activity?: number;
  /** Photosphere map in `albedo` (mean linear luminance 0.5 = unmodulated blackbody) and plasma map in `flare`. */
  tex?: BodyTextures;
}
/** Planet or moon. */
export interface BodyObj extends Common {
  kind: 'body';
  spin: Vec3;
  /** Rotation angle about the spin axis, radians. */
  rot: number;
  /** Albedo colour when there is no albedo texture. */
  tint?: Vec3;
  tex?: BodyTextures;
  atmosphere?: Atmosphere;
  /** City-light radiance scale (default 2e-6). */
  nightScale?: number;
  /** Height-map range in metres (0/undefined = no bump). */
  bump?: number;
  /**
   * Stylised live surface, 0 (default) = static. With a clouds map the clouds drift over the ground;
   * without one, the albedo bands flow in alternating zonal jets (gas giants). 1 is visible at real time.
   */
  flow?: number;
  /** Procedural regional dust storms (Mars). 0 / undefined = none, 1 = visible at real time. */
  storm?: number;
  /**
   * A baked-in vortex (Jupiter's Great Red Spot) that swirls and drifts: [u, v, size, strength], with (u, v) the spot's
   * position in the albedo map (0..1), size its latitude half-extent in radians and strength the peak swirl angle in radians.
   * Used by the zonal-jet path (no clouds map, flow > 0).
   */
  vortex?: [number, number, number, number];
  /**
   * Procedural surface detail that takes over once the camera is closer than the texture's own texel size, so close-ups
   * keep getting sharper instead of turning into a blur. albedo = brightness variation (0..1), relief = lit micro-relief
   * (0..1, rocky bodies), bands = stretch along lines of latitude (1 = isotropic, ~6 for gas-giant streaks).
   */
  detail?: { albedo: number; relief: number; bands?: number };
}
export interface RingObj extends Common {
  kind: 'ring';
  normal: Vec3;
  /** Inner and outer radius in parent-planet radii. */
  inner: number;
  outer: number;
  /** Radial colour+alpha profile (srgb: true, clamp: true). */
  tex?: WebGLTexture;
}
/**
 * Black hole, white hole, gravastar, quark star, neutron star, quasar/AGN core.
 *  - black hole: no `surface`.
 *  - white hole: no `surface`, set `glow` (horizon radiance).
 *  - gravastar / quark star / neutron star: `surface.radius` in Schwarzschild radii (>= 1).
 *  - accretion disc: `disk`. Relativistic jets: `jet`.
 */
export interface CompactObj extends Common {
  kind: 'compact';
  spin?: Vec3;
  /** Dimensionless spin, 0..0.998. */
  a?: number;
  /** Lens region in Schwarzschild radii (default 24, grows to fit disc/surface). */
  extent?: number;
  disk?: { inner?: number; outer: number; temp: number; alpha?: number };
  surface?: { radius: number; temp: number };
  glow?: Vec3;
  jet?: { intensity: number; length: number; width: number; color: Vec3 };
}
export interface WormholeObj extends Common {
  kind: 'wormhole';
  /** Lens region in throat radii (default 8). */
  extent?: number;
  /** Tint of the other universe's sky. */
  otherTint?: Vec3;
}
export interface PulsarObj extends Common {
  kind: 'pulsar';
  spin: Vec3;
  /** Angle between magnetic and spin axes, radians. */
  tilt: number;
  /** Rotation period in scene seconds. */
  period: number;
  color: Vec3;
  /** Beam sharpness, higher = narrower (default 250). */
  sharp?: number;
  phase?: number;
  /** Dipole field-line brightness (default 1, 0 = off). */
  field?: number;
}
export type SceneObject =
  | GlowObj
  | GalaxyObj
  | NebulaObj
  | StarObj
  | BodyObj
  | RingObj
  | CompactObj
  | WormholeObj
  | PulsarObj;

export interface SceneLight {
  readonly id: string;
  pos: WorldPos;
  lum: number;
  temp: number;
  radius: number;
}

export interface Scene {
  /** Seconds. Drives rotation, noise animation, pulsar phase. */
  time: number;
  /** All stellar light sources in this scene. */
  lights: SceneLight[];
  objects: SceneObject[];
}

/** Catalogue tile: interleaved Float32 [x, y, z, lum, temp] per star, x/y/z in metres from `origin`. */
export interface StarTile {
  origin: WorldPos;
  data: Float32Array;
  count: number;
}

export interface ExposureOptions {
  auto?: boolean;
  /** Fixed exposure when auto is false. */
  manual?: number;
  /** Multiplier on the metered exposure. */
  bias?: number;
  min?: number;
  max?: number;
  /** Target mean luminance of lit pixels (0.18 = mid grey). */
  key?: number;
  /** Adaptation time constant, seconds. */
  tau?: number;
  /** Exposure on the first frame. */
  initial?: number;
}

export interface RendererOptions {
  /** Internal resolution relative to the canvas, 0.5..1. */
  renderScale?: number;
  /** Adjust renderScale to hold ~60 fps. */
  dynamicResolution?: boolean;
  bloom?: number;
  exposure?: ExposureOptions;
  /** Camera motion blur shutter as a fraction of the frame time (default 0.5, 0 = off). */
  motionBlur?: number;
  /**
   * Temporal upscaling: jittered render at renderScale, reconstructed at canvas resolution from
   * reprojected history. At renderScale 1 it acts as temporal anti-aliasing. Default true.
   */
  temporalUpscale?: boolean;
  /** Lens-flare ghost intensity multiplier (default 1, 0 = off). */
  lensFlare?: number;
}

// ------------------------------------------------------------------ internals

type PK =
  | 'sky' | 'glow' | 'galaxy' | 'nebula' | 'surface' | 'body' | 'ring' | 'compact' | 'wormhole' | 'pulsar'
  | 'field' | 'stars' | 'lum' | 'adapt' | 'down' | 'up' | 'tone' | 'taau' | 'blur' | 'flare';

interface Tile {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  count: number;
  origin: WorldPos;
}
interface Imp {
  o: SceneObject;
  rx: number;
  ry: number;
  rz: number;
  d: number;
  sortD: number;
  ext: number;
}
interface FrameU {
  right: Vec3;
  up: Vec3;
  fwd: Vec3;
  tanX: number;
  tanY: number;
  w: number;
  h: number;
  sr: number;
  time: number;
  /** TAA jitter: NDC for the vertex shaders, input pixels for the resolve. */
  jx: number;
  jy: number;
  jpx: number;
  jpy: number;
  pRight: Vec3;
  pUp: Vec3;
  pFwd: Vec3;
  ptx: number;
  pty: number;
  /** previous camera minus current camera, metres */
  drx: number;
  dry: number;
  drz: number;
  mbOn: boolean;
  maxPx: number;
}

const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Impostor extent as a multiple of obj.radius: covers halos, atmospheres, discs, the lens region. */
function extentOf(o: SceneObject): number {
  switch (o.kind) {
    case 'star':
      return 1.8;
    case 'body':
      return (1 + (o.atmosphere ? o.atmosphere.height / o.radius : 0)) * 1.02;
    case 'ring':
      return o.outer * 1.02;
    case 'compact':
      return Math.max(o.extent ?? 24, (o.disk?.outer ?? 0) * 1.1, (o.surface?.radius ?? 0) * 1.1);
    case 'wormhole':
      return o.extent ?? 8;
    default:
      return 1;
  }
}

const halton = (i: number, b: number): number => {
  let f = 1;
  let r = 0;
  for (let n = i; n > 0; n = Math.floor(n / b)) {
    f /= b;
    r += f * (n % b);
  }
  return r;
};
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Integer hash -> [0,1). Deterministic, so a loop's look is a pure function of (seed, loop, cycle). */
function hash01(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ Math.imul(c | 0, 0xc2b2ae35) ^ Math.imul(d | 0, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Prominence loops for a star at scene time `time`, packed for the surface shader's uLoops:
 * per loop [c.xyz phi] [t.xyz H] [width life flare twist]. Loops live in the star's rotating frame
 * (the shader spins the surface by 0.03 rad per scene second), regenerate every cycle, grow, hold, lift
 * off and fade; some flare once mid-cycle (fast rise, exponential decay).
 */
function starLoops(o: StarObj, time: number, out: Float32Array): void {
  const act = clamp(o.activity ?? 0, 0, 1);
  const seed = Math.floor((o.seed ?? 0) * 1000);
  const S0 = norm(o.spin ?? [0, 1, 0]);
  const U = norm(cross(S0, Math.abs(S0[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
  const V = cross(S0, U);
  for (let k = 0; k < S.PROM_LOOPS; k++) {
    const per = 70 + 90 * hash01(k, seed, 0, 1);
    const tt = time / per + hash01(k, seed, 0, 2);
    const cyc = Math.floor(tt);
    const x = tt - cyc;
    const h = (salt: number): number => hash01(k, seed, cyc, salt);
    const present = h(3) < 0.2 + 0.8 * act;
    const lat = (h(4) < 0.5 ? -1 : 1) * (h(5) < 0.7 ? 0.15 + 0.55 * h(6) : 0.9 + 0.35 * h(6));
    const lon = 2 * Math.PI * h(7) - 0.03 * time;
    const phi = 0.07 + 0.15 * h(8);
    const H0 = (0.12 + 0.3 * h(9)) * (0.6 + 0.4 * act);
    const w = 0.018 + 0.018 * h(10);
    const psi = 2 * Math.PI * h(11);
    const grow = smooth(0, 0.18, x);
    const lift = smooth(0.82, 1, x);
    const life = present ? grow * (1 - lift) : 0;
    const H = H0 * (0.35 + 0.65 * grow) * (1 + 0.6 * lift);
    const xf = 0.42 + 0.25 * h(12);
    const flare = present && h(13) < 0.25 + 0.45 * act && x > xf ? Math.exp(-(x - xf) * 16) * smooth(0, 0.012, x - xf) : 0;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    const ex: Vec3 = [U[0] * Math.cos(lon) + V[0] * Math.sin(lon), U[1] * Math.cos(lon) + V[1] * Math.sin(lon), U[2] * Math.cos(lon) + V[2] * Math.sin(lon)];
    const east: Vec3 = [-U[0] * Math.sin(lon) + V[0] * Math.cos(lon), -U[1] * Math.sin(lon) + V[1] * Math.cos(lon), -U[2] * Math.sin(lon) + V[2] * Math.cos(lon)];
    const c: Vec3 = [S0[0] * sl + ex[0] * cl, S0[1] * sl + ex[1] * cl, S0[2] * sl + ex[2] * cl];
    const north: Vec3 = [S0[0] * cl - ex[0] * sl, S0[1] * cl - ex[1] * sl, S0[2] * cl - ex[2] * sl];
    const cp = Math.cos(psi);
    const sp = Math.sin(psi);
    const t: Vec3 = [east[0] * cp + north[0] * sp, east[1] * cp + north[1] * sp, east[2] * cp + north[2] * sp];
    const i = k * 12;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = phi;
    out[i + 4] = t[0]; out[i + 5] = t[1]; out[i + 6] = t[2]; out[i + 7] = H;
    out[i + 8] = w; out[i + 9] = life; out[i + 10] = flare; out[i + 11] = (h(14) - 0.5) * 0.12;
  }
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** Filled every frame, handy for a debug overlay. */
  stats = { objects: 0, impostors: 0, points: 0, tiles: 0, scale: 1 };

  private scale: number;
  private dynamic: boolean;
  private bloomK: number;
  private ex: Required<ExposureOptions>;
  private P: Record<PK, Prog>;
  private quadBuf: WebGLBuffer;
  private quadVao: WebGLVertexArrayObject;
  private emptyVao: WebGLVertexArrayObject;
  private pointVbo: WebGLBuffer;
  private pointVao: WebGLVertexArrayObject;
  private points = new Float32Array(5 * 4096);
  private np = 0;
  private tiles = new Map<string, Tile>();
  private blank: WebGLTexture;
  private hdr!: Target;
  private copy!: Target;
  private bloom: Target[] = [];
  private flare: Target | null = null;
  private mb: Target | null = null;
  private hist: Target[] = [];
  private histIdx = 0;
  private histValid = false;
  private temporal: boolean;
  private mbShutter: number;
  private flareK: number;
  private cutNext = true;
  private prevPos: WorldPos | null = null;
  private prevRight: Vec3 = [1, 0, 0];
  private prevUp: Vec3 = [0, 1, 0];
  private prevFwd: Vec3 = [0, 0, 1];
  private prevTanX = 1;
  private prevTanY = 1;
  private prevTime = 0;
  private alphaTaa = 0.1;
  private dprev = new Float64Array(3);
  private loops = new Float32Array(S.PROM_LOOPS * 12);
  private smearA = new Float32Array(32);
  private smearB = new Float32Array(32);
  private lum: Target;
  private expo: [Target, Target];
  private expIdx = 0;
  private sky = { map: null as WebGLTexture | null, cmb: null as WebGLTexture | null, mapScale: 3.4e-9, cmbScale: 0 };
  private frame = 0;
  private fu!: FrameU;
  private rel = new Float64Array(3);
  private t3 = new Float64Array(3);
  private occ = new Float32Array(16);
  private ema = 1 / 60;
  private dynTick = 0;

  constructor(canvas: HTMLCanvasElement, opts: RendererOptions = {}) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float is required for HDR rendering');
    this.gl = gl;
    this.canvas = canvas;
    this.scale = clamp(opts.renderScale ?? 1, 0.5, 1);
    this.dynamic = opts.dynamicResolution ?? false;
    this.bloomK = opts.bloom ?? 0.04;
    this.mbShutter = clamp(opts.motionBlur ?? 0.5, 0, 1);
    this.temporal = opts.temporalUpscale ?? true;
    this.flareK = Math.max(0, opts.lensFlare ?? 1);
    this.ex = {
      auto: opts.exposure?.auto ?? true,
      manual: opts.exposure?.manual ?? 1,
      bias: opts.exposure?.bias ?? 1,
      min: opts.exposure?.min ?? 1e-5,
      max: opts.exposure?.max ?? 5e6,
      key: opts.exposure?.key ?? 0.18,
      tau: opts.exposure?.tau ?? 0.6,
      initial: opts.exposure?.initial ?? 1,
    };

    const mk = (n: PK, vs: string, fs: string): Prog => new Prog(gl, n, vs, fs);
    this.P = {
      sky: mk('sky', S.IMP_VERT, S.SKY_FRAG),
      glow: mk('glow', S.IMP_VERT, S.GLOW_FRAG),
      galaxy: mk('galaxy', S.IMP_VERT, S.GALAXY_FRAG),
      nebula: mk('nebula', S.IMP_VERT, S.NEBULA_FRAG),
      surface: mk('surface', S.IMP_VERT, S.STAR_SURFACE_FRAG),
      body: mk('body', S.IMP_VERT, S.BODY_FRAG),
      ring: mk('ring', S.IMP_VERT, S.RING_FRAG),
      compact: mk('compact', S.IMP_VERT, S.COMPACT_FRAG),
      wormhole: mk('wormhole', S.IMP_VERT, S.WORMHOLE_FRAG),
      pulsar: mk('pulsar', S.IMP_VERT, S.PULSAR_FRAG),
      field: mk('field', S.FIELD_VERT, S.FIELD_FRAG),
      stars: mk('stars', S.STAR_VERT, S.STAR_FRAG),
      lum: mk('lum', S.FSQ_VERT, S.LUM_FRAG),
      adapt: mk('adapt', S.FSQ_VERT, S.ADAPT_FRAG),
      down: mk('down', S.FSQ_VERT, S.DOWN_FRAG),
      up: mk('up', S.FSQ_VERT, S.UP_FRAG),
      tone: mk('tone', S.FSQ_VERT, S.TONE_FRAG),
      taau: mk('taau', S.FSQ_VERT, S.TAAU_FRAG),
      blur: mk('blur', S.FSQ_VERT, S.MB_FRAG),
      flare: mk('flare', S.FSQ_VERT, S.FLARE_FRAG),
    };

    const qb = gl.createBuffer();
    const qv = gl.createVertexArray();
    const ev = gl.createVertexArray();
    const pb = gl.createBuffer();
    if (!qb || !qv || !ev || !pb) throw new Error('buffer allocation failed');
    this.quadBuf = qb;
    this.quadVao = qv;
    this.emptyVao = ev;
    this.pointVbo = pb;
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindVertexArray(qv);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.pointVao = this.makeStarVao(pb);

    this.blank = solidTexture(gl, 0, 0, 0, 255);
    this.lum = createTarget(gl, 64, 64, gl.RGBA16F, { mips: true });
    this.expo = [createTarget(gl, 1, 1, gl.R32F), createTarget(gl, 1, 1, gl.R32F)];
    for (const t of this.expo) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RED, gl.FLOAT, new Float32Array([this.ex.initial]));
    }
    this.resize();
  }

  // ---------------------------------------------------------------- public API

  /** Load an image as a texture for bodies, rings or the sky. */
  loadTexture(url: string, o?: TexOptions): Promise<WebGLTexture> {
    return loadTexture(this.gl, url, o);
  }

  /**
   * Real-sky backgrounds. `map`: star map (sRGB). `cmb`: Planck map shown as false colour.
   * Scales are radiance multipliers; the defaults put the Milky Way near 21 mag/arcsec^2.
   */
  setSky(s: { map?: WebGLTexture | null; cmb?: WebGLTexture | null; mapScale?: number; cmbScale?: number }): void {
    if (s.map !== undefined) this.sky.map = s.map;
    if (s.cmb !== undefined) this.sky.cmb = s.cmb;
    if (s.mapScale !== undefined) this.sky.mapScale = s.mapScale;
    if (s.cmbScale !== undefined) this.sky.cmbScale = s.cmbScale;
  }

  /** Upload (or remove, with null) a star catalogue tile. */
  setStarTile(id: string, t: StarTile | null): void {
    const gl = this.gl;
    const old = this.tiles.get(id);
    if (old) {
      gl.deleteVertexArray(old.vao);
      gl.deleteBuffer(old.vbo);
      this.tiles.delete(id);
    }
    if (!t || t.count === 0) return;
    const vbo = gl.createBuffer();
    if (!vbo) throw new Error('createBuffer failed');
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, t.data.subarray(0, t.count * 5), gl.STATIC_DRAW);
    this.tiles.set(id, { vao: this.makeStarVao(vbo), vbo, count: t.count, origin: t.origin });
  }

  /** Call on window resize (and once at startup; the constructor already does). */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    this.buildTargets();
  }

  /**
   * Call after a camera cut (teleport, switching the floating origin): drops the temporal history and
   * skips motion blur for one frame so nothing smears across the jump. Big jumps are also auto-detected.
   */
  resetTemporal(): void {
    this.cutNext = true;
  }

  render(scene: Scene, cam: Camera, dt: number): void {
    const gl = this.gl;
    const P = this.P;
    this.frame++;
    this.autoScale(dt);
    const W = this.hdr.w;
    const H = this.hdr.h;
    const tanY = Math.tan(cam.fovY / 2);
    const tanX = tanY * (W / H);
    const maxHalf = Math.atan(Math.hypot(tanX, tanY));

    // ---- 1. classify objects: far -> point source, near -> impostor
    this.np = 0;
    const imps: Imp[] = [];
    let minD = Infinity;
    for (const o of scene.objects) {
      deltaInto(this.rel, 0, o.pos, cam.pos);
      const rx = this.rel[0] as number;
      const ry = this.rel[1] as number;
      const rz = this.rel[2] as number;
      const d = Math.max(Math.hypot(rx, ry, rz), 1e-9);
      minD = Math.min(minD, d);
      const ext = o.radius * extentOf(o);
      const cosA = (rx * cam.forward[0] + ry * cam.forward[1] + rz * cam.forward[2]) / d;
      if (d > ext * 1.05 && Math.acos(clamp(cosA, -1, 1)) - Math.asin(Math.min(1, ext / d)) > maxHalf) continue;
      const px = (ext / d / tanY) * H * 0.5;
      if (px < 1.5) {
        if ((o.lum ?? 0) > 0) this.pushPoint(rx, ry, rz, o.lum ?? 0, o.temp ?? 5772);
        continue;
      }
      imps.push({ o, rx, ry, rz, d, sortD: o.kind === 'ring' ? d - o.radius * 0.01 : d, ext });
    }
    imps.sort((a, b) => b.sortD - a.sortD);
    const bodies = scene.objects.filter((o): o is BodyObj => o.kind === 'body');

    // ---- 1b. temporal state: camera delta, cut detection, jitter
    deltaInto(this.dprev, 0, this.prevPos ?? cam.pos, cam.pos);
    const stepLen = Math.hypot(this.dprev[0] as number, this.dprev[1] as number, this.dprev[2] as number);
    const cut =
      this.cutNext ||
      this.prevPos === null ||
      dot(this.prevFwd, cam.forward) < 0.9 ||
      Math.abs(tanY / this.prevTanY - 1) > 0.15 ||
      stepLen > 0.4 * minD;
    if (cut) {
      this.dprev.fill(0);
      this.prevRight = cam.right;
      this.prevUp = cam.up;
      this.prevFwd = cam.forward;
      this.prevTanX = tanX;
      this.prevTanY = tanY;
      this.histValid = false;
      this.cutNext = false;
    }
    const rate = Math.abs(scene.time - this.prevTime) / Math.max(dt, 1e-3);
    this.alphaTaa = 0.1 + 0.5 * clamp(Math.log2(Math.max(rate, 1)) / 6, 0, 1); // fast time warp: trust history less
    this.prevTime = scene.time;
    const hj = (this.frame % 16) + 1;
    const jpx = this.temporal ? halton(hj, 2) - 0.5 : 0;
    const jpy = this.temporal ? halton(hj, 3) - 0.5 : 0;
    this.fu = {
      right: cam.right, up: cam.up, fwd: cam.forward, tanX, tanY, w: W, h: H, sr: (2 * tanY / H) ** 2, time: scene.time,
      jx: (2 * jpx) / W, jy: (2 * jpy) / H, jpx, jpy,
      pRight: this.prevRight, pUp: this.prevUp, pFwd: this.prevFwd, ptx: this.prevTanX, pty: this.prevTanY,
      drx: this.dprev[0] as number, dry: this.dprev[1] as number, drz: this.dprev[2] as number,
      mbOn: this.mbShutter > 0 && !cut,
      maxPx: 0.06 * H,
    };

    // ---- 1c. motion-blur smear list: the 8 biggest bodies/stars with screen position, velocity, radius, depth range
    this.smearA.fill(0);
    this.smearB.fill(0);
    if (this.fu.mbOn) {
      const zOf = (d: number): number => Math.log2(1 + Math.max(d, 0.1) / 0.1) / Math.log2(1 + 1e28);
      const f = this.fu;
      imps
        .filter((im) => im.o.kind === 'body' || im.o.kind === 'star')
        .sort((a, b) => b.o.radius / b.d - a.o.radius / a.d)
        .slice(0, 8)
        .forEach((im, k) => {
          const dir: Vec3 = [im.rx / im.d, im.ry / im.d, im.rz / im.d];
          const vz = dot(dir, cam.forward);
          if (vz <= 1e-4) return;
          const nx = dot(dir, cam.right) / (vz * tanX);
          const ny = dot(dir, cam.up) / (vz * tanY);
          const q: Vec3 = [dir[0] - f.drx / im.d, dir[1] - f.dry / im.d, dir[2] - f.drz / im.d];
          const pz = dot(q, f.pFwd);
          let vx = 0;
          let vy = 0;
          if (pz > 1e-4) {
            vx = (nx - dot(q, f.pRight) / (pz * f.ptx)) * 0.5;
            vy = (ny - dot(q, f.pUp) / (pz * f.pty)) * 0.5;
          }
          const R = im.o.radius;
          this.smearA.set([nx * 0.5 + 0.5, ny * 0.5 + 0.5, vx, vy], k * 4);
          this.smearB.set([(R / im.d / tanY) * 0.5, zOf(im.d - R), zOf(im.d + R), 0], k * 4);
        });
    }

    // ---- 2. scene pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo);
    gl.viewport(0, 0, W, H);
    gl.depthMask(true);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const u of [0, 1, 2, 3, 4, 9, 10]) this.bindTex(u, this.blank);
    this.bindTex(7, this.expo[this.expIdx]?.tex);
    this.bindTex(5, this.sky.map);
    this.bindTex(6, this.sky.cmb);
    this.bindTex(8, this.blank);

    if (this.sky.map || this.sky.cmb) {
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.bindVertexArray(this.quadVao);
      this.use(P.sky);
      P.sky.f('uFull', 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.use(P.stars);
    for (const t of this.tiles.values()) {
      deltaInto(this.rel, 0, t.origin, cam.pos);
      P.stars.f('uTileRel', this.rel[0] as number, this.rel[1] as number, this.rel[2] as number);
      gl.bindVertexArray(t.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, t.count);
    }
    if (this.np > 0) {
      P.stars.f('uTileRel', 0, 0, 0);
      gl.bindVertexArray(this.pointVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.points.subarray(0, this.np * 5), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.np);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.bindVertexArray(this.quadVao);
    for (const im of imps) {
      const cfg = this.setup(im, scene, cam, bodies);
      if (cfg.grab) this.grabScene();
      gl.depthMask(cfg.opaque);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const po = im.o;
      if (po.kind === 'pulsar' && (po.field ?? 1) > 0) {
        gl.depthMask(false);
        this.drawField(im, po);
        gl.bindVertexArray(this.quadVao);
      }
    }

    // remember this frame's camera for the next frame's reprojection
    this.prevPos = cam.pos;
    this.prevRight = cam.right;
    this.prevUp = cam.up;
    this.prevFwd = cam.forward;
    this.prevTanX = tanX;
    this.prevTanY = tanY;

    this.stats = { objects: scene.objects.length, impostors: imps.length, points: this.np, tiles: this.tiles.size, scale: this.scale };

    // ---- 3. post
    this.post(dt);
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.tiles.values()) {
      gl.deleteVertexArray(t.vao);
      gl.deleteBuffer(t.vbo);
    }
    this.tiles.clear();
    for (const t of [this.hdr, this.copy, this.lum, ...this.expo, ...this.bloom, ...this.hist]) destroyTarget(gl, t);
    if (this.flare) destroyTarget(gl, this.flare);
    if (this.mb) destroyTarget(gl, this.mb);
    for (const p of Object.values(this.P)) gl.deleteProgram(p.program);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.pointVbo);
    gl.deleteTexture(this.blank);
  }

  // ---------------------------------------------------------------- internals

  private makeStarVao(vbo: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('createVertexArray failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  private buildTargets(): void {
    const gl = this.gl;
    for (const t of [this.hdr, this.copy, this.flare, this.mb, ...this.bloom]) if (t) destroyTarget(gl, t);
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    const W = Math.max(2, Math.round(cw * this.scale));
    const H = Math.max(2, Math.round(ch * this.scale));
    this.hdr = createTarget(gl, W, H, gl.RGBA16F, { depthTexture: true, mips: true });
    this.copy = createTarget(gl, W, H, gl.RGBA16F);
    // Size of the image the post chain works on: canvas resolution once temporal upscaling reconstructs it.
    const FW = this.temporal ? cw : W;
    const FH = this.temporal ? ch : H;
    if (this.temporal && (this.hist.length !== 2 || (this.hist[0] as Target).w !== cw || (this.hist[0] as Target).h !== ch)) {
      for (const t of this.hist) destroyTarget(gl, t);
      this.hist = [createTarget(gl, cw, ch, gl.RGBA16F, { mips: true }), createTarget(gl, cw, ch, gl.RGBA16F, { mips: true })];
      this.histValid = false;
    }
    this.mb = this.mbShutter > 0 ? createTarget(gl, FW, FH, gl.RGBA16F, { mips: true }) : null;
    this.bloom = [];
    let w = FW >> 1;
    let h = FH >> 1;
    for (let i = 0; i < 6 && w >= 4 && h >= 4; i++) {
      this.bloom.push(createTarget(gl, w, h, gl.RGBA16F));
      w >>= 1;
      h >>= 1;
    }
    const q = this.bloom[1];
    this.flare = q && this.flareK > 0 ? createTarget(gl, q.w, q.h, gl.RGBA16F) : null;
  }

  private autoScale(dt: number): void {
    if (!this.dynamic) return;
    this.ema += (dt - this.ema) * 0.05;
    this.dynTick++;
    if (this.dynTick < 45) return;
    let s = this.scale;
    if (this.ema > 1 / 48) s -= 0.1;
    else if (this.ema < 1 / 58 && this.dynTick > 300) s += 0.05;
    s = clamp(s, 0.90, 1); // never drop below 75 %: close-up surfaces and rings turn visibly soft below that
    if (Math.abs(s - this.scale) > 1e-3) {
      this.scale = s;
      this.buildTargets();
      this.dynTick = 0;
    }
  }

  private pushPoint(x: number, y: number, z: number, lum: number, temp: number): void {
    if ((this.np + 1) * 5 > this.points.length) {
      const n = new Float32Array(this.points.length * 2);
      n.set(this.points);
      this.points = n;
    }
    const o = this.np * 5;
    this.points[o] = x;
    this.points[o + 1] = y;
    this.points[o + 2] = z;
    this.points[o + 3] = lum;
    this.points[o + 4] = temp;
    this.np++;
  }

  private bindTex(unit: number, tex: WebGLTexture | null | undefined): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex ?? this.blank);
  }

  /** Bind a program and upload the per-frame uniforms once per frame. */
  private use(p: Prog): void {
    this.gl.useProgram(p.program);
    if (p.frame === this.frame) return;
    p.frame = this.frame;
    const f = this.fu;
    p.v('uCamRight', f.right);
    p.v('uCamUp', f.up);
    p.v('uCamFwd', f.fwd);
    p.f('uTanHalf', f.tanX, f.tanY);
    p.f('uRes', f.w, f.h);
    p.f('uPixelSr', f.sr);
    p.f('uTime', f.time);
    p.f('uFrame', this.frame % 1024);
    p.f('uJitter', f.jx, f.jy);
    p.v('uPrevRight', f.pRight);
    p.v('uPrevUp', f.pUp);
    p.v('uPrevFwd', f.pFwd);
    p.f('uPrevTan', f.ptx, f.pty);
    p.f('uPrevRel', f.drx, f.dry, f.drz);
    p.f('uMB', this.mbShutter, f.mbOn ? 1 : 0, f.maxPx, 0);
    p.f('uSky', this.sky.mapScale, this.sky.cmbScale, this.sky.map ? 1 : 0, this.sky.cmb ? 1 : 0);
    p.i('uExp', 7);
    p.i('uMapTex', 5);
    p.i('uCmbTex', 6);
    p.i('uScene', 8);
    p.i('uAlbedo', 0);
    p.i('uNight', 1);
    p.i('uClouds', 2);
    p.i('uMask', 3);
    p.i('uHeight', 4);
    p.i('uRingTex', 9);
    p.i('uFlare', 10);
  }

  private grabScene(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdr.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copy.fbo);
    gl.blitFramebuffer(0, 0, this.hdr.w, this.hdr.h, 0, 0, this.hdr.w, this.hdr.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo);
    this.bindTex(8, this.copy.tex);
  }

  private sunUniforms(p: Prog, pos: WorldPos, sun: Scene['sun']): void {
    if (!sun) {
      p.f('uSun', 0, 1, 0, 0);
      p.f('uSunT', 5772);
      p.f('uSunAng', 0.0046);
      return;
    }
    deltaInto(this.t3, 0, sun.pos, pos);
    const dx = this.t3[0] as number;
    const dy = this.t3[1] as number;
    const dz = this.t3[2] as number;
    const d = Math.hypot(dx, dy, dz) || 1;
    const r = AU / d;
    p.f('uSun', dx / d, dy / d, dz / d, sun.lum * r * r);
    p.f('uSunT', sun.temp);
    p.f('uSunAng', Math.asin(clamp(sun.radius / d, 0, 1)));
  }

  /** Bind program + all uniforms for one impostor. */
  private setup(im: Imp, scene: Scene, cam: Camera, bodies: BodyObj[]): { opaque: boolean; grab: boolean } {
    const o = im.o;
    const P = this.P;
    const p = (
      { glow: P.glow, galaxy: P.galaxy, nebula: P.nebula, star: P.surface, body: P.body, ring: P.ring, compact: P.compact, wormhole: P.wormhole, pulsar: P.pulsar } as Record<
        SceneObject['kind'],
        Prog
      >
    )[o.kind];
    this.use(p);

    const unit = o.radius;
    const d = im.d;
    const dir: Vec3 = [im.rx / d, im.ry / d, im.rz / d];
    const ref = Math.abs(dot(dir, cam.up)) < 0.9 ? cam.up : cam.right;
    const t1 = norm(cross(dir, ref));
    const t2 = cross(dir, t1);
    const inside = d <= im.ext * 1.05;
    const tanR = inside ? 0 : im.ext / Math.sqrt(d * d - im.ext * im.ext);
    p.f('uCenterR', im.rx / unit, im.ry / unit, im.rz / unit);
    p.f('uRad', unit);
    p.v('uDir', dir);
    p.v('uT1', t1);
    p.v('uT2', t2);
    p.f('uTanR', tanR * 1.05);
    p.f('uFull', inside || tanR > 2.5 ? 1 : 0);
    const ext = extentOf(o);

    switch (o.kind) {
      case 'glow': {
        const a = o.axis ?? [0, 0, 0];
        p.f('uAxisR', a[0] / unit, a[1] / unit, a[2] / unit);
        p.v('uColor', o.color);
        p.f('uSeed', o.seed ?? 0);
        return { opaque: false, grab: false };
      }
      case 'galaxy': {
        p.v('uNormal', o.normal);
        p.f('uType', o.type === 'spiral' ? 0 : o.type === 'elliptical' ? 1 : 2);
        p.f('uArms', o.arms ?? 2);
        p.f('uPitch', o.pitch ?? 0.35);
        p.f('uBulge', o.bulge ?? 0.6);
        p.f('uFlat', o.flat ?? (o.type === 'elliptical' ? 0.7 : 0.04));
        p.f('uSeed', o.seed ?? 0);
        p.v('uColor', o.color);
        return { opaque: false, grab: false };
      }
      case 'nebula': {
        p.v('uColor', o.color);
        p.v('uColor2', o.color2 ?? o.color);
        p.f('uDensity', o.density ?? 1);
        p.f('uNoise', o.noise ?? 1);
        p.f('uSeed', o.seed ?? 0);
        return { opaque: false, grab: false };
      }
      case 'star': {
        p.f('uTemp', o.temp);
        p.v('uSpin', o.spin ?? [0, 1, 0]);
        p.f('uSpots', o.spots ?? 0.5);
        p.f('uCell', o.cell ?? 14);
        p.f('uSeed', o.seed ?? 0);
        const st = o.tex ?? {};
        this.bindTex(0, st.albedo);
        this.bindTex(10, st.flare);
        p.f('uHasAlbedo', st.albedo ? 1 : 0);
        p.f('uHasFlare', st.flare ? 1 : 0);
        const act = clamp(o.activity ?? 0, 0, 1);
        p.f('uAct', act);
        if (act > 0) {
          starLoops(o, scene.time, this.loops);
          p.v4('uLoops', this.loops);
        }
        return { opaque: true, grab: false };
      }
      case 'body': {
        const R = o.radius;
        const t = o.tex ?? {};
        this.sunUniforms(p, o.pos, scene.sun);
        this.bindTex(0, t.albedo);
        this.bindTex(1, t.night);
        this.bindTex(2, t.clouds);
        this.bindTex(3, t.mask);
        this.bindTex(4, t.height);
        p.f('uHasAlbedo', t.albedo ? 1 : 0);
        p.f('uFlow', o.flow ?? 0);
        p.f('uStorm', o.storm ?? 0);
        const vx = o.vortex;
        p.f('uVortex', vx ? vx[0] : 0, vx ? vx[1] : 0, vx ? vx[2] : 0.1, vx ? vx[3] : 0);
        p.f('uHas', t.night ? 1 : 0, t.clouds ? 1 : 0, t.mask ? 1 : 0, t.height ? 1 : 0);
        p.v('uTint', o.tint ?? [0.5, 0.5, 0.5]);
        p.f('uNightScale', o.nightScale ?? 2e-6);
        p.f('uBump', t.height && o.bump ? o.bump / R : 0);
        p.f('uDetail', o.detail?.albedo ?? 0, o.detail?.relief ?? 0, o.detail?.bands ?? 1, 0);
        p.v('uSpin', o.spin);
        p.f('uRot', o.rot);
        const A = o.atmosphere;
        p.f('uAtmH', A ? A.height / R : 0);
        p.v('uBetaR', A ? [A.betaR[0] * R, A.betaR[1] * R, A.betaR[2] * R] : [0, 0, 0]);
        p.f('uBetaM', A ? A.betaM * R : 0);
        p.f('uHR', A ? A.hR / R : 1);
        p.f('uHM', A ? A.hM / R : 1);
        p.f('uG', A ? A.g : 0);
        // eclipse occluders: the 4 bodies subtending the largest angle as seen from this one
        this.occ.fill(0);
        const cand: { x: number; y: number; z: number; r: number; k: number }[] = [];
        for (const b of bodies) {
          if (b === o) continue;
          deltaInto(this.t3, 0, b.pos, o.pos);
          const x = this.t3[0] as number;
          const y = this.t3[1] as number;
          const z = this.t3[2] as number;
          cand.push({ x, y, z, r: b.radius, k: Math.hypot(x, y, z) / b.radius });
        }
        cand.sort((a, b) => a.k - b.k);
        for (let i = 0; i < Math.min(4, cand.length); i++) {
          const c = cand[i];
          if (c) this.occ.set([c.x / R, c.y / R, c.z / R, c.r / R], i * 4);
        }
        p.v4('uOcc', this.occ);
        return { opaque: true, grab: false };
      }
      case 'ring': {
        this.sunUniforms(p, o.pos, scene.sun);
        this.bindTex(9, o.tex);
        p.f('uHasRing', o.tex ? 1 : 0);
        p.v('uNormal', o.normal);
        p.f('uIn', o.inner);
        p.f('uOut', o.outer);
        // Exact camera position in the ring plane, from doubles: height above the plane, plus the in-plane position split into
        // whole 4096 m cells and a remainder, so the shader's particle lattice stays pinned to the rings down to centimetres.
        const rn = norm(o.normal);
        const re1 = norm(cross(rn, Math.abs(rn[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
        const re2 = cross(rn, re1);
        const cx = -(im.rx * re1[0] + im.ry * re1[1] + im.rz * re1[2]);
        const cy = -(im.rx * re2[0] + im.ry * re2[1] + im.rz * re2[2]);
        const ox = Math.floor(cx / 4096);
        const oy = Math.floor(cy / 4096);
        p.f('uRingH', -(im.rx * rn[0] + im.ry * rn[1] + im.rz * rn[2]));
        p.v('uRingE1', re1);
        p.v('uRingE2', re2);
        p.f('uRingO', ox, oy);
        p.f('uRingF', cx - ox * 4096, cy - oy * 4096);
        return { opaque: true, grab: false };
      }
      case 'compact': {
        p.v('uSpin', o.spin ?? [0, 1, 0]);
        p.f('uA', clamp(o.a ?? 0, 0, 0.998));
        p.f('uExtent', ext);
        const dk = o.disk;
        p.f('uDisk', dk?.inner ?? 0, dk?.outer ?? 0, dk?.temp ?? 0, dk ? dk.alpha ?? 0.7 : 0);
        p.f('uSurf', o.surface?.radius ?? 0, o.surface?.temp ?? 0, 0, 0);
        p.v('uGlow', o.glow ?? [0, 0, 0]);
        const j = o.jet;
        p.f('uJet', j?.intensity ?? 0, Math.max(j?.length ?? 1, 1e-3), j?.width ?? 0.1, j ? 1 : 0);
        p.v('uJetColor', j?.color ?? [1, 1, 1]);
        return { opaque: true, grab: true };
      }
      case 'wormhole': {
        p.f('uExtent', ext);
        p.v('uOther', o.otherTint ?? [0.6, 0.8, 1.2]);
        return { opaque: true, grab: true };
      }
      case 'pulsar': {
        p.v('uSpin', o.spin);
        p.f('uTilt', o.tilt);
        p.f('uPeriod', o.period);
        p.v('uColor', o.color);
        p.f('uSharp', o.sharp ?? 250);
        p.f('uPhase', o.phase ?? 0);
        return { opaque: false, grab: false };
      }
    }
  }

  /** Dipole field lines of a pulsar: one instanced ribbon per segment, geometry generated in the vertex shader. */
  private drawField(im: Imp, o: PulsarObj): void {
    const gl = this.gl;
    const p = this.P.field;
    this.use(p);
    const unit = o.radius;
    p.f('uCenterR', im.rx / unit, im.ry / unit, im.rz / unit);
    p.f('uRad', unit);
    p.v('uSpin', o.spin);
    p.f('uTilt', o.tilt);
    p.f('uPeriod', o.period);
    p.f('uPhase', o.phase ?? 0);
    p.v('uColor', o.color);
    p.f('uField', o.field ?? 1);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, S.FIELD_INSTANCES);
  }

  /** Camera + previous camera uniforms for the full-screen reprojection passes. */
  private setReproj(p: Prog): void {
    const f = this.fu;
    p.v('uCamRight', f.right);
    p.v('uCamUp', f.up);
    p.v('uCamFwd', f.fwd);
    p.f('uTanHalf', f.tanX, f.tanY);
    p.v('uPrevRight', f.pRight);
    p.v('uPrevUp', f.pUp);
    p.v('uPrevFwd', f.pFwd);
    p.f('uPrevTan', f.ptx, f.pty);
    p.f('uPrevRel', f.drx, f.dry, f.drz);
  }

  /** Temporal upscale: jittered internal-res frame + reprojected history -> canvas-res frame. */
  private resolve(): Target {
    const gl = this.gl;
    const p = this.P.taau;
    const dst = this.hist[this.histIdx] as Target;
    const src = this.hist[1 - this.histIdx] as Target;
    this.target(dst);
    gl.useProgram(p.program);
    this.bindTex(0, this.hdr.tex);
    this.bindTex(1, this.hdr.depthTex);
    this.bindTex(2, src.tex);
    this.bindTex(3, (this.expo[this.expIdx] as Target).tex);
    this.bindTex(4, (this.expo[1 - this.expIdx] as Target).tex);
    p.i('uCur', 0);
    p.i('uDepth', 1);
    p.i('uHist', 2);
    p.i('uExpCur', 3);
    p.i('uExpPrev', 4);
    p.f('uInRes', this.hdr.w, this.hdr.h);
    p.f('uOutRes', dst.w, dst.h);
    p.f('uJitterPx', this.fu.jpx, this.fu.jpy);
    p.f('uAlpha', this.alphaTaa);
    p.f('uReset', this.histValid ? 0 : 1);
    this.setReproj(p);
    this.tri();
    this.histIdx = 1 - this.histIdx;
    this.histValid = true;
    return dst;
  }

  /** Camera motion blur from depth reprojection. */
  private blur(src: Target, out: Target): Target {
    const gl = this.gl;
    const p = this.P.blur;
    this.target(out);
    gl.useProgram(p.program);
    this.bindTex(0, src.tex);
    this.bindTex(1, this.hdr.depthTex);
    p.i('uImg', 0);
    p.i('uDepth', 1);
    p.f('uRes', out.w, out.h);
    p.f('uMBp', this.mbShutter, 0.06 * out.h);
    p.f('uFrameN', this.frame % 64);
    p.v4('uSmA', this.smearA);
    p.v4('uSmB', this.smearB);
    this.setReproj(p);
    this.tri();
    return out;
  }

  private target(t: Target): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fbo);
    this.gl.viewport(0, 0, t.w, t.h);
  }

  private tri(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private post(dt: number): void {
    const gl = this.gl;
    const P = this.P;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(false);
    gl.bindVertexArray(this.emptyVao);

    // temporal upscale, then motion blur; `img` is the final HDR image everything below works on
    let img: Target = this.hdr;
    if (this.temporal) img = this.resolve();
    if (this.mb && this.fu.mbOn) img = this.blur(img, this.mb);

    // metering: mip chain of the HDR image -> 64x64 log-luminance -> mips
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // never mip-map a texture that is attached to the bound framebuffer
    this.bindTex(0, img.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.target(this.lum);
    gl.useProgram(P.lum.program);
    P.lum.i('uHdr', 0);
    this.tri();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bindTex(0, this.lum.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // bloom: dual-filter down chain
    const B = this.bloom;
    gl.useProgram(P.down.program);
    P.down.i('uTex', 0);
    for (let i = 0; i < B.length; i++) {
      const src = i === 0 ? img : (B[i - 1] as Target);
      this.bindTex(0, src.tex);
      this.target(B[i] as Target);
      P.down.f('uTexel', 1 / src.w, 1 / src.h);
      P.down.f('uClamp', i === 0 ? 1 : 0);
      this.tri();
    }
    // lens-flare ghosts from the quarter-res level (before the up chain smears it)
    const flareOn = this.flare !== null && B.length >= 2;
    if (this.flare && flareOn) {
      this.target(this.flare);
      gl.useProgram(P.flare.program);
      this.bindTex(0, (B[1] as Target).tex);
      P.flare.i('uSrc', 0);
      P.flare.f('uStrength', this.flareK * 0.0014);
      this.tri();
    }
    // bloom: additive up chain
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(P.up.program);
    P.up.i('uTex', 0);
    for (let i = B.length - 1; i > 0; i--) {
      const src = B[i] as Target;
      this.bindTex(0, src.tex);
      this.target(B[i - 1] as Target);
      P.up.f('uHalf', 0.5 / src.w, 0.5 / src.h);
      this.tri();
    }
    gl.disable(gl.BLEND);

    // auto-exposure, entirely on the GPU (ping-pong 1x1 R32F)
    const cur = this.expo[this.expIdx] as Target;
    const nxt = this.expo[1 - this.expIdx] as Target;
    const ex = this.ex;
    this.target(nxt);
    gl.useProgram(P.adapt.program);
    this.bindTex(0, this.lum.tex);
    this.bindTex(1, cur.tex);
    P.adapt.i('uLum', 0);
    P.adapt.i('uPrev', 1);
    P.adapt.f('uKey', ex.key);
    P.adapt.f('uBias', ex.auto ? ex.bias : 1);
    P.adapt.f('uMin', ex.auto ? ex.min : ex.manual);
    P.adapt.f('uMax', ex.auto ? ex.max : ex.manual);
    P.adapt.f('uK', ex.auto ? 1 - Math.exp(-Math.max(dt, 0) / Math.max(ex.tau, 1e-3)) : 1);
    P.adapt.f('uTop', 6);
    this.tri();
    this.expIdx = 1 - this.expIdx;

    // tone map to the canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(P.tone.program);
    this.bindTex(0, img.tex);
    this.bindTex(1, B[0]?.tex);
    this.bindTex(2, flareOn ? this.flare?.tex : this.blank);
    P.tone.i('uHdr', 0);
    P.tone.i('uBloom', 1);
    P.tone.i('uFlare', 2);
    P.tone.f('uBloomK', this.bloomK);
    P.tone.f('uFlareK', flareOn ? 1 : 0);
    this.tri();
  }
}
