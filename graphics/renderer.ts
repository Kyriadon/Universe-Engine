/**
 * graphics/renderer.ts
 *
 * The central rendering orchestrator of the engine. It compiles the programs from
 * shaders.ts, owns every GPU resource it needs (HDR targets, bloom chain, depth,
 * VAOs, VBOs), draws the scene far to near and writes the final image to the canvas.
 *
 *   const renderer = createRenderer();
 *   createGL((frame) => renderer.render(frame, scene), {
 *     onContextRestored: (gl) => renderer.restore(gl),
 *   });
 *
 * What it uses from the repo
 *   gl.ts        FrameInfo only: camera basis and WorldPos, size, resized, time, dt, simSpeed,
 *                paused, resolutionScale, workload. No second camera, no input handling, and no
 *                rendering logic leaves this file.
 *   coords.ts    deltaInto() turns every WorldPos into a camera-relative float64 vector first.
 *                Only those small vectors reach the GPU, so no absolute coordinate is ever sent
 *                as a float. Star fields keep float64 offsets from one anchor and add a single
 *                deltaInto(anchor, camera) per frame.
 *   shaders.ts   SHADERS (sources and blend/depth/readsScene metadata) and ATTRIBUTES. The
 *                metadata drives GL state: blend from `blend`, depth test+write from
 *                `writesDepth`, the ping-pong path from `readsScene`.
 *   physics.ts   PlasmaDisk: the accretion-disk plasma texture the blackhole shader samples
 *                (uPlasma, uPlasmaMix, uPlasmaSize). One PlasmaDisk per black hole that has a
 *                disk, created on first draw, built on the CPU in small per-frame time slices
 *                (plasmaBudgetMs), rotated per frame in the shader (uPlasmaAge), uploaded on unit 2. Until its first
 *                build finishes the disk is drawn with the flat procedural look (uPlasmaMix 0).
 *
 * Draw order (shaders.ts header)
 *   background, cosmicWeb, galaxies, nebulae, stars, pulsars, then black holes and planet
 *   stacks merged and sorted far to near (planet, rings, clouds, atmosphere, aurora per
 *   planet), then bloom, then tonemap to the canvas. A black hole lenses everything drawn
 *   before it, so bodies farther than a black hole are drawn first.
 *
 * Black hole ping-pong
 *   The blackhole program reads uSceneColor and writes a full frame. It reads scene[cur] and
 *   writes scene[1 - cur]; the two never alias (asserted before every sampling draw), the
 *   depth buffer is a renderbuffer shared by both framebuffers, and unit 0 is unbound after.
 *   For the pass uSceneColor (unit 0) gets a mip chain (generateMipmap, then plain LINEAR again),
 *   uHistory (unit 1) is a private copy of this pass's previous output (only the first black
 *   hole of a frame uses it, and only while the camera has not translated), and the plasma
 *   texture is on unit 2. All three units are unbound after the pass.
 *
 * Exposure
 *   Every scene pass multiplies by uExposure (pre-exposure, settings.exposure). Artistic gains
 *   are expressed display-referred (settings.cmb.level, settings.cosmicWeb.level,
 *   settings.blackHole.peakLevel): the renderer divides by exposure so they look the same at
 *   any exposure. Physical inputs (star luminosity, illuminants, planet palettes) are passed
 *   through unchanged. Tonemap applies postExposure, bloom, vignette, ACES, sRGB and dither
 *   itself, so the canvas receives display-ready values.
 *
 * Mutating a scene: pass a new object, or bump scene.revision (idle frames are reused while
 * the sim is paused and nothing changed; a new object or revision forces a redraw).
 */

import { CELL_SIZE_M, Tier, deltaInto, type Vec3, type WorldPos } from '../packages/core/src/coords';
import type { FrameInfo } from './gl';
import { ATTRIBUTES, SHADERS, type ShaderName, type ShaderSource } from './shaders';
import { PlasmaDisk } from '../physics/physics';

// ---------------------------------------------------------------------------
// Public types: settings
// ---------------------------------------------------------------------------

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export type ScenePass =
  | 'background'
  | 'cosmicWeb'
  | 'galaxy'
  | 'nebula'
  | 'stars'
  | 'pulsar'
  | 'blackhole'
  | 'planet'
  | 'rings'
  | 'clouds'
  | 'atmosphere'
  | 'aurora'
  | 'bloom';

export interface RendererSettings {
  quality: QualityPreset;
  /** FrameInfo carries no field of view, so the renderer owns it (vertical, degrees). */
  verticalFovDeg: number;
  /** Pre-exposure written into uExposure of every scene pass. */
  exposure: number;
  /** uPostExposure of the tonemap pass. */
  postExposure: number;
  /** uVignette of the tonemap pass (0 = off). */
  vignette: number;
  /** uDepthRange: near and far in metres for the reversed logarithmic depth. */
  depthRange: readonly [number, number];
  /** Shed raymarch steps when the GPU is the bottleneck at minimum resolution. */
  adaptiveWork: boolean;
  /** A pulsar whose apparent rotation exceeds this rate (Hz) is drawn at a fixed phase. */
  maxFlashHz: number;
  /** Log the pass coverage and the missing dependencies once, on the first frame. */
  logCoverage: boolean;
  passes: Record<ScenePass, boolean>;
  /** Display-referred artistic gains for the CMB (the real CMB is invisible). */
  cmb: { temperatureK: number; level: number; contrast: number };
  /** Cosmic web. Sizes are in metres or in cells of cellSizeM. level is display-referred. */
  cosmicWeb: {
    cellSizeM: number;
    minDistCells: number;
    maxDistCells: number;
    filament: number;
    level: number;
  };
  stars: { psfSigmaPx: number; pointSizeMax: number; spikeStrength: number; maxPerField: number };
  /**
   * peakLevel: display-referred brightness of the hottest disk pixel when a disk has no gain.
   * samples: integer 1..8 supersamples per pixel (uSamples).
   * maxFootprintPx: largest lensed-background footprint in pixels before it is mip-filtered
   *   (uMaxFootprint); 0 switches the mip chain off.
   * temporalBlend: 0..0.95 weight of the previous frame (uTemporalBlend) while the camera moves, 0 = off.
   *   It fades out smoothly with camera translation, and rises towards 0.9 (less at high simulation
   *   speed) while the camera is still, so the sub-pixel jitter (uJitter) converges instead of shimmering.
   * plasmaMix: 0..1, 0 = flat procedural disk, 1 = full PlasmaDisk texture (uPlasmaMix).
   * plasmaSize: PlasmaDisk texels per side (a bigger texture is sharper but takes longer to rebuild).
   * plasmaBudgetMs: CPU milliseconds per frame spent building the plasma texture. A rebuild is spread over
   *   frames, so this trades how often the texture refreshes (matters at high simulation speed) for frame time.
   */
  blackHole: {
    peakLevel: number;
    samples: number;
    maxFootprintPx: number;
    temporalBlend: number;
    plasmaMix: number;
    plasmaSize: number;
    plasmaBudgetMs: number;
  };
  bloom: { strength: number; radius: number; weight: number; levels: number };
  /** Base raymarch steps at 'medium' quality and full work; clamped to each shader's maximum. */
  steps: {
    galaxy: number;
    nebula: number;
    clouds: number;
    pulsar: number;
    cosmicWeb: number;
    blackHole: number;
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type RendererSettingsPatch = DeepPartial<RendererSettings>;

export interface RendererOptions {
  readonly settings?: RendererSettingsPatch;
}

// ---------------------------------------------------------------------------
// Public types: scene descriptors (one per shader family, 1:1 with its uniforms)
// ---------------------------------------------------------------------------

/** Column-major 3x3, local to world (the uRot of the planet shader). */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** A star lighting a body: inverse-square irradiance with this colour. */
export interface Illuminant {
  readonly position: WorldPos;
  readonly luminosityW: number;
  /** Linear sRGB with the largest component 1 (the convention of blackbodyColor in the shaders). */
  readonly color: Vec3;
}

/** Point-sprite stars. Build it with createStarField(). */
export interface StarField {
  readonly anchor: WorldPos;
  readonly count: number;
  /** x, y, z in metres relative to the anchor, 3 * count float64 values. */
  readonly offsetsM: Float64Array;
  readonly luminosityW: ArrayLike<number>;
  readonly temperatureK: ArrayLike<number>;
  readonly radiusM: ArrayLike<number>;
  /** Bump when any array changes after the first frame. */
  readonly revision?: number;
}

export interface BlackHoleDisk {
  /** Peak disk temperature in K (uDiskTemperature). */
  readonly peakTemperatureK: number;
  /** Inner radius in Rg; omit or <= 0 for the spin-dependent ISCO. */
  readonly innerRg?: number;
  readonly outerRg?: number;
  /** H/r. */
  readonly heightRatio?: number;
  readonly opacity?: number;
  /** uDiskGain as given; omit to normalise the peak to settings.blackHole.peakLevel. */
  readonly gain?: number;
  /** uDiskVisTemp: hottest displayed colour in K. Omit for BLACK_HOLE_DEFAULTS.visTempK. */
  readonly visTempK?: number;
}

/** Bipolar relativistic jets along the spin axis (uJetGain, uJetLengthRg, uJetWidth). */
export interface BlackHoleJet {
  /** Display-referred brightness; the renderer divides by exposure. 0 or less: no jets. */
  readonly gain: number;
  /** Jet length in Rg. */
  readonly lengthRg: number;
  /** Jet width at the base in Rg. */
  readonly widthRg: number;
}

/** A solid surface instead of a horizon: neutron star (radiusRg > 2) or gravastar. */
export interface CompactSurface {
  readonly radiusRg: number;
  readonly temperatureK: number;
}

export interface BlackHoleBody {
  readonly position: WorldPos;
  /** GM/c^2 in metres. */
  readonly rgM: number;
  /** a/(GM/c), clamped to 0..0.998 by the shader. */
  readonly spin: number;
  /** World-space spin axis; defaults to +Y when the data has none. */
  readonly spinAxis?: Vec3;
  readonly boundRg?: number;
  /** Omitted or null: no accretion disk. */
  readonly disk?: BlackHoleDisk | null;
  /** Omitted or null: no jets. */
  readonly jet?: BlackHoleJet | null;
  readonly surface?: CompactSurface;
}

export interface GalaxyBody {
  readonly position: WorldPos;
  readonly radiusM: number;
  readonly normal?: Vec3;
  readonly arms: number;
  /** tan of the pitch angle, default 0.25. */
  readonly pitch?: number;
  readonly phase?: number;
  /** Disk height / radius, default 0.015. */
  readonly thickness?: number;
  readonly brightness: number;
  readonly dustGain: number;
  readonly seed: number;
  readonly octaves?: number;
  readonly bulgeColor: Vec3;
  readonly diskColor: Vec3;
  readonly youngColor: Vec3;
}

export interface NebulaBody {
  readonly position: WorldPos;
  readonly radiusM: number;
  readonly seed: number;
  readonly density: number;
  readonly emissionGain: number;
  readonly colorOiii: Vec3;
  readonly colorHa: Vec3;
  readonly colorSii: Vec3;
  readonly scatterColor: Vec3;
  readonly starLight: Vec3;
  readonly octaves?: number;
}

export interface PulsarBody {
  readonly position: WorldPos;
  readonly spinAxis?: Vec3;
  readonly tiltRad: number;
  readonly periodS: number;
  readonly beamHalfAngleRad: number;
  readonly beamLengthM: number;
  readonly radiusM: number;
  readonly temperatureK: number;
  readonly beamRadiance: number;
}

export interface CloudLayer {
  readonly bottomM: number;
  readonly topM: number;
  readonly scaleM: number;
  readonly coverage: number;
  readonly densityPerM: number;
  readonly driftPerS: Vec3;
}

export interface AuroraLayer {
  readonly magneticAxis: Vec3;
  readonly strength: number;
  readonly ovalRad: number;
  readonly bottomM: number;
  readonly topM: number;
}

/** Clouds and aurora use the atmosphere uniforms, so they live inside it. */
export interface AtmosphereLayer {
  readonly heightM: number;
  readonly betaR: Vec3;
  readonly betaM: number;
  readonly scaleHeightRM: number;
  readonly scaleHeightMM: number;
  readonly mieG: number;
  readonly clouds?: CloudLayer;
  readonly aurora?: AuroraLayer;
}

export interface RingSystem {
  readonly normal: Vec3;
  readonly innerM: number;
  readonly outerM: number;
  readonly opacity: number;
  readonly colorA: Vec3;
  readonly colorB: Vec3;
  readonly seed: number;
}

export type PlanetSurface =
  | {
      readonly kind: 'ocean';
      readonly seed: number;
      readonly octaves: number;
      readonly seaLevel: number;
      readonly ice: number;
      readonly bump: number;
      /** The planet shader's own 2D cloud cover (0..1). */
      readonly cloudCover: number;
      readonly paletteLow: Vec3;
      readonly paletteHigh: Vec3;
      readonly oceanShallow: Vec3;
      readonly oceanDeep: Vec3;
    }
  | {
      readonly kind: 'gas';
      readonly seed: number;
      readonly octaves: number;
      readonly wind: number;
      readonly bandFreq: number;
      readonly bandA: Vec3;
      readonly bandB: Vec3;
      readonly bandC: Vec3;
      readonly storm: Vec3;
    }
  | {
      readonly kind: 'airless';
      readonly seed: number;
      readonly octaves: number;
      readonly ice: number;
      readonly bump: number;
      readonly paletteLow: Vec3;
      readonly paletteHigh: Vec3;
    };

/** Planets and moons. */
export interface PlanetBody {
  readonly position: WorldPos;
  readonly radiusM: number;
  /** Local to world, column-major; identity when omitted. */
  readonly rotation?: Mat3;
  readonly surface: PlanetSurface;
  /** Omitted: unlit (black), as for a rogue planet. */
  readonly illuminant?: Illuminant;
  readonly atmosphere?: AtmosphereLayer;
  readonly rings?: RingSystem;
}

export interface RenderScene {
  /** Bump when the scene is mutated in place. */
  readonly revision?: number;
  readonly starFields?: readonly StarField[];
  readonly galaxies?: readonly GalaxyBody[];
  readonly nebulae?: readonly NebulaBody[];
  readonly pulsars?: readonly PulsarBody[];
  readonly blackHoles?: readonly BlackHoleBody[];
  readonly planets?: readonly PlanetBody[];
}

// ---------------------------------------------------------------------------
// Public types: renderer
// ---------------------------------------------------------------------------

export interface RenderStats {
  frame: number;
  /** Draw calls of the last rendered frame (0 extra scene calls on a reused idle frame). */
  drawCalls: number;
  passesDrawn: number;
  /** 0.35..1, multiplies the raymarch steps. */
  workScale: number;
  width: number;
  height: number;
  /** True when the last frame reused the previous HDR scene and only ran the tonemap. */
  reusedScene: boolean;
}

export interface PassReport {
  readonly pass: ScenePass;
  readonly status: 'ready' | 'disabled' | 'no-scene-data' | 'program-pending' | 'program-failed';
  readonly detail: string;
}

export interface Renderer {
  /** Draw one frame. The first call binds the renderer to frame.gl. */
  render(frame: FrameInfo, scene?: RenderScene): void;
  /** Rebuild every GPU resource after the context was lost and restored (lazy, next frame). */
  restore(gl?: WebGL2RenderingContext): void;
  /** Delete every GPU resource. The renderer is unusable afterwards. */
  dispose(): void;
  /** Merge a settings patch. */
  configure(patch: RendererSettingsPatch): void;
  readonly settings: Readonly<RendererSettings>;
  readonly stats: Readonly<RenderStats>;
  /** Which passes can draw for this scene, and why not. */
  coverage(scene?: RenderScene): readonly PassReport[];
}

export class RendererError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RendererError';
  }
}

/** Gaps in the repository that stop passes or fields from being fed. Logged once, never faked. */
export const MISSING_DEPENDENCIES: readonly string[] = [
  'gl.ts FrameInfo/Camera has no field of view: the renderer owns settings.verticalFovDeg (default 60).',
  'No scene data exists for stars, galaxies (the Milky Way has no radius/arms/colours), nebulae, pulsars, neutron stars, planets, moons, rings, atmospheres, clouds or auroras: only Sagittarius A* is defined under information/. Those passes are implemented and run as soon as a RenderScene supplies them.',
  'The black-hole data (sagittarius.ts) has a spin value but no spin axis or disk geometry: the renderer falls back to +Y and its documented disk defaults.',
  'There is no CPU blackbody-colour helper: Illuminant.color (and star colour via temperature on the GPU) must come from the data provider.',
  'shaders.ts order: a black hole only lenses what was drawn before it (everything farther away); the shader has no depth input.',
];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const PI = Math.PI;
const SIGMA_SB = 5.670374419e-8;
/** uTime is wrapped on the CPU (shaders.ts convention). */
const TIME_WRAP_S = 1e5;
/** BLACKHOLE_FS passes through every ray with impact parameter b > 4e4 Rg. */
const BH_LENS_LIMIT_RG = 4.0e4;
/** BACKGROUND_FS tints the CMB with this colour (largest component 1). */
const CMB_TINT: Vec3 = [0.62, 0.72, 1.0];
const WORK_MIN = 0.35;
/** gl.ts never goes below 80%; only then does the renderer start shedding work. */
const RES_FLOOR = 0.8001;
const SCISSOR_PAD = 2;
const STAR_EVICT_FRAMES = 300;
const PLASMA_EVICT_FRAMES = 300;
/** Budget per frame for the very first plasma build, so the disk gets its texture within a few frames. */
const PLASMA_FIRST_BUILD_MS = 30;
/** Largest age (R_g / c) the shader rotates a plasma texture by before the next build lands: beyond it the shear would out-resolve the texture. */
const PLASMA_MAX_AGE_RG = 60;
/** Disk flow cycle in R_g / c. MUST equal FLOW_CYCLE in the blackhole shader. */
const BH_FLOW_CYCLE_RG = 60;
const C_LIGHT = 299792458;
/** Texture units of the blackhole pass. */
const SCENE_UNIT = 0;
const HISTORY_UNIT = 1;
const PLASMA_UNIT = 2;

const ZERO3: Vec3 = [0, 0, 0];
const AXIS_Y: Vec3 = [0, 1, 0];
const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rendering defaults for black holes: look parameters, not data. Override per body. */
const BLACK_HOLE_DEFAULTS = {
  outerRg: 30,
  heightRatio: 0.1,
  opacity: 1.5,
  boundMinRg: 40,
  boundOverOuter: 1.25,
  /** The shader's own default for uDiskVisTemp. */
  visTempK: 12000,
} as const;

const QUALITY: Readonly<Record<QualityPreset, { readonly stepScale: number; readonly bloomLevels: number }>> = {
  low: { stepScale: 0.5, bloomLevels: 4 },
  medium: { stepScale: 1, bloomLevels: 5 },
  high: { stepScale: 1.5, bloomLevels: 6 },
  ultra: { stepScale: 2, bloomLevels: 7 },
};

/** Largest step counts the shaders accept (their clamp()s). */
const MAX_STEPS = { galaxy: 96, nebula: 128, clouds: 96, pulsar: 96, cosmicWeb: 64, blackHole: 320 } as const;

export const DEFAULT_RENDERER_SETTINGS: Readonly<RendererSettings> = {
  quality: 'medium',
  verticalFovDeg: 60,
  exposure: 1,
  postExposure: 1,
  vignette: 0.35,
  depthRange: [0.1, 1e27],
  adaptiveWork: true,
  maxFlashHz: 3,
  logCoverage: true,
  passes: {
    background: true,
    cosmicWeb: false,
    galaxy: true,
    nebula: true,
    stars: true,
    pulsar: true,
    blackhole: true,
    planet: true,
    rings: true,
    clouds: true,
    atmosphere: true,
    aurora: true,
    bloom: true,
  },
  // Genuinely black sky: the real CMB is invisible and the background pass draws no noise or stars. Raise level for a faint glow.
  cmb: { temperatureK: 2.725, level: 0, contrast: 0 },
  cosmicWeb: {
    cellSizeM: CELL_SIZE_M[Tier.Supercluster] as number,
    minDistCells: 0.25,
    maxDistCells: 100,
    filament: 0.12,
    level: 0.05,
  },
  stars: { psfSigmaPx: 0.9, pointSizeMax: 64, spikeStrength: 1, maxPerField: 1 << 20 },
  blackHole: {
    peakLevel: 8,
    samples: 1,
    maxFootprintPx: 16,
    temporalBlend: 0.6,
    plasmaMix: 1,
    plasmaSize: 256,
    plasmaBudgetMs: 3,
  },
  bloom: { strength: 0.06, radius: 1, weight: 0.65, levels: 6 },
  steps: { galaxy: 48, nebula: 64, clouds: 48, pulsar: 48, cosmicWeb: 32, blackHole: 256 },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeDeep<T extends object>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as unknown as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? mergeDeep(current, value) : value;
  }
  return out as unknown as T;
}

function validateSettings(s: RendererSettings): void {
  const bad = (what: string): never => {
    throw new RangeError(`renderer.ts: invalid setting: ${what}`);
  };
  if (!(s.verticalFovDeg > 1 && s.verticalFovDeg < 170)) bad('verticalFovDeg must be between 1 and 170');
  if (!(s.exposure > 0 && Number.isFinite(s.exposure))) bad('exposure must be a positive number');
  if (!(s.postExposure > 0 && Number.isFinite(s.postExposure))) bad('postExposure must be a positive number');
  if (!(s.vignette >= 0)) bad('vignette must be >= 0');
  if (!(s.depthRange[0] > 0 && s.depthRange[1] > s.depthRange[0])) bad('depthRange must satisfy 0 < near < far');
  if (!(s.cmb.temperatureK > 0)) bad('cmb.temperatureK must be positive');
  if (!(s.cmb.level >= 0)) bad('cmb.level must be >= 0');
  if (!(s.cosmicWeb.cellSizeM > 0)) bad('cosmicWeb.cellSizeM must be positive');
  if (!(s.cosmicWeb.minDistCells > 0 && s.cosmicWeb.maxDistCells > s.cosmicWeb.minDistCells)) {
    bad('cosmicWeb distances must satisfy 0 < minDistCells < maxDistCells');
  }
  if (!(s.stars.maxPerField >= 0)) bad('stars.maxPerField must be >= 0');
  if (!(s.maxFlashHz > 0)) bad('maxFlashHz must be positive');
  if (!(s.blackHole.peakLevel > 0)) bad('blackHole.peakLevel must be positive');
  if (!Number.isInteger(s.blackHole.samples) || s.blackHole.samples < 1 || s.blackHole.samples > 8) {
    bad('blackHole.samples must be an integer from 1 to 8');
  }
  if (!(s.blackHole.maxFootprintPx >= 0 && Number.isFinite(s.blackHole.maxFootprintPx))) {
    bad('blackHole.maxFootprintPx must be >= 0');
  }
  if (!(s.blackHole.temporalBlend >= 0 && s.blackHole.temporalBlend <= 0.95)) {
    bad('blackHole.temporalBlend must be between 0 and 0.95');
  }
  if (!(s.blackHole.plasmaMix >= 0 && s.blackHole.plasmaMix <= 1)) bad('blackHole.plasmaMix must be between 0 and 1');
  if (!Number.isInteger(s.blackHole.plasmaSize) || s.blackHole.plasmaSize < 8) {
    bad('blackHole.plasmaSize must be an integer >= 8');
  }
  if (!(s.blackHole.plasmaBudgetMs > 0 && Number.isFinite(s.blackHole.plasmaBudgetMs))) {
    bad('blackHole.plasmaBudgetMs must be positive');
  }
  if (!Number.isInteger(s.bloom.levels) || s.bloom.levels < 0) bad('bloom.levels must be a non-negative integer');
}

function unit(v: Vec3, fallback: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : fallback;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Halton sequence value in [0, 1) for index i >= 1 (sub-pixel jitter). */
function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= base;
    r += f * (n % base);
    n = Math.floor(n / base);
  }
  return r;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const extent = { lo: 0, hi: 0 };

/** Pixel range of a sphere along one image axis (exact tangent planes through the eye). */
function axisExtent(c: number, z: number, r: number, t: number, size: number): void {
  const phi = Math.atan2(c, z);
  const delta = Math.asin(Math.min(1, r / Math.hypot(c, z)));
  extent.lo = (Math.tan(phi - delta) / t * 0.5 + 0.5) * size;
  extent.hi = (Math.tan(phi + delta) / t * 0.5 + 0.5) * size;
}

/**
 * Conservative screen rectangle of a camera-space sphere (cx right, cy up, cz forward, metres).
 * False when it is certainly off screen. The rectangle is the full target when the eye is inside
 * the sphere or the sphere crosses the camera plane.
 */
function projectSphere(
  out: Rect,
  cx: number,
  cy: number,
  cz: number,
  r: number,
  tanX: number,
  tanY: number,
  width: number,
  height: number,
): boolean {
  if (cz + r <= 0) return false;
  let x0 = 0;
  let y0 = 0;
  let x1 = width;
  let y1 = height;
  if (cz - r > 0) {
    axisExtent(cx, cz, r, tanX, width);
    const ax0 = extent.lo;
    const ax1 = extent.hi;
    axisExtent(cy, cz, r, tanY, height);
    if (Number.isFinite(ax0) && Number.isFinite(ax1) && Number.isFinite(extent.lo) && Number.isFinite(extent.hi)) {
      x0 = Math.floor(ax0) - SCISSOR_PAD;
      x1 = Math.ceil(ax1) + SCISSOR_PAD;
      y0 = Math.floor(extent.lo) - SCISSOR_PAD;
      y1 = Math.ceil(extent.hi) + SCISSOR_PAD;
    }
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(width, x1);
  y1 = Math.min(height, y1);
  if (x1 <= x0 || y1 <= y0) return false;
  out.x = x0;
  out.y = y0;
  out.w = x1 - x0;
  out.h = y1 - y0;
  return true;
}

/** Exported for tests: the pixel rectangle of a sphere. */
export const _projectSphereForTests = projectSphere;

const UNIFORM_DECL = /^[ \t]*uniform\s+(?:(?:highp|mediump|lowp)\s+)?[A-Za-z_]\w*\s+([^;]+);/gm;

/** Every uniform name declared in the given GLSL sources. */
function declaredUniforms(...sources: readonly string[]): string[] {
  const names = new Set<string>();
  for (const source of sources) {
    for (const m of source.matchAll(UNIFORM_DECL)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/)[0];
        if (name !== undefined && name !== '') names.add(name);
      }
    }
  }
  return [...names];
}

/** A few numbered source lines around every line an ANGLE/driver log complains about. */
function shaderLogContext(source: string, log: string): string {
  const lines = source.split(/\r?\n/);
  const seen = new Set<number>();
  const out: string[] = [];
  for (const m of log.matchAll(/(?:ERROR|WARNING):\s*\d+:(\d+)/g)) {
    const ln = Number(m[1] ?? Number.NaN);
    if (!Number.isFinite(ln) || seen.has(ln)) continue;
    seen.add(ln);
    if (seen.size > 6) break;
    for (let i = Math.max(1, ln - 2); i <= Math.min(lines.length, ln + 2); i++) {
      out.push(`${i === ln ? '>' : ' '} ${String(i).padStart(4)} | ${lines[i - 1] ?? ''}`);
    }
    out.push('       ...');
  }
  return out.join('\n');
}

/**
 * Build a StarField from absolute positions. Offsets from the anchor are computed once, in
 * float64, with deltaInto (so mixed tiers are handled exactly). Per frame the renderer only
 * adds deltaInto(anchor, camera).
 */
export function createStarField(
  anchor: WorldPos,
  positions: readonly WorldPos[],
  luminosityW: ArrayLike<number>,
  temperatureK: ArrayLike<number>,
  radiusM: ArrayLike<number>,
): StarField {
  const count = positions.length;
  if (luminosityW.length < count || temperatureK.length < count || radiusM.length < count) {
    throw new RangeError('createStarField: luminosity, temperature and radius need one value per position');
  }
  const offsetsM = new Float64Array(count * 3);
  let i = 0;
  for (const p of positions) {
    deltaInto(offsetsM, i * 3, p, anchor);
    i += 1;
  }
  return { anchor, count, offsetsM, luminosityW, temperatureK, radiusM };
}

// ---------------------------------------------------------------------------
// Internal GPU types
// ---------------------------------------------------------------------------

type BlendMode = ShaderSource['blend'];

interface ProgramEntry {
  readonly name: ShaderName;
  readonly program: WebGLProgram;
  /** Every uniform declared in the GLSL; null when the driver optimised it out. */
  readonly uniforms: ReadonlyMap<string, WebGLUniformLocation | null>;
  cameraStamp: number;
}

interface CompilingSlot {
  readonly kind: 'compiling';
  readonly name: ShaderName;
  readonly source: ShaderSource;
  readonly program: WebGLProgram;
  readonly vs: WebGLShader;
  readonly fs: WebGLShader;
}
interface ReadySlot {
  readonly kind: 'ready';
  readonly entry: ProgramEntry;
}
interface FailedSlot {
  readonly kind: 'failed';
  readonly message: string;
}
type Slot = CompilingSlot | ReadySlot | FailedSlot;

interface ColorTarget {
  readonly tex: WebGLTexture;
  readonly fbo: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
}

interface TargetSet {
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  readonly depth: WebGLRenderbuffer;
  readonly scene: readonly [ColorTarget, ColorTarget];
  readonly down: readonly ColorTarget[];
  readonly up: readonly ColorTarget[];
}

interface GpuStars {
  readonly vaos: readonly [WebGLVertexArrayObject, WebGLVertexArrayObject];
  readonly pos: readonly [WebGLBuffer, WebGLBuffer];
  readonly attr: WebGLBuffer;
  capacity: number;
  uploaded: boolean;
  current: 0 | 1;
  staticRevision: number;
  staticCount: number;
  readonly lastRel: Float64Array;
  lastUsedFrame: number;
}

interface FrameConsts {
  stamp: number;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  tanX: number;
  tanY: number;
  width: number;
  height: number;
  time: number;
  simTime: number;
  simSpeed: number;
  paused: boolean;
  exposure: number;
  near: number;
  far: number;
  camPos: WorldPos;
}

interface Item {
  index: number;
  dist: number;
  /** Camera-relative centre in metres (float64). */
  x: number;
  y: number;
  z: number;
  /** Near list only: 0 black hole, 1 planet. */
  kind: number;
}

/** One PlasmaDisk per black hole, with the settings it was built for. */
interface PlasmaEntry {
  readonly plasma: PlasmaDisk;
  readonly spin: number;
  readonly outerRg: number;
  readonly innerRg: number;
  readonly size: number;
  /** Simulation seconds at the previous draw. */
  lastSim: number;
  lastUsedFrame: number;
}

/** The blackhole pass's previous output and what it was drawn with (for uHistory). */
interface BlackHoleHistory {
  target: ColorTarget | null;
  valid: boolean;
  body: BlackHoleBody | null;
  settingsRev: number;
  /** Consecutive frames the camera has been still (drives the blend boost). */
  still: number;
  /** Camera-relative centre of the hole in the frame that wrote the target. */
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  ux: number;
  uy: number;
  uz: number;
  fx: number;
  fy: number;
  fz: number;
  tanX: number;
  tanY: number;
}

const PROGRAMS_OF: Readonly<Record<ScenePass, readonly ShaderName[]>> = {
  background: ['background'],
  cosmicWeb: ['cosmicWeb'],
  galaxy: ['galaxy'],
  nebula: ['nebula'],
  stars: ['stars'],
  pulsar: ['pulsar'],
  blackhole: ['blackhole'],
  planet: ['planet'],
  rings: ['rings'],
  clouds: ['clouds'],
  atmosphere: ['atmosphere'],
  aurora: ['aurora'],
  bloom: ['bloomDown', 'bloomUp'],
};

const EMPTY_SCENE: RenderScene = {};

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export function createRenderer(options: RendererOptions = {}): Renderer {
  let settings: RendererSettings = mergeDeep(
    DEFAULT_RENDERER_SETTINGS as RendererSettings,
    options.settings ?? {},
  );
  validateSettings(settings);
  let settingsRevision = 0;

  let gl!: WebGL2RenderingContext;
  let bound = false;
  let disposed = false;
  let completionStatusEnum: number | null = null;
  let maxPointSize = 1;
  let maxTextureSize = 0;
  let coverageLogged = false;
  let frameIndex = 0;
  let stampCounter = 0;
  let readyEpoch = 0;
  let workScale = 1;
  let shedTimer = 0;
  let goodTimer = 0;

  const stats: RenderStats = {
    frame: 0,
    drawCalls: 0,
    passesDrawn: 0,
    workScale: 1,
    width: 0,
    height: 0,
    reusedScene: false,
  };

  // GPU objects (all recreated lazily after a context restore).
  const slots = new Map<ShaderName, Slot>();
  let fullscreenVao: WebGLVertexArrayObject | null = null;
  let blackTex: WebGLTexture | null = null;
  let tgt: TargetSet | null = null;
  const starCache = new Map<StarField, GpuStars>();
  let starStage = new Float32Array(0);

  // Idle-frame reuse.
  const keyBuf = new Float64Array(24);
  const lastKey = new Float64Array(24);
  let keyValid = false;
  let lastScene: RenderScene | null = null;
  let sceneCur: 0 | 1 = 0;
  let lastBloom: ColorTarget | null = null;
  let cmbDrawn = false;

  // Black holes: plasma textures, previous-output history, count drawn this frame.
  const plasmaCache = new Map<BlackHoleBody, PlasmaEntry>();
  const bhState: BlackHoleHistory = {
    target: null,
    valid: false,
    body: null,
    settingsRev: -1,
    still: 0,
    x: 0,
    y: 0,
    z: 0,
    rx: 1,
    ry: 0,
    rz: 0,
    ux: 0,
    uy: 1,
    uz: 0,
    fx: 0,
    fy: 0,
    fz: -1,
    tanX: 1,
    tanY: 1,
  };
  let bhDrawn = 0;

  // Per-frame scratch (no per-frame allocation in the hot paths).
  const rel64 = new Float64Array(3);
  const sunDir = new Float64Array(3);
  const sunCol = new Float64Array(3);
  const rot32 = new Float32Array(9);
  const rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const pool: Item[] = [];
  let poolUsed = 0;
  const galaxyList: Item[] = [];
  const nebulaList: Item[] = [];
  const pulsarList: Item[] = [];
  const nearList: Item[] = [];
  let fc: FrameConsts = {
    stamp: 0,
    right: [1, 0, 0],
    up: [0, 1, 0],
    forward: [0, 0, -1],
    tanX: 1,
    tanY: 1,
    width: 1,
    height: 1,
    time: 0,
    simTime: 0,
    simSpeed: 1,
    paused: false,
    exposure: 1,
    near: 0.1,
    far: 1e27,
    camPos: { tier: Tier.Surface, sector: [0, 0, 0], local: [0, 0, 0] },
  };

  // ---- GL state cache --------------------------------------------------------------------

  let stFbo: WebGLFramebuffer | null | undefined;
  let stProgram: WebGLProgram | null | undefined;
  let stVao: WebGLVertexArrayObject | null | undefined;
  let stBlend: BlendMode | null = null;
  let stDepth: boolean | null = null;
  let stScissorOn: boolean | null = null;
  let stScissorX = -1;
  let stScissorY = -1;
  let stScissorW = -1;
  let stScissorH = -1;
  let stActiveUnit = -1;
  const stTex: (WebGLTexture | null | undefined)[] = [undefined, undefined, undefined, undefined];

  function resetState(): void {
    stFbo = undefined;
    stProgram = undefined;
    stVao = undefined;
    stBlend = null;
    stDepth = null;
    stScissorOn = null;
    stScissorX = stScissorY = stScissorW = stScissorH = -1;
    stActiveUnit = -1;
    stTex.fill(undefined);
  }

  function bindFbo(fbo: WebGLFramebuffer | null): void {
    if (stFbo === fbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    stFbo = fbo;
  }

  function useProgram(p: ProgramEntry): void {
    if (stProgram === p.program) return;
    gl.useProgram(p.program);
    stProgram = p.program;
  }

  function bindVao(vao: WebGLVertexArrayObject | null): void {
    if (stVao === vao) return;
    gl.bindVertexArray(vao);
    stVao = vao;
  }

  function selectUnit(unit: number): void {
    if (stActiveUnit === unit) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    stActiveUnit = unit;
  }

  function bindTex(unit: number, tex: WebGLTexture | null): void {
    if (stTex[unit] === tex) return;
    selectUnit(unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    stTex[unit] = tex;
  }

  function setBlend(mode: BlendMode): void {
    if (stBlend === mode) return;
    stBlend = mode;
    if (mode === 'none') {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, mode === 'add' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  /** true: reversed-Z depth test (GREATER) with depth writes; false: no depth test, no writes. */
  function setDepthMode(on: boolean): void {
    if (stDepth === on) return;
    stDepth = on;
    if (on) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.GREATER);
      gl.depthMask(true);
    } else {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
    }
  }

  function setScissor(r: Rect | null): void {
    if (r === null) {
      if (stScissorOn === false) return;
      gl.disable(gl.SCISSOR_TEST);
      stScissorOn = false;
      return;
    }
    if (stScissorOn !== true) {
      gl.enable(gl.SCISSOR_TEST);
      stScissorOn = true;
    }
    if (stScissorX !== r.x || stScissorY !== r.y || stScissorW !== r.w || stScissorH !== r.h) {
      gl.scissor(r.x, r.y, r.w, r.h);
      stScissorX = r.x;
      stScissorY = r.y;
      stScissorW = r.w;
      stScissorH = r.h;
    }
  }

  // ---- context ---------------------------------------------------------------------------

  function initContext(): void {
    const colorBuffer = gl.getExtension('EXT_color_buffer_float') ?? gl.getExtension('EXT_color_buffer_half_float');
    if (colorBuffer === null) {
      throw new RendererError(
        'renderer.ts: this GPU/browser cannot render to RGBA16F (neither EXT_color_buffer_float nor ' +
          'EXT_color_buffer_half_float is available), so the HDR pipeline cannot run.',
      );
    }
    const parallel: unknown = gl.getExtension('KHR_parallel_shader_compile');
    completionStatusEnum =
      isPlainObject(parallel) || (typeof parallel === 'object' && parallel !== null)
        ? ((parallel as { COMPLETION_STATUS_KHR?: number }).COMPLETION_STATUS_KHR ?? null)
        : null;
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    maxPointSize = range[1] ?? 1;
    maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    gl.disable(gl.DITHER);
    resetState();
  }

  /** Forget every GPU handle without deleting (the context that owned them is gone). */
  function forgetGpuObjects(): void {
    slots.clear();
    fullscreenVao = null;
    blackTex = null;
    tgt = null;
    starCache.clear();
    plasmaCache.clear();
    bhState.target = null;
    bhState.valid = false;
    bhState.body = null;
    lastBloom = null;
    keyValid = false;
    lastScene = null;
    resetState();
  }

  function bindContext(next: WebGL2RenderingContext): void {
    if (bound && gl === next) return;
    if (bound) forgetGpuObjects();
    gl = next;
    bound = true;
    initContext();
  }

  // ---- programs --------------------------------------------------------------------------

  function beginProgram(name: ShaderName): Slot {
    const source = SHADERS[name];
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (vs === null || fs === null || program === null) {
      return { kind: 'failed', message: `renderer.ts: could not create GL objects for program "${name}" (context lost?)` };
    }
    gl.shaderSource(vs, source.vertex);
    gl.shaderSource(fs, source.fragment);
    gl.compileShader(vs);
    gl.compileShader(fs);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    return { kind: 'compiling', name, source, program, vs, fs };
  }

  function finishProgram(slot: CompilingSlot): ReadySlot | FailedSlot {
    const { name, source, program, vs, fs } = slot;
    const release = (): void => {
      gl.detachShader(program, vs);
      gl.detachShader(program, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      const parts: string[] = [`renderer.ts: program "${name}" failed to build.`];
      const stages: readonly [string, WebGLShader, string][] = [
        ['vertex', vs, source.vertex],
        ['fragment', fs, source.fragment],
      ];
      for (const [stage, shader, text] of stages) {
        if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
          const log = gl.getShaderInfoLog(shader) ?? '(no log)';
          parts.push(`--- ${stage} shader compile error ---`, log.trim(), shaderLogContext(text, log));
        }
      }
      const linkLog = gl.getProgramInfoLog(program) ?? '';
      if (linkLog.trim() !== '') parts.push('--- link log ---', linkLog.trim());
      release();
      gl.deleteProgram(program);
      const message = parts.filter((s) => s !== '').join('\n');
      console.error(message);
      return { kind: 'failed', message };
    }
    if (name === 'stars') {
      const wanted: readonly [string, number][] = [
        ['aPosition', ATTRIBUTES.position],
        ['aLuminosity', ATTRIBUTES.luminosity],
        ['aTemperature', ATTRIBUTES.temperature],
        ['aRadius', ATTRIBUTES.radius],
      ];
      for (const [attr, location] of wanted) {
        const got = gl.getAttribLocation(program, attr);
        if (got !== location) {
          release();
          gl.deleteProgram(program);
          const message = `renderer.ts: stars attribute "${attr}" is at location ${got}, ATTRIBUTES expects ${location}`;
          console.error(message);
          return { kind: 'failed', message };
        }
      }
    }
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    for (const uName of declaredUniforms(source.vertex, source.fragment)) {
      uniforms.set(uName, gl.getUniformLocation(program, uName));
    }
    release();
    readyEpoch += 1;
    return { kind: 'ready', entry: { name, program, uniforms, cameraStamp: -1 } };
  }

  /** Null while compiling (KHR_parallel_shader_compile) or after a failure; essential programs throw. */
  function getProgram(name: ShaderName, essential = false): ProgramEntry | null {
    let slot = slots.get(name);
    if (slot === undefined) {
      slot = beginProgram(name);
      slots.set(name, slot);
    }
    if (slot.kind === 'compiling') {
      if (completionStatusEnum !== null && gl.getProgramParameter(slot.program, completionStatusEnum) !== true) {
        return null;
      }
      slot = finishProgram(slot);
      slots.set(name, slot);
    }
    if (slot.kind === 'failed') {
      if (essential) throw new RendererError(slot.message);
      return null;
    }
    return slot.entry;
  }

  // ---- uniforms (every name is checked against the GLSL declarations) -----------------

  function loc(p: ProgramEntry, name: string): WebGLUniformLocation | null {
    const l = p.uniforms.get(name);
    if (l === undefined) {
      throw new RendererError(`renderer.ts: uniform "${name}" is not declared by the GLSL of program "${p.name}"`);
    }
    return l;
  }
  const f1 = (p: ProgramEntry, n: string, v: number): void => {
    const l = loc(p, n);
    if (l !== null) gl.uniform1f(l, v);
  };
  const i1 = (p: ProgramEntry, n: string, v: number): void => {
    const l = loc(p, n);
    if (l !== null) gl.uniform1i(l, v);
  };
  const f2 = (p: ProgramEntry, n: string, x: number, y: number): void => {
    const l = loc(p, n);
    if (l !== null) gl.uniform2f(l, x, y);
  };
  const f3 = (p: ProgramEntry, n: string, x: number, y: number, z: number): void => {
    const l = loc(p, n);
    if (l !== null) gl.uniform3f(l, x, y, z);
  };
  const v3 = (p: ProgramEntry, n: string, v: Vec3): void => f3(p, n, v[0], v[1], v[2]);
  const m3 = (p: ProgramEntry, n: string, m: Float32Array): void => {
    const l = loc(p, n);
    if (l !== null) gl.uniformMatrix3fv(l, false, m);
  };

  function applyCamera(p: ProgramEntry): void {
    if (p.cameraStamp === fc.stamp) return;
    p.cameraStamp = fc.stamp;
    v3(p, 'uCamRight', fc.right);
    v3(p, 'uCamUp', fc.up);
    v3(p, 'uCamForward', fc.forward);
    f2(p, 'uTanHalfFov', fc.tanX, fc.tanY);
    f2(p, 'uResolution', fc.width, fc.height);
    f1(p, 'uTime', fc.time);
    f1(p, 'uExposure', fc.exposure);
    f2(p, 'uDepthRange', fc.near, fc.far);
  }

  // ---- fullscreen / draws ------------------------------------------------------------------

  function ensureShared(): void {
    if (fullscreenVao === null) {
      const vao = gl.createVertexArray();
      if (vao === null) throw new RendererError('renderer.ts: could not create the fullscreen VAO');
      fullscreenVao = vao;
    }
    if (blackTex === null) {
      const tex = gl.createTexture();
      if (tex === null) throw new RendererError('renderer.ts: could not create the fallback texture');
      bindTex(0, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      bindTex(0, null);
      blackTex = tex;
    }
  }

  function drawFullscreen(): void {
    bindVao(fullscreenVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    stats.drawCalls += 1;
  }

  // ---- render targets ----------------------------------------------------------------------

  const STATUS_NAMES: readonly [number, string][] = [
    [0x8cd5, 'FRAMEBUFFER_COMPLETE'],
    [0x8cd6, 'FRAMEBUFFER_INCOMPLETE_ATTACHMENT'],
    [0x8cd7, 'FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT'],
    [0x8cdd, 'FRAMEBUFFER_UNSUPPORTED'],
    [0x8d56, 'FRAMEBUFFER_INCOMPLETE_MULTISAMPLE'],
  ];

  function createColorTarget(
    label: string,
    width: number,
    height: number,
    depth: WebGLRenderbuffer | null,
    mips = false,
  ): ColorTarget {
    if (width > maxTextureSize || height > maxTextureSize) {
      throw new RendererError(`renderer.ts: ${label} (${width}x${height}) exceeds MAX_TEXTURE_SIZE ${maxTextureSize}`);
    }
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (tex === null || fbo === null) throw new RendererError(`renderer.ts: could not allocate ${label}`);
    bindTex(0, tex);
    const mipLevels = mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, mipLevels, gl.RGBA16F, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    bindTex(0, null);
    bindFbo(fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (depth !== null) gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      const name = STATUS_NAMES.find(([code]) => code === status)?.[1] ?? `0x${status.toString(16)}`;
      throw new RendererError(`renderer.ts: framebuffer "${label}" (${width}x${height} RGBA16F) is incomplete: ${name}`);
    }
    return { tex, fbo, width, height };
  }

  function deleteColorTarget(t: ColorTarget): void {
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
  }

  function deleteTargets(t: TargetSet): void {
    for (const c of [...t.scene, ...t.down, ...t.up]) deleteColorTarget(c);
    gl.deleteRenderbuffer(t.depth);
    stFbo = undefined;
    stTex.fill(undefined);
  }

  function bloomLevelsFor(width: number, height: number, cap: number): number {
    let levels = 0;
    let w = width;
    let h = height;
    while (levels < cap) {
      w = Math.floor(w / 2);
      h = Math.floor(h / 2);
      if (Math.min(w, h) < 4) break;
      levels += 1;
    }
    return levels;
  }

  function createTargets(width: number, height: number, levels: number): TargetSet {
    const depth = gl.createRenderbuffer();
    if (depth === null) throw new RendererError('renderer.ts: could not create the depth renderbuffer');
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    const made: ColorTarget[] = [];
    try {
      const sceneA = createColorTarget('scene A', width, height, depth, true);
      made.push(sceneA);
      const sceneB = createColorTarget('scene B', width, height, depth, true);
      made.push(sceneB);
      const down: ColorTarget[] = [];
      let w = width;
      let h = height;
      for (let i = 0; i < levels; i++) {
        w = Math.floor(w / 2);
        h = Math.floor(h / 2);
        const t = createColorTarget(`bloom down ${i}`, w, h, null);
        made.push(t);
        down.push(t);
      }
      const up: ColorTarget[] = [];
      for (let i = 0; i < levels - 1; i++) {
        const d = down[i];
        if (d === undefined) throw new RendererError('renderer.ts: bloom chain is inconsistent');
        const t = createColorTarget(`bloom up ${i}`, d.width, d.height, null);
        made.push(t);
        up.push(t);
      }
      return { width, height, levels, depth, scene: [sceneA, sceneB], down, up };
    } catch (error) {
      for (const t of made) deleteColorTarget(t);
      gl.deleteRenderbuffer(depth);
      stFbo = undefined;
      stTex.fill(undefined);
      throw error;
    }
  }

  function bloomLevelCap(): number {
    return settings.passes.bloom ? Math.min(settings.bloom.levels, QUALITY[settings.quality].bloomLevels) : 0;
  }

  function ensureTargets(width: number, height: number): TargetSet {
    const want = bloomLevelsFor(width, height, bloomLevelCap());
    if (tgt !== null && tgt.width === width && tgt.height === height && tgt.levels === want) return tgt;
    if (tgt !== null) {
      deleteTargets(tgt);
      tgt = null;
    }
    keyValid = false;
    lastBloom = null;
    tgt = createTargets(width, height, want);
    sceneCur = 0;
    return tgt;
  }

  function targets(): TargetSet {
    if (tgt === null) throw new RendererError('renderer.ts: render targets are not allocated');
    return tgt;
  }

  /** A pass may never sample a texture that is attached to the framebuffer it draws into. */
  function assertNoFeedback(dst: ColorTarget, ...reads: readonly (WebGLTexture | null)[]): void {
    for (const t of reads) {
      if (t !== null && t === dst.tex) {
        throw new RendererError('renderer.ts: framebuffer feedback loop: a pass samples the texture it renders into');
      }
    }
  }

  function bindSceneTarget(): void {
    const t = targets();
    bindFbo(t.scene[sceneCur].fbo);
    gl.viewport(0, 0, t.width, t.height);
  }

  // ---- pass helpers ------------------------------------------------------------------------

  function steps(base: number, max: number, min = 8): number {
    return clamp(Math.round(base * QUALITY[settings.quality].stepScale * workScale), min, max);
  }

  function octaves(n: number | undefined, fallback: number): number {
    return clamp(Math.round(n ?? fallback), 1, 8);
  }

  /** Program ready + state from the shader's own metadata. toScene binds the current scene target. */
  function begin(name: ShaderName, toScene = true): ProgramEntry | null {
    const p = getProgram(name);
    if (p === null) return null;
    const meta = SHADERS[name];
    if (toScene) bindSceneTarget();
    useProgram(p);
    applyCamera(p);
    setBlend(meta.blend);
    setDepthMode(meta.writesDepth);
    stats.passesDrawn += 1;
    return p;
  }

  function acquire(): Item {
    let it = pool[poolUsed];
    if (it === undefined) {
      it = { index: 0, dist: 0, x: 0, y: 0, z: 0, kind: 0 };
      pool[poolUsed] = it;
    }
    poolUsed += 1;
    return it;
  }

  function fillList(
    list: Item[],
    bodies: readonly { readonly position: WorldPos }[] | undefined,
    kind: number,
  ): void {
    if (bodies === undefined) return;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b === undefined) continue;
      deltaInto(rel64, 0, b.position, fc.camPos);
      const it = acquire();
      it.index = i;
      it.kind = kind;
      it.x = rel64[0] as number;
      it.y = rel64[1] as number;
      it.z = rel64[2] as number;
      it.dist = Math.hypot(it.x, it.y, it.z);
      list.push(it);
    }
  }

  const farToNear = (a: Item, b: Item): number => b.dist - a.dist;

  /** Sets the scissor to the sphere's screen rectangle; false when it is off screen. */
  function scissorSphere(it: Item, radius: number): boolean {
    const cx = it.x * fc.right[0] + it.y * fc.right[1] + it.z * fc.right[2];
    const cy = it.x * fc.up[0] + it.y * fc.up[1] + it.z * fc.up[2];
    const cz = it.x * fc.forward[0] + it.y * fc.forward[1] + it.z * fc.forward[2];
    if (!projectSphere(rect, cx, cy, cz, radius, fc.tanX, fc.tanY, fc.width, fc.height)) return false;
    setScissor(rect);
    return true;
  }

  const setBody = (p: ProgramEntry, it: Item, radius: number): void => {
    f3(p, 'uCenter', it.x, it.y, it.z);
    f1(p, 'uRadius', radius);
  };

  function setAtmos(p: ProgramEntry, a: AtmosphereLayer | undefined): void {
    f1(p, 'uAtmoHeight', a === undefined ? 0 : a.heightM);
    v3(p, 'uBetaR', a === undefined ? ZERO3 : a.betaR);
    f1(p, 'uBetaM', a === undefined ? 0 : a.betaM);
    f1(p, 'uHR', a === undefined ? 1 : a.scaleHeightRM);
    f1(p, 'uHM', a === undefined ? 1 : a.scaleHeightMM);
    f1(p, 'uMieG', a === undefined ? 0 : a.mieG);
    f3(p, 'uSunDir', sunDir[0] as number, sunDir[1] as number, sunDir[2] as number);
    f3(p, 'uSunColor', sunCol[0] as number, sunCol[1] as number, sunCol[2] as number);
  }

  // ---- passes ------------------------------------------------------------------------------

  function drawBackground(): boolean {
    const p = begin('background');
    if (p === null) return false;
    setScissor(null);
    const c = settings.cmb;
    const t2 = c.temperatureK * c.temperatureK;
    const radiance0 = (SIGMA_SB * t2 * t2) / PI;
    f1(p, 'uCmbTemperature', c.temperatureK);
    f1(p, 'uCmbBrightness', c.level / (radiance0 * fc.exposure));
    f1(p, 'uCmbContrast', c.contrast);
    drawFullscreen();
    return true;
  }

  function cameraCellPosition(out: Float64Array, cellSize: number): void {
    const pos = fc.camPos;
    const tierCell = CELL_SIZE_M[pos.tier] as number;
    for (let a = 0; a < 3; a++) {
      const metres = (pos.sector[a] as number) * tierCell + (pos.local[a] as number);
      const cells = metres / cellSize;
      out[a] = ((cells % 1024) + 1024) % 1024;
    }
  }

  function drawCosmicWeb(): void {
    const p = begin('cosmicWeb');
    if (p === null) return;
    setScissor(null);
    const w = settings.cosmicWeb;
    cameraCellPosition(rel64, w.cellSizeM);
    f3(p, 'uCamCell', rel64[0] as number, rel64[1] as number, rel64[2] as number);
    f1(p, 'uCellSize', w.cellSizeM);
    f1(p, 'uMinDist', w.minDistCells * w.cellSizeM);
    f1(p, 'uMaxDist', w.maxDistCells * w.cellSizeM);
    f1(p, 'uFilament', w.filament);
    f1(p, 'uGain', w.level / fc.exposure);
    i1(p, 'uSteps', steps(settings.steps.cosmicWeb, MAX_STEPS.cosmicWeb));
    drawFullscreen();
  }

  function drawGalaxy(g: GalaxyBody, it: Item): void {
    if (!scissorSphere(it, g.radiusM)) return;
    const p = begin('galaxy');
    if (p === null) return;
    setBody(p, it, g.radiusM);
    v3(p, 'uNormal', unit(g.normal ?? AXIS_Y, AXIS_Y));
    f1(p, 'uArms', g.arms);
    f1(p, 'uPitch', g.pitch ?? 0.25);
    f1(p, 'uPhase', g.phase ?? 0);
    f1(p, 'uThickness', g.thickness ?? 0.015);
    f1(p, 'uBrightness', g.brightness);
    f1(p, 'uDustGain', g.dustGain);
    f1(p, 'uSeed', g.seed);
    i1(p, 'uSteps', steps(settings.steps.galaxy, MAX_STEPS.galaxy));
    i1(p, 'uOctaves', octaves(g.octaves, 4));
    v3(p, 'uBulgeColor', g.bulgeColor);
    v3(p, 'uDiskColor', g.diskColor);
    v3(p, 'uYoungColor', g.youngColor);
    drawFullscreen();
  }

  function drawNebula(n: NebulaBody, it: Item): void {
    if (!scissorSphere(it, n.radiusM)) return;
    const p = begin('nebula');
    if (p === null) return;
    setBody(p, it, n.radiusM);
    f1(p, 'uSeed', n.seed);
    f1(p, 'uDensity', n.density);
    f1(p, 'uEmissionGain', n.emissionGain);
    v3(p, 'uColorOiii', n.colorOiii);
    v3(p, 'uColorHa', n.colorHa);
    v3(p, 'uColorSii', n.colorSii);
    v3(p, 'uScatterColor', n.scatterColor);
    v3(p, 'uStarLight', n.starLight);
    i1(p, 'uSteps', steps(settings.steps.nebula, MAX_STEPS.nebula));
    i1(p, 'uOctaves', octaves(n.octaves, 4));
    drawFullscreen();
  }

  // -- stars

  function makeStarVao(pos: WebGLBuffer, attr: WebGLBuffer): WebGLVertexArrayObject {
    const vao = gl.createVertexArray();
    if (vao === null) throw new RendererError('renderer.ts: could not create the stars VAO');
    gl.bindVertexArray(vao);
    stVao = undefined;
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.enableVertexAttribArray(ATTRIBUTES.position);
    gl.vertexAttribPointer(ATTRIBUTES.position, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, attr);
    gl.enableVertexAttribArray(ATTRIBUTES.luminosity);
    gl.vertexAttribPointer(ATTRIBUTES.luminosity, 1, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(ATTRIBUTES.temperature);
    gl.vertexAttribPointer(ATTRIBUTES.temperature, 1, gl.FLOAT, false, 12, 4);
    gl.enableVertexAttribArray(ATTRIBUTES.radius);
    gl.vertexAttribPointer(ATTRIBUTES.radius, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }

  function createGpuStars(): GpuStars {
    const make = (): WebGLBuffer => {
      const b = gl.createBuffer();
      if (b === null) throw new RendererError('renderer.ts: could not create a star buffer');
      return b;
    };
    const pos0 = make();
    const pos1 = make();
    const attr = make();
    return {
      vaos: [makeStarVao(pos0, attr), makeStarVao(pos1, attr)],
      pos: [pos0, pos1],
      attr,
      capacity: 0,
      uploaded: false,
      current: 0,
      staticRevision: -1,
      staticCount: -1,
      lastRel: new Float64Array(3),
      lastUsedFrame: frameIndex,
    };
  }

  function deleteGpuStars(g: GpuStars): void {
    gl.deleteVertexArray(g.vaos[0]);
    gl.deleteVertexArray(g.vaos[1]);
    gl.deleteBuffer(g.pos[0]);
    gl.deleteBuffer(g.pos[1]);
    gl.deleteBuffer(g.attr);
    stVao = undefined;
  }

  function drawStarField(field: StarField): void {
    let g = starCache.get(field);
    if (g === undefined) {
      g = createGpuStars();
      starCache.set(field, g);
    }
    g.lastUsedFrame = frameIndex;
    const n = Math.max(
      0,
      Math.min(
        field.count,
        settings.stars.maxPerField,
        Math.floor(field.offsetsM.length / 3),
        field.luminosityW.length,
        field.temperatureK.length,
        field.radiusM.length,
      ),
    );
    if (n === 0) return;

    const revision = field.revision ?? 0;
    let rebuilt = false;
    if (g.capacity < n) {
      g.capacity = nextPow2(n);
      for (const b of g.pos) {
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, g.capacity * 12, gl.DYNAMIC_DRAW);
      }
      g.uploaded = false;
      rebuilt = true;
    }
    if (g.staticRevision !== revision || g.staticCount !== n || rebuilt) {
      const attrs = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        attrs[i * 3] = field.luminosityW[i] as number;
        attrs[i * 3 + 1] = field.temperatureK[i] as number;
        attrs[i * 3 + 2] = field.radiusM[i] as number;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.attr);
      gl.bufferData(gl.ARRAY_BUFFER, attrs, gl.STATIC_DRAW);
      g.staticRevision = revision;
      g.staticCount = n;
      g.uploaded = false;
    }

    deltaInto(rel64, 0, field.anchor, fc.camPos);
    const changed =
      !g.uploaded || g.lastRel[0] !== rel64[0] || g.lastRel[1] !== rel64[1] || g.lastRel[2] !== rel64[2];
    if (changed) {
      if (starStage.length < n * 3) starStage = new Float32Array(nextPow2(n * 3));
      const rx = rel64[0] as number;
      const ry = rel64[1] as number;
      const rz = rel64[2] as number;
      const off = field.offsetsM;
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        starStage[k] = (off[k] as number) + rx;
        starStage[k + 1] = (off[k + 1] as number) + ry;
        starStage[k + 2] = (off[k + 2] as number) + rz;
      }
      // Alternate between two buffers so the upload never waits on the previous frame's draw.
      const next: 0 | 1 = g.uploaded ? (g.current === 0 ? 1 : 0) : g.current;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pos[next]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, starStage, 0, n * 3);
      g.current = next;
      g.uploaded = true;
      g.lastRel.set(rel64);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    bindVao(g.vaos[g.current]);
    gl.drawArrays(gl.POINTS, 0, n);
    stats.drawCalls += 1;
  }

  function drawStars(fields: readonly StarField[]): void {
    const p = begin('stars');
    if (p === null) return;
    setScissor(null);
    f1(p, 'uPsfSigmaPx', settings.stars.psfSigmaPx);
    f1(p, 'uPointSizeMax', Math.min(settings.stars.pointSizeMax, maxPointSize));
    f1(p, 'uSpikeStrength', settings.stars.spikeStrength);
    for (const field of fields) drawStarField(field);
  }

  function evictStars(): void {
    for (const [field, g] of starCache) {
      if (frameIndex - g.lastUsedFrame > STAR_EVICT_FRAMES) {
        deleteGpuStars(g);
        starCache.delete(field);
      }
    }
  }

  // -- pulsars

  function drawPulsar(pl: PulsarBody, it: Item): void {
    if (!scissorSphere(it, pl.beamLengthM)) return;
    const p = begin('pulsar');
    if (p === null) return;
    f3(p, 'uCenter', it.x, it.y, it.z);
    v3(p, 'uSpinAxis', unit(pl.spinAxis ?? AXIS_Y, AXIS_Y));
    f1(p, 'uTilt', pl.tiltRad);
    f1(p, 'uPeriod', pl.periodS);
    f1(p, 'uBeamHalfAngle', pl.beamHalfAngleRad);
    f1(p, 'uBeamLength', pl.beamLengthM);
    f1(p, 'uStarRadius', pl.radiusM);
    f1(p, 'uStarTemperature', pl.temperatureK);
    f1(p, 'uBeamRadiance', pl.beamRadiance);
    i1(p, 'uSteps', steps(settings.steps.pulsar, MAX_STEPS.pulsar));
    // The pulsar shader only uses uTime through fract(uTime / period): an exact modulo keeps the
    // phase continuous. Above maxFlashHz the beams would strobe, so the phase is held instead.
    const apparentHz = fc.simSpeed / pl.periodS;
    const phaseTime =
      !fc.paused && apparentHz > settings.maxFlashHz ? 0 : ((fc.simTime % pl.periodS) + pl.periodS) % pl.periodS;
    f1(p, 'uTime', phaseTime);
    drawFullscreen();
  }

  // -- black holes

  /** False when no ray of the frustum comes within the shader's lensing limit of the hole. */
  function blackHoleReaches(it: Item, rgM: number, boundRg: number): boolean {
    if (it.dist <= boundRg * rgM) return true;
    const cosA = clamp(
      (it.x * fc.forward[0] + it.y * fc.forward[1] + it.z * fc.forward[2]) / it.dist,
      -1,
      1,
    );
    const off = Math.acos(cosA) - Math.atan(Math.hypot(fc.tanX, fc.tanY));
    if (off <= 0) return true;
    const bMin = off >= PI / 2 ? it.dist : it.dist * Math.sin(off);
    return bMin <= BH_LENS_LIMIT_RG * rgM;
  }

  /** The PlasmaDisk of this hole: created on first use, rebuilt when its settings change, clocked by simulation time. */
  function plasmaFor(b: BlackHoleBody, disk: BlackHoleDisk, outerRg: number): PlasmaDisk {
    const bh = settings.blackHole;
    const innerRg = disk.innerRg ?? 0;
    let e = plasmaCache.get(b);
    if (
      e !== undefined &&
      (e.spin !== b.spin || e.outerRg !== outerRg || e.innerRg !== innerRg || e.size !== bh.plasmaSize)
    ) {
      e.plasma.dispose(gl);
      plasmaCache.delete(b);
      e = undefined;
    }
    const rgSeconds = b.rgM / C_LIGHT;
    if (e === undefined) {
      e = {
        plasma: new PlasmaDisk({
          spin: b.spin,
          outerRg,
          innerRg,
          width: bh.plasmaSize,
          height: bh.plasmaSize,
          timeRg: fc.simTime / rgSeconds,
        }),
        spin: b.spin,
        outerRg,
        innerRg,
        size: bh.plasmaSize,
        lastSim: fc.simTime,
        lastUsedFrame: frameIndex,
      };
      plasmaCache.set(b, e);
    } else {
      e.plasma.step(fc.simTime - e.lastSim, rgSeconds);
      e.lastSim = fc.simTime;
      e.lastUsedFrame = frameIndex;
    }
    // A rebuild is spread over frames (a few ms each) so it never stalls one; the first build runs hotter.
    e.plasma.work(e.plasma.ready ? bh.plasmaBudgetMs : PLASMA_FIRST_BUILD_MS);
    return e.plasma;
  }

  function evictPlasma(): void {
    for (const [body, e] of plasmaCache) {
      if (frameIndex - e.lastUsedFrame > PLASMA_EVICT_FRAMES) {
        e.plasma.dispose(gl);
        plasmaCache.delete(body);
      }
    }
  }

  /** The history target at the current size (recreated, and marked invalid, when the size changed). */
  function ensureHistory(t: TargetSet): ColorTarget {
    const h = bhState.target;
    if (h !== null && h.width === t.width && h.height === t.height) return h;
    if (h !== null) deleteColorTarget(h);
    const made = createColorTarget('black hole history', t.width, t.height, null);
    bhState.target = made;
    bhState.valid = false;
    return made;
  }

  /**
   * 0..1 trust in the previous output. 0 for another hole, other settings or no history; otherwise it falls
   * smoothly from 1 (camera has not translated) to 0 (half a pixel of parallax), because the shader only
   * reprojects rotation. A smooth value means the blend and the jitter fade instead of switching on and off.
   */
  function historyConfidence(b: BlackHoleBody, it: Item): number {
    const h = bhState;
    if (!h.valid || h.body !== b || h.settingsRev !== settingsRevision) return 0;
    const limit = 0.5 * ((2 * fc.tanY) / fc.height) * it.dist;
    if (!(limit > 0)) return 0;
    const s = clamp(1 - Math.hypot(it.x - h.x, it.y - h.y, it.z - h.z) / limit, 0, 1);
    return s * s * (3 - 2 * s);
  }

  /** True when the camera has turned by less than a twentieth of a pixel since the history was written. */
  function cameraStill(): boolean {
    const h = bhState;
    const df = clamp(fc.forward[0] * h.fx + fc.forward[1] * h.fy + fc.forward[2] * h.fz, -1, 1);
    const dr = clamp(fc.right[0] * h.rx + fc.right[1] * h.ry + fc.right[2] * h.rz, -1, 1);
    return Math.max(Math.acos(df), Math.acos(dr)) <= 0.05 * ((2 * fc.tanY) / fc.height);
  }

  function drawBlackHole(b: BlackHoleBody, it: Item): void {
    const disk = b.disk ?? null;
    const jet = b.jet !== undefined && b.jet !== null && b.jet.gain > 0 ? b.jet : null;
    const outerRg = disk?.outerRg ?? BLACK_HOLE_DEFAULTS.outerRg;
    const boundRg =
      b.boundRg ?? Math.max(BLACK_HOLE_DEFAULTS.boundMinRg, outerRg * BLACK_HOLE_DEFAULTS.boundOverOuter);
    const reachRg = jet === null ? boundRg : Math.max(boundRg, jet.lengthRg * 1.05);
    if (!blackHoleReaches(it, b.rgM, reachRg)) return;

    const t = targets();
    const src = t.scene[sceneCur];
    const dst = t.scene[sceneCur === 0 ? 1 : 0];
    assertNoFeedback(dst, src.tex);

    const p = getProgram('blackhole');
    if (p === null) return;
    const bh = settings.blackHole;
    const first = bhDrawn === 0;
    bhDrawn += 1;
    const plasma = disk !== null && bh.plasmaMix > 0 ? plasmaFor(b, disk, outerRg) : null;
    const hist = first && bh.temporalBlend > 0 ? ensureHistory(t) : null;
    const conf = hist === null ? 0 : historyConfidence(b, it);
    if (first) bhState.still = conf > 0.95 && cameraStill() ? bhState.still + 1 : 0;
    // While the camera is still the blend rises towards 0.9 so the jittered samples average out (no edge
    // shimmer); it falls back to temporalBlend as soon as the camera moves, and a faster simulation (a
    // faster-moving disk) lowers the ceiling so nothing ghosts.
    const accum = Math.min(1 - 1 / (bhState.still + 1), 0.9 / Math.max(1, Math.abs(fc.simSpeed)));
    const blend = conf * Math.max(bh.temporalBlend, accum);
    const mip = bh.maxFootprintPx > 0;

    const meta = SHADERS.blackhole;
    bindFbo(dst.fbo);
    gl.viewport(0, 0, t.width, t.height);
    useProgram(p);
    applyCamera(p);
    setScissor(null);
    setBlend(meta.blend);
    setDepthMode(meta.writesDepth);
    stats.passesDrawn += 1;

    f3(p, 'uCenter', it.x, it.y, it.z);
    f1(p, 'uRg', b.rgM);
    v3(p, 'uSpinAxis', unit(b.spinAxis ?? AXIS_Y, AXIS_Y));
    f1(p, 'uSpin', b.spin);
    // Disk flow clock in float64 (exact at any simulation speed) and the R_g / c that pass per frame (~60 fps),
    // so the shader can fade fast-moving azimuthal structure into smooth rings instead of strobing.
    const rgSec = b.rgM / C_LIGHT;
    const flowRg = fc.simTime / rgSec;
    f1(p, 'uFlowPhase', (((flowRg / BH_FLOW_CYCLE_RG) % 1) + 1) % 1);
    f1(p, 'uFlowRate', fc.paused ? 0 : Math.abs(fc.simSpeed) / (60 * rgSec));
    f1(p, 'uBoundRg', boundRg);
    f1(p, 'uDiskInnerRg', disk?.innerRg ?? 0);
    f1(p, 'uDiskOuterRg', outerRg);
    f1(p, 'uDiskHeight', disk?.heightRatio ?? BLACK_HOLE_DEFAULTS.heightRatio);
    f1(p, 'uDiskTemperature', disk === null ? 0 : disk.peakTemperatureK);
    f1(p, 'uDiskOpacity', disk === null ? 0 : (disk.opacity ?? BLACK_HOLE_DEFAULTS.opacity));
    f1(p, 'uDiskVisTemp', disk?.visTempK ?? BLACK_HOLE_DEFAULTS.visTempK);
    let gain = 0;
    if (disk !== null) {
      if (disk.gain !== undefined) {
        gain = disk.gain;
      } else {
        const t2 = disk.peakTemperatureK * disk.peakTemperatureK;
        const peakRadiance = (SIGMA_SB * t2 * t2) / PI;
        gain = settings.blackHole.peakLevel / (peakRadiance * fc.exposure);
      }
    }
    f1(p, 'uDiskGain', gain);
    f1(p, 'uSurfaceRg', b.surface === undefined ? 0 : b.surface.radiusRg);
    f1(p, 'uSurfaceTemperature', b.surface === undefined ? 0 : b.surface.temperatureK);
    i1(p, 'uMaxSteps', steps(settings.steps.blackHole, MAX_STEPS.blackHole, 48));
    // Rays leaving the screen see the CMB level when that pass drew, otherwise black.
    const lvl = cmbDrawn ? settings.cmb.level : 0;
    f3(p, 'uFallback', CMB_TINT[0] * lvl, CMB_TINT[1] * lvl, CMB_TINT[2] * lvl);

    // Jets (gain is display-referred, like the disk's).
    f1(p, 'uJetGain', jet === null ? 0 : jet.gain / fc.exposure);
    f1(p, 'uJetLengthRg', jet === null ? 0 : jet.lengthRg);
    f1(p, 'uJetWidth', jet === null ? 0 : jet.widthRg);

    // Supersampling, mip-filtered lensing and temporal smoothing. The sub-pixel jitter scales with the
    // history confidence: it is full while the history is trusted and gone when it is not (it would shimmer).
    const jn = (frameIndex % 16) + 1;
    i1(p, 'uSamples', bh.samples);
    f2(p, 'uJitter', (halton(jn, 2) - 0.5) * conf, (halton(jn, 3) - 0.5) * conf);
    f1(p, 'uMaxFootprint', bh.maxFootprintPx);
    f1(p, 'uTemporalBlend', blend);
    f1(p, 'uHistoryValid', conf > 0 ? 1 : 0);
    f3(p, 'uPrevCamRight', bhState.rx, bhState.ry, bhState.rz);
    f3(p, 'uPrevCamUp', bhState.ux, bhState.uy, bhState.uz);
    f3(p, 'uPrevCamForward', bhState.fx, bhState.fy, bhState.fz);
    f2(p, 'uPrevTanHalfFov', bhState.tanX, bhState.tanY);

    // Plasma texture (unit 2). PlasmaDisk.upload binds the texture on the active unit ONLY when it creates or
    // re-uploads it, so it must always be bound explicitly afterwards (otherwise the shader samples an empty
    // unit on every other frame and the disk renders black). The cache entry is forgotten first because
    // upload may have changed the binding behind it.
    if (plasma !== null && plasma.ready) {
      selectUnit(PLASMA_UNIT);
      const plasmaTex = plasma.upload(gl);
      stTex[PLASMA_UNIT] = undefined;
      bindTex(PLASMA_UNIT, plasmaTex);
      f1(p, 'uPlasmaMix', bh.plasmaMix);
      f2(p, 'uPlasmaSize', plasma.width, plasma.height);
      f1(p, 'uPlasmaAge', clamp(fc.simTime / (b.rgM / C_LIGHT) - plasma.shownTime, 0, PLASMA_MAX_AGE_RG));
    } else {
      bindTex(PLASMA_UNIT, blackTex);
      f1(p, 'uPlasmaMix', 0);
      f2(p, 'uPlasmaSize', 1, 1);
      f1(p, 'uPlasmaAge', 0);
    }
    i1(p, 'uPlasma', PLASMA_UNIT);

    bindTex(HISTORY_UNIT, hist !== null && conf > 0 ? hist.tex : blackTex);
    i1(p, 'uHistory', HISTORY_UNIT);

    bindTex(SCENE_UNIT, src.tex);
    if (mip) {
      selectUnit(SCENE_UNIT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    i1(p, 'uSceneColor', SCENE_UNIT);
    drawFullscreen();
    if (mip) {
      selectUnit(SCENE_UNIT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }
    bindTex(SCENE_UNIT, null);
    bindTex(HISTORY_UNIT, null);
    bindTex(PLASMA_UNIT, null);

    if (hist !== null) {
      // Keep this pass's output as the next frame's history (scissor is off, so the blit covers the frame).
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dst.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hist.fbo);
      gl.blitFramebuffer(0, 0, t.width, t.height, 0, 0, t.width, t.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      stFbo = undefined;
      bhState.valid = true;
      bhState.body = b;
      bhState.settingsRev = settingsRevision;
      bhState.x = it.x;
      bhState.y = it.y;
      bhState.z = it.z;
      bhState.rx = fc.right[0];
      bhState.ry = fc.right[1];
      bhState.rz = fc.right[2];
      bhState.ux = fc.up[0];
      bhState.uy = fc.up[1];
      bhState.uz = fc.up[2];
      bhState.fx = fc.forward[0];
      bhState.fy = fc.forward[1];
      bhState.fz = fc.forward[2];
      bhState.tanX = fc.tanX;
      bhState.tanY = fc.tanY;
    } else if (first) {
      bhState.valid = false;
    }
    sceneCur = sceneCur === 0 ? 1 : 0;
  }

  // -- planets

  function computeLight(pl: PlanetBody): void {
    sunDir[0] = 0;
    sunDir[1] = 1;
    sunDir[2] = 0;
    sunCol[0] = sunCol[1] = sunCol[2] = 0;
    const ill = pl.illuminant;
    if (ill === undefined) return;
    deltaInto(rel64, 0, ill.position, pl.position);
    const lx = rel64[0] as number;
    const ly = rel64[1] as number;
    const lz = rel64[2] as number;
    const d = Math.hypot(lx, ly, lz);
    if (!(d > 0)) return;
    sunDir[0] = lx / d;
    sunDir[1] = ly / d;
    sunDir[2] = lz / d;
    const irradiance = ill.luminosityW / (4 * PI * d * d);
    sunCol[0] = ill.color[0] * irradiance;
    sunCol[1] = ill.color[1] * irradiance;
    sunCol[2] = ill.color[2] * irradiance;
  }

  function drawPlanetSurface(pl: PlanetBody, it: Item): void {
    if (!scissorSphere(it, pl.radiusM)) return;
    const p = begin('planet');
    if (p === null) return;
    setBody(p, it, pl.radiusM);
    setAtmos(p, pl.atmosphere);
    const rot = pl.rotation ?? IDENTITY3;
    for (let i = 0; i < 9; i++) rot32[i] = rot[i] as number;
    m3(p, 'uRot', rot32);

    const s = pl.surface;
    let kind = 0;
    let sea = 0;
    let ice = 0;
    let bump = 0;
    let cloud = 0;
    let wind = 0;
    let bandFreq = 0;
    let low: Vec3 = ZERO3;
    let high: Vec3 = ZERO3;
    let shallow: Vec3 = ZERO3;
    let deep: Vec3 = ZERO3;
    let bandA: Vec3 = ZERO3;
    let bandB: Vec3 = ZERO3;
    let bandC: Vec3 = ZERO3;
    let storm: Vec3 = ZERO3;
    if (s.kind === 'ocean') {
      kind = 0;
      sea = s.seaLevel;
      ice = s.ice;
      bump = s.bump;
      cloud = s.cloudCover;
      low = s.paletteLow;
      high = s.paletteHigh;
      shallow = s.oceanShallow;
      deep = s.oceanDeep;
    } else if (s.kind === 'gas') {
      kind = 1;
      wind = s.wind;
      bandFreq = s.bandFreq;
      bandA = s.bandA;
      bandB = s.bandB;
      bandC = s.bandC;
      storm = s.storm;
    } else {
      kind = 2;
      ice = s.ice;
      bump = s.bump;
      low = s.paletteLow;
      high = s.paletteHigh;
    }
    i1(p, 'uKind', kind);
    f1(p, 'uSeed', s.seed);
    i1(p, 'uOctaves', octaves(s.octaves, 4));
    f1(p, 'uSeaLevel', sea);
    f1(p, 'uIce', ice);
    f1(p, 'uBump', bump);
    f1(p, 'uCloud', cloud);
    f1(p, 'uWind', wind);
    f1(p, 'uBandFreq', bandFreq);
    v3(p, 'uPalLow', low);
    v3(p, 'uPalHigh', high);
    v3(p, 'uPalOceanShallow', shallow);
    v3(p, 'uPalOceanDeep', deep);
    v3(p, 'uBandA', bandA);
    v3(p, 'uBandB', bandB);
    v3(p, 'uBandC', bandC);
    v3(p, 'uStormColor', storm);
    drawFullscreen();
  }

  function drawRings(pl: PlanetBody, r: RingSystem, it: Item): void {
    if (!scissorSphere(it, r.outerM)) return;
    const p = begin('rings');
    if (p === null) return;
    setBody(p, it, pl.radiusM);
    v3(p, 'uRingNormal', unit(r.normal, AXIS_Y));
    f1(p, 'uRingInner', r.innerM);
    f1(p, 'uRingOuter', r.outerM);
    f1(p, 'uRingOpacity', r.opacity);
    v3(p, 'uRingColorA', r.colorA);
    v3(p, 'uRingColorB', r.colorB);
    f1(p, 'uSeed', r.seed);
    f3(p, 'uSunDir', sunDir[0] as number, sunDir[1] as number, sunDir[2] as number);
    f3(p, 'uSunColor', sunCol[0] as number, sunCol[1] as number, sunCol[2] as number);
    drawFullscreen();
  }

  function drawClouds(pl: PlanetBody, a: AtmosphereLayer, c: CloudLayer, it: Item): void {
    if (!scissorSphere(it, pl.radiusM + c.topM)) return;
    const p = begin('clouds');
    if (p === null) return;
    setBody(p, it, pl.radiusM);
    setAtmos(p, a);
    f1(p, 'uCloudBottom', c.bottomM);
    f1(p, 'uCloudTop', c.topM);
    f1(p, 'uCloudScale', c.scaleM);
    f1(p, 'uCoverage', c.coverage);
    f1(p, 'uCloudDensity', c.densityPerM);
    v3(p, 'uCloudDrift', c.driftPerS);
    i1(p, 'uSteps', steps(settings.steps.clouds, MAX_STEPS.clouds));
    drawFullscreen();
  }

  function drawAtmosphere(pl: PlanetBody, a: AtmosphereLayer, it: Item): void {
    if (!scissorSphere(it, pl.radiusM + a.heightM)) return;
    const p = begin('atmosphere');
    if (p === null) return;
    setBody(p, it, pl.radiusM);
    setAtmos(p, a);
    drawFullscreen();
  }

  function drawAurora(pl: PlanetBody, a: AtmosphereLayer, au: AuroraLayer, it: Item): void {
    if (!scissorSphere(it, pl.radiusM + au.topM)) return;
    const p = begin('aurora');
    if (p === null) return;
    setBody(p, it, pl.radiusM);
    setAtmos(p, a);
    v3(p, 'uMagAxis', unit(au.magneticAxis, AXIS_Y));
    f1(p, 'uAuroraStrength', au.strength);
    f1(p, 'uAuroraOval', au.ovalRad);
    f1(p, 'uAuroraBottom', au.bottomM);
    f1(p, 'uAuroraTop', au.topM);
    drawFullscreen();
  }

  function drawPlanetStack(pl: PlanetBody, it: Item): void {
    const on = settings.passes;
    computeLight(pl);
    if (on.planet) drawPlanetSurface(pl, it);
    if (on.rings && pl.rings !== undefined) drawRings(pl, pl.rings, it);
    const atmo = pl.atmosphere;
    if (atmo === undefined) return;
    if (on.clouds && atmo.clouds !== undefined) drawClouds(pl, atmo, atmo.clouds, it);
    if (on.atmosphere) drawAtmosphere(pl, atmo, it);
    if (on.aurora && atmo.aurora !== undefined) drawAurora(pl, atmo, atmo.aurora, it);
  }

  // ---- scene -------------------------------------------------------------------------------

  function renderScene(scene: RenderScene): void {
    const t = targets();
    const on = settings.passes;
    poolUsed = 0;
    bhDrawn = 0;
    galaxyList.length = 0;
    nebulaList.length = 0;
    pulsarList.length = 0;
    nearList.length = 0;

    bindSceneTarget();
    setScissor(null);
    gl.depthMask(true);
    stDepth = null;
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    void t;

    cmbDrawn = on.background ? drawBackground() : false;
    if (on.cosmicWeb) drawCosmicWeb();

    if (on.galaxy && scene.galaxies !== undefined) {
      fillList(galaxyList, scene.galaxies, 0);
      galaxyList.sort(farToNear);
      for (const it of galaxyList) {
        const g = scene.galaxies[it.index];
        if (g !== undefined) drawGalaxy(g, it);
      }
    }
    if (on.nebula && scene.nebulae !== undefined) {
      fillList(nebulaList, scene.nebulae, 0);
      nebulaList.sort(farToNear);
      for (const it of nebulaList) {
        const n = scene.nebulae[it.index];
        if (n !== undefined) drawNebula(n, it);
      }
    }
    if (on.stars && scene.starFields !== undefined && scene.starFields.length > 0) drawStars(scene.starFields);
    if (on.pulsar && scene.pulsars !== undefined) {
      fillList(pulsarList, scene.pulsars, 0);
      pulsarList.sort(farToNear);
      for (const it of pulsarList) {
        const pl = scene.pulsars[it.index];
        if (pl !== undefined) drawPulsar(pl, it);
      }
    }
    if (on.blackhole) fillList(nearList, scene.blackHoles, 0);
    if (on.planet || on.rings || on.clouds || on.atmosphere || on.aurora) fillList(nearList, scene.planets, 1);
    nearList.sort(farToNear);
    for (const it of nearList) {
      if (it.kind === 0) {
        const b = scene.blackHoles?.[it.index];
        if (b !== undefined) drawBlackHole(b, it);
      } else {
        const pl = scene.planets?.[it.index];
        if (pl !== undefined) drawPlanetStack(pl, it);
      }
    }
    setScissor(null);
  }

  // ---- bloom -------------------------------------------------------------------------------

  /** Returns the texture to add in the tonemap, or null when bloom is off or not ready. */
  function renderBloom(): ColorTarget | null {
    const t = targets();
    if (!settings.passes.bloom || t.levels < 1) return null;
    const down = getProgram('bloomDown');
    const up = getProgram('bloomUp');
    if (down === null || up === null) return null;
    setScissor(null);
    setBlend('none');
    setDepthMode(false);
    stats.passesDrawn += 2;

    useProgram(down);
    let source: ColorTarget = t.scene[sceneCur];
    for (let i = 0; i < t.levels; i++) {
      const dst = t.down[i];
      if (dst === undefined) return null;
      assertNoFeedback(dst, source.tex);
      bindFbo(dst.fbo);
      gl.viewport(0, 0, dst.width, dst.height);
      bindTex(0, source.tex);
      i1(down, 'uSource', 0);
      f2(down, 'uTexel', 1 / source.width, 1 / source.height);
      f2(down, 'uInvOutSize', 1 / dst.width, 1 / dst.height);
      f1(down, 'uFirstPass', i === 0 ? 1 : 0);
      drawFullscreen();
      source = dst;
    }

    useProgram(up);
    let lower: ColorTarget = source;
    for (let i = t.levels - 2; i >= 0; i--) {
      const dst = t.up[i];
      const prev = t.down[i];
      if (dst === undefined || prev === undefined) return null;
      assertNoFeedback(dst, lower.tex, prev.tex);
      bindFbo(dst.fbo);
      gl.viewport(0, 0, dst.width, dst.height);
      bindTex(0, lower.tex);
      bindTex(1, prev.tex);
      i1(up, 'uSource', 0);
      i1(up, 'uPrev', 1);
      f2(up, 'uTexel', 1 / lower.width, 1 / lower.height);
      f2(up, 'uInvOutSize', 1 / dst.width, 1 / dst.height);
      f1(up, 'uRadius', settings.bloom.radius);
      f1(up, 'uWeight', settings.bloom.weight);
      drawFullscreen();
      lower = dst;
    }
    bindTex(0, null);
    bindTex(1, null);
    return lower;
  }

  // ---- tonemap / present -------------------------------------------------------------------

  function present(bloom: ColorTarget | null): void {
    const t = targets();
    bindFbo(null);
    gl.viewport(0, 0, t.width, t.height);
    setScissor(null);
    setBlend('none');
    setDepthMode(false);
    const p = getProgram('tonemap', true);
    if (p === null) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    useProgram(p);
    stats.passesDrawn += 1;
    const scene = t.scene[sceneCur];
    bindTex(0, scene.tex);
    bindTex(1, bloom === null ? blackTex : bloom.tex);
    i1(p, 'uScene', 0);
    i1(p, 'uBloom', 1);
    f1(p, 'uPostExposure', settings.postExposure);
    f1(p, 'uBloomStrength', bloom === null ? 0 : settings.bloom.strength);
    f1(p, 'uVignette', settings.vignette);
    drawFullscreen();
    bindTex(0, null);
    bindTex(1, null);
  }

  // ---- frame ---------------------------------------------------------------------------------

  function updateGovernor(frame: FrameInfo): void {
    if (!settings.adaptiveWork) {
      workScale = 1;
      return;
    }
    const bottleneck = frame.workload.bottleneck;
    if (bottleneck === 'gpu' && frame.resolutionScale <= RES_FLOOR) {
      goodTimer = 0;
      shedTimer += frame.dt;
      if (shedTimer >= 0.5) {
        workScale = Math.max(WORK_MIN, workScale * 0.85);
        shedTimer = 0;
      }
      return;
    }
    shedTimer = 0;
    if (bottleneck === 'none') {
      goodTimer += frame.dt;
      if (goodTimer >= 3 && workScale < 1) {
        workScale = Math.min(1, workScale * 1.1);
        goodTimer = 0;
      }
    } else {
      goodTimer = 0;
    }
  }

  function buildKey(frame: FrameInfo, scene: RenderScene): void {
    const cam = frame.camera;
    const p = cam.position;
    let i = 0;
    keyBuf[i++] = frame.width;
    keyBuf[i++] = frame.height;
    keyBuf[i++] = p.tier;
    for (const v of p.sector) keyBuf[i++] = v;
    for (const v of p.local) keyBuf[i++] = v;
    for (const v of cam.forward) keyBuf[i++] = v;
    for (const v of cam.right) keyBuf[i++] = v;
    for (const v of cam.up) keyBuf[i++] = v;
    keyBuf[i++] = fc.time;
    keyBuf[i++] = workScale;
    keyBuf[i++] = readyEpoch;
    keyBuf[i++] = settingsRevision;
    keyBuf[i++] = scene.revision ?? 0;
  }

  function keysEqual(): boolean {
    for (let i = 0; i < keyBuf.length; i++) if (keyBuf[i] !== lastKey[i]) return false;
    return true;
  }

  function logCoverage(scene: RenderScene): void {
    const notReady = coverage(scene).filter((r) => r.status === 'no-scene-data');
    console.groupCollapsed(
      `[renderer] ${notReady.length} pass(es) have no scene data; ${MISSING_DEPENDENCIES.length} missing dependencies`,
    );
    for (const r of notReady) console.info(`${r.pass}: ${r.detail}`);
    for (const m of MISSING_DEPENDENCIES) console.info(`missing: ${m}`);
    console.groupEnd();
  }

  function render(frame: FrameInfo, scene: RenderScene = EMPTY_SCENE): void {
    if (disposed) return;
    bindContext(frame.gl);
    if (gl.isContextLost()) return;

    stats.frame = frameIndex;
    stats.drawCalls = 0;
    stats.passesDrawn = 0;
    stats.reusedScene = false;
    stats.width = frame.width;
    stats.height = frame.height;

    if (settings.logCoverage && !coverageLogged) {
      coverageLogged = true;
      logCoverage(scene);
    }

    updateGovernor(frame);
    stats.workScale = workScale;

    ensureShared();
    ensureTargets(frame.width, frame.height);

    const cam = frame.camera;
    const tanY = Math.tan((settings.verticalFovDeg * PI) / 360);
    stampCounter += 1;
    fc = {
      stamp: stampCounter,
      right: cam.right,
      up: cam.up,
      forward: cam.forward,
      tanX: tanY * (frame.width / frame.height),
      tanY,
      width: frame.width,
      height: frame.height,
      time: frame.simTime % TIME_WRAP_S,
      simTime: frame.simTime,
      simSpeed: frame.simSpeed,
      paused: frame.paused,
      exposure: settings.exposure,
      near: settings.depthRange[0],
      far: settings.depthRange[1],
      camPos: cam.position,
    };

    buildKey(frame, scene);
    const reuse = keyValid && lastScene === scene && keysEqual();
    if (reuse) {
      stats.reusedScene = true;
    } else {
      renderScene(scene);
      lastBloom = renderBloom();
      lastKey.set(keyBuf);
      lastScene = scene;
      keyValid = true;
    }
    present(lastBloom);

    frameIndex += 1;
    if (frameIndex % 60 === 0) {
      evictStars();
      evictPlasma();
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  function restore(next?: WebGL2RenderingContext): void {
    if (disposed) return;
    if (bound) forgetGpuObjects();
    if (next !== undefined) {
      gl = next;
      bound = true;
    }
    if (bound) initContext();
  }

  function dispose(): void {
    if (disposed) return;
    if (bound) {
      for (const slot of slots.values()) {
        if (slot.kind === 'ready') {
          gl.deleteProgram(slot.entry.program);
        } else if (slot.kind === 'compiling') {
          gl.deleteShader(slot.vs);
          gl.deleteShader(slot.fs);
          gl.deleteProgram(slot.program);
        }
      }
      if (tgt !== null) deleteTargets(tgt);
      for (const g of starCache.values()) deleteGpuStars(g);
      for (const e of plasmaCache.values()) e.plasma.dispose(gl);
      if (bhState.target !== null) deleteColorTarget(bhState.target);
      if (fullscreenVao !== null) gl.deleteVertexArray(fullscreenVao);
      if (blackTex !== null) gl.deleteTexture(blackTex);
    }
    slots.clear();
    starCache.clear();
    plasmaCache.clear();
    bhState.target = null;
    bhState.valid = false;
    bhState.body = null;
    fullscreenVao = null;
    blackTex = null;
    tgt = null;
    lastBloom = null;
    lastScene = null;
    keyValid = false;
    bound = false;
    disposed = true;
  }

  function configure(patch: RendererSettingsPatch): void {
    const next = mergeDeep(settings, patch);
    validateSettings(next);
    settings = next;
    settingsRevision += 1;
  }

  function coverage(scene: RenderScene = EMPTY_SCENE): readonly PassReport[] {
    const has: Readonly<Record<ScenePass, boolean | null>> = {
      background: null,
      cosmicWeb: null,
      galaxy: (scene.galaxies?.length ?? 0) > 0,
      nebula: (scene.nebulae?.length ?? 0) > 0,
      stars: (scene.starFields ?? []).some((f) => f.count > 0),
      pulsar: (scene.pulsars?.length ?? 0) > 0,
      blackhole: (scene.blackHoles?.length ?? 0) > 0,
      planet: (scene.planets?.length ?? 0) > 0,
      rings: (scene.planets ?? []).some((p) => p.rings !== undefined),
      clouds: (scene.planets ?? []).some((p) => p.atmosphere?.clouds !== undefined),
      atmosphere: (scene.planets ?? []).some((p) => p.atmosphere !== undefined),
      aurora: (scene.planets ?? []).some((p) => p.atmosphere?.aurora !== undefined),
      bloom: null,
    };
    const reports: PassReport[] = [];
    for (const pass of Object.keys(PROGRAMS_OF) as ScenePass[]) {
      if (!settings.passes[pass]) {
        reports.push({ pass, status: 'disabled', detail: 'disabled in settings.passes' });
        continue;
      }
      if (has[pass] === false) {
        reports.push({ pass, status: 'no-scene-data', detail: 'the scene supplies no objects for this pass' });
        continue;
      }
      let status: PassReport['status'] = 'ready';
      let detail = 'ready';
      for (const name of PROGRAMS_OF[pass]) {
        const slot = slots.get(name);
        if (slot?.kind === 'failed') {
          status = 'program-failed';
          detail = slot.message;
          break;
        }
        if (slot?.kind === 'compiling') {
          status = 'program-pending';
          detail = `program "${name}" is still compiling`;
        }
      }
      reports.push({ pass, status, detail });
    }
    return reports;
  }

  return {
    render,
    restore,
    dispose,
    configure,
    get settings(): Readonly<RendererSettings> {
      return settings;
    },
    get stats(): Readonly<RenderStats> {
      return stats;
    },
    coverage,
  };
}
