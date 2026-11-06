/**
 * graphics/solar/solar.ts — explorable Solar System demo for the Universe Engine renderer. No GUI.
 *
 *   import { startSolar } from './solar/solar';
 *   const stop = startSolar(document.querySelector('canvas')!);   // size the canvas with CSS (100vw x 100vh)
 *
 * Data (nothing is downloaded)
 *   Orbits:       JPL "Keplerian Elements for Approximate Positions of the Major Planets", Table 1
 *                 (E.M. Standish, valid 1800-2050), solved for the real current date.
 *   Orientation:  IAU/NASA north-pole RA/Dec and prime-meridian W0 + rate for the Sun, planets and Moon
 *                 (Archinal et al. 2018), so every spin axis and the rotation phase are physical.
 *   Radii:        NASA Planetary Fact Sheet volumetric mean radii (spheres, so no oblateness).
 *   Moon:         Meeus mean elements. Galilean moons: Meeus low-accuracy mean longitudes (phases approximate).
 *   Surfaces:     flat albedo tints unless maps exist. Maps in
 *                 ./textures/solar/ they are picked up automatically: <name>.jpg for sun-lit bodies
 *                 (mercury venus earth moon mars jupiter saturn uranus neptune io europa ganymede callisto)
 *                 plus earth_night.jpg, earth_clouds.jpg, earth_specular.jpg, earth_height.jpg.
 *   High-res tier: 4096x2048 maps in ./textures/solar/hi/ (<name>.jpg, plus earth_night / earth_clouds / earth_specular / earth_height) stream in when the
 *                 camera is within HI_ENTER radii of a body and are freed again beyond HI_LEAVE. The Sun has them too:
 *                 sun.jpg (photosphere) and sun_flare.jpg (plasma filaments for prominences and flares), in both tiers
 *                 (procedurally generated); the shader still adds procedural sub-texel detail. ./textures/solar/hi/saturn_rings.png replaces
 *                 the procedural ring strip as soon as it loads.
 *   Stars:        8000 procedural placeholder stars (no catalogue ships with the engine).
 *
 * Controls
 *   Click the canvas (mouse look; dragging with the left button also works)
 *   W A S D move, Space / C up / down, Q / E roll, Shift = x6, mouse wheel = speed multiplier.
 *   Speed scales with altitude above the nearest body, so one key press covers Earth orbit or Neptune.
 *   0 = Sun, 1..8 = Mercury..Neptune, 9 = Moon: jump to a lit view of that body.
 *   , and . = time /4 and x4, / = real time, P = pause.
 *
 * Floating origin: every position handed to the renderer is relative to the body you are closest to, so
 * the world co-moves with it. Orbital motion never reads as camera motion (no false blur, no history
 * smearing) and float precision stays millimetre-level at any altitude.
 */

import { makePos, Tier, type WorldPos } from '../../packages/core/src/coords';
import {
  EARTH_ATMOSPHERE,
  Renderer,
  type Atmosphere,
  type BodyObj,
  type BodyTextures,
  type Camera,
  type RingObj,
  type Scene,
  type SceneObject,
  type StarObj,
  type SceneLight,
} from '../renderer';

type V3 = [number, number, number];

const AU = 1.495978707e11;
const D2R = Math.PI / 180;
const OBLIQUITY = 23.4392911 * D2R; // J2000 mean obliquity

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

/** Rotate v about unit axis k by angle a (Rodrigues). */
function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

// ------------------------------------------------------------------ frames
// World axes: +Y is ecliptic north, the ecliptic is the XZ plane. Ecliptic (x, y, z) -> world (x, z, -y).
const eclToWorld = (v: V3): V3 => [v[0], v[2], -v[1]];
const eqToEcl = (v: V3): V3 => [v[0], v[1] * Math.cos(OBLIQUITY) + v[2] * Math.sin(OBLIQUITY), -v[1] * Math.sin(OBLIQUITY) + v[2] * Math.cos(OBLIQUITY)];
const eqToWorld = (v: V3): V3 => eclToWorld(eqToEcl(v));

/** North pole direction from IAU right ascension / declination (degrees, ICRF). */
function poleOf(ra: number, dec: number): V3 {
  return unit(eqToWorld([Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)]));
}
/** Ascending node of the body's equator on the ICRF equator: the zero point of the IAU prime-meridian angle W. */
function nodeOf(ra: number): V3 {
  return unit(eqToWorld([-Math.sin(ra * D2R), Math.cos(ra * D2R), 0]));
}

// ------------------------------------------------------------------ orbits
interface Elements {
  a: number; da: number; e: number; de: number; I: number; dI: number;
  L: number; dL: number; w: number; dw: number; N: number; dN: number;
}
const el = (a: number, da: number, e: number, de: number, I: number, dI: number, L: number, dL: number, w: number, dw: number, N: number, dN: number): Elements =>
  ({ a, da, e, de, I, dI, L, dL, w, dw, N, dN });

// JPL Table 1 (1800 AD - 2050 AD): a [au], e, I [deg], L [deg], long.peri [deg], long.node [deg] and their rates per Julian century.
const ELEMENTS = {
  mercury: el(0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081),
  venus: el(0.72333566, 0.0000039, 0.00677672, -0.00004107, 3.39467605, -0.0007889, 181.9790995, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418),
  emb: el(1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0),
  mars: el(1.52371034, 0.00001847, 0.0933941, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343),
  jupiter: el(5.202887, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106),
  saturn: el(9.53667594, -0.0012506, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794),
  uranus: el(19.18916464, -0.00196176, 0.04725744, -0.00004397, 0.77263783, -0.00242939, 313.23810451, 428.48202785, 170.9542763, 0.40805281, 74.01692503, 0.04240589),
  neptune: el(30.06992276, 0.00026291, 0.00859048, 0.00005105, 1.77004347, 0.00035372, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -0.00508664),
} as const;

/** Heliocentric position in world axes, metres. */
function keplerPos(k: Elements, T: number): V3 {
  const a = (k.a + k.da * T) * AU;
  const e = k.e + k.de * T;
  const I = (k.I + k.dI * T) * D2R;
  const L = k.L + k.dL * T;
  const w = k.w + k.dw * T;
  const N = (k.N + k.dN * T) * D2R;
  const M = (((L - w) % 360) + 540) % 360 - 180;
  const Mr = M * D2R;
  let E = Mr + e * Math.sin(Mr);
  for (let i = 0; i < 10; i++) E -= (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const om = w * D2R - N;
  const co = Math.cos(om), so = Math.sin(om), cN = Math.cos(N), sN = Math.sin(N), cI = Math.cos(I), sI = Math.sin(I);
  return eclToWorld([
    (co * cN - so * sN * cI) * xp + (-so * cN - co * sN * cI) * yp,
    (co * sN + so * cN * cI) * xp + (-so * sN + co * cN * cI) * yp,
    so * sI * xp + co * sI * yp,
  ]);
}

/** Moon relative to Earth (Meeus mean elements, circular), world axes, metres. */
function moonOffset(T: number): V3 {
  const Lm = (218.3164477 + 481267.88123421 * T) * D2R;
  const Om = (125.0445479 - 1934.1362891 * T) * D2R;
  const inc = 5.145396 * D2R;
  const u = Lm - Om;
  const r = 3.84399e8;
  return eclToWorld([
    r * (Math.cos(Om) * Math.cos(u) - Math.sin(Om) * Math.sin(u) * Math.cos(inc)),
    r * (Math.sin(Om) * Math.cos(u) + Math.cos(Om) * Math.sin(u) * Math.cos(inc)),
    r * Math.sin(u) * Math.sin(inc),
  ]);
}

// ------------------------------------------------------------------ bodies
const earthMoonMassFrac = 1 / (1 + 81.30057); // Moon / (Earth + Moon): Earth orbits the barycentre

const venusAtm: Atmosphere = { height: 6e4, betaR: [1.2e-5, 1.0e-5, 0.6e-5], betaM: 4e-5, hR: 15000, hM: 15000, g: 0.8 };
const marsAtm: Atmosphere = { height: 4e4, betaR: [0.6e-6, 1.4e-6, 3.3e-6], betaM: 3e-6, hR: 11000, hM: 11000, g: 0.75 };
const jovianAtm: Atmosphere = { height: 4e5, betaR: [4e-6, 8e-6, 1.6e-5], betaM: 1e-7, hR: 27000, hM: 10000, g: 0.7 };
const uranusAtm: Atmosphere = { height: 3e5, betaR: [1e-6, 8e-6, 2.4e-5], betaM: 1e-7, hR: 27000, hM: 10000, g: 0.7 };
const neptuneAtm: Atmosphere = { height: 3e5, betaR: [0.5e-6, 6e-6, 3e-5], betaM: 1e-7, hR: 20000, hM: 10000, g: 0.7 };

interface Def {
  name: string;
  /** Volumetric mean radius, metres. */
  radius: number;
  tint: V3;
  atm?: Atmosphere;
  /** IAU north pole (RA, Dec) and prime meridian W0 [deg], rate [deg/day]. */
  ra: number; dec: number; w0: number; wRate: number;
  /** Position relative to the parent (or the Sun), world axes, metres. */
  at: (T: number, d: number, parent: V3, bodies: Map<string, V3>) => V3;
  parent?: string;
}

/** Meeus low-accuracy mean longitudes of the Galilean moons, in the plane of Jupiter's equator from its node. */
function galilean(l0: number, n: number, a: number): Def['at'] {
  return (_T, d, _p, bodies) => {
    const S = poleOf(268.056595, 64.495303);
    const Q = nodeOf(268.056595);
    const th = (l0 + n * d) * D2R;
    const jup = bodies.get('jupiter') ?? [0, 0, 0];
    return add(jup, add(mul(Q, a * Math.cos(th)), mul(cross(S, Q), a * Math.sin(th))));
  };
}

const DEFS: Def[] = [
  { name: 'sun', radius: 6.957e8, tint: [1, 1, 1], ra: 286.13, dec: 63.87, w0: 84.176, wRate: 14.184, at: () => [0, 0, 0] },
  { name: 'mercury', radius: 2.4397e6, tint: [0.14, 0.135, 0.13], ra: 281.0103, dec: 61.4155, w0: 329.5988, wRate: 6.1385108, at: (T) => keplerPos(ELEMENTS.mercury, T) },
  { name: 'venus', radius: 6.0518e6, tint: [0.78, 0.7, 0.5], atm: venusAtm, ra: 272.76, dec: 67.16, w0: 160.2, wRate: -1.4813688, at: (T) => keplerPos(ELEMENTS.venus, T) },
  { name: 'earth', radius: 6.371e6, tint: [0.12, 0.25, 0.42], atm: EARTH_ATMOSPHERE, ra: 0, dec: 90, w0: 190.147, wRate: 360.9856235, at: (T) => sub(keplerPos(ELEMENTS.emb, T), mul(moonOffset(T), earthMoonMassFrac)) },
  { name: 'moon', radius: 1.7374e6, tint: [0.12, 0.115, 0.11], ra: 269.9949, dec: 66.5392, w0: 38.3213, wRate: 13.17635815, parent: 'earth', at: (T, _d, _p, b) => add(b.get('earth') ?? [0, 0, 0], moonOffset(T)) },
  { name: 'mars', radius: 3.3895e6, tint: [0.45, 0.22, 0.12], atm: marsAtm, ra: 317.68143, dec: 52.8865, w0: 176.63, wRate: 350.89198226, at: (T) => keplerPos(ELEMENTS.mars, T) },
  { name: 'jupiter', radius: 6.9911e7, tint: [0.62, 0.54, 0.42], atm: jovianAtm, ra: 268.056595, dec: 64.495303, w0: 284.95, wRate: 870.536, at: (T) => keplerPos(ELEMENTS.jupiter, T) },
  { name: 'io', radius: 1.8216e6, tint: [0.8, 0.65, 0.3], ra: 268.05, dec: 64.5, w0: 200, wRate: 203.4889538, parent: 'jupiter', at: galilean(106.07719, 203.488955790, 4.218e8) },
  { name: 'europa', radius: 1.5608e6, tint: [0.75, 0.7, 0.62], ra: 268.08, dec: 64.51, w0: 36, wRate: 101.3747235, parent: 'jupiter', at: galilean(175.73161, 101.374724735, 6.711e8) },
  { name: 'ganymede', radius: 2.6341e6, tint: [0.45, 0.42, 0.38], ra: 268.2, dec: 64.57, w0: 44, wRate: 50.3176081, parent: 'jupiter', at: galilean(120.55883, 50.317609207, 1.0704e9) },
  { name: 'callisto', radius: 2.4103e6, tint: [0.3, 0.27, 0.24], ra: 268.72, dec: 64.83, w0: 259, wRate: 21.5710715, parent: 'jupiter', at: galilean(84.44459, 21.571071177, 1.8827e9) },
  { name: 'saturn', radius: 5.8232e7, tint: [0.75, 0.65, 0.45], atm: jovianAtm, ra: 40.589, dec: 83.537, w0: 38.9, wRate: 810.7939024, at: (T) => keplerPos(ELEMENTS.saturn, T) },
  { name: 'uranus', radius: 2.5362e7, tint: [0.55, 0.75, 0.8], atm: uranusAtm, ra: 257.311, dec: -15.175, w0: 203.81, wRate: -501.1600928, at: (T) => keplerPos(ELEMENTS.uranus, T) },
  { name: 'neptune', radius: 2.4622e7, tint: [0.25, 0.4, 0.8], atm: neptuneAtm, ra: 299.36, dec: 43.46, w0: 253.18, wRate: 536.3128492, at: (T) => keplerPos(ELEMENTS.neptune, T) },
];

/** Bodies with a stylised live surface: Earth's clouds drift, Venus and the giants' bands flow in zonal jets. */
const LIVE = new Set(['earth', 'venus', 'jupiter', 'saturn', 'uranus', 'neptune']);

/** 4096x2048 maps in ./textures/solar/hi/ that replace the base maps while the camera is close (see updateHiRes). */
const HI_RES: Record<string, { albedo: string; night?: string; clouds?: string; mask?: string; height?: string; flare?: string }> = {
  sun: { albedo: 'sun', flare: 'sun_flare' },
  mercury: { albedo: 'mercury' },
  venus: { albedo: 'venus' },
  earth: { albedo: 'earth', night: 'earth_night', clouds: 'earth_clouds', mask: 'earth_specular', height: 'earth_height' },
  moon: { albedo: 'moon' },
  mars: { albedo: 'mars' },
  jupiter: { albedo: 'jupiter' },
  saturn: { albedo: 'saturn' },
  uranus: { albedo: 'uranus' },
  neptune: { albedo: 'neptune' },
  io: { albedo: 'io' },
  europa: { albedo: 'europa' },
  ganymede: { albedo: 'ganymede' },
  callisto: { albedo: 'callisto' },
};
/** Great Red Spot in each Jupiter albedo map: [u, v, latitude half-extent (rad), peak swirl angle (rad)]. Approximate, read off the maps. */
const GRS_BASE: [number, number, number, number] = [0.2493, 0.645, 0.2, 0.6];
const GRS_HI: [number, number, number, number] = [0.351, 0.62, 0.16, 0.6];
/** Start streaming a body's hi-res maps inside this many body radii from its centre. */
const HI_ENTER = 8;
/** Free them again beyond this many radii (hysteresis, so hovering at the boundary does not thrash). */
const HI_LEAVE = 14;
/** Never hold more than this many bodies' hi-res maps on the GPU (about 45 MB per 4K map, Earth has three). */
const HI_MAX = 2;

/**
 * Close-up surface detail per body (see BodyObj.detail): once the camera is nearer than a map texel, procedural detail keeps adding
 * sharp structure instead of the map just stretching. albedo = brightness variation, relief = lit micro-relief, bands = stretch along latitude.
 */
const DETAIL: Record<string, { albedo: number; relief: number; bands?: number }> = {
  mercury: { albedo: 0.38, relief: 0.1 },
  venus: { albedo: 0.1, relief: 0, bands: 3 },
  earth: { albedo: 0.22, relief: 0.035 },
  moon: { albedo: 0.4, relief: 0.1 },
  mars: { albedo: 0.3, relief: 0.07 },
  jupiter: { albedo: 0.16, relief: 0, bands: 6 },
  saturn: { albedo: 0.12, relief: 0, bands: 6 },
  uranus: { albedo: 0.04, relief: 0, bands: 3 },
  neptune: { albedo: 0.07, relief: 0, bands: 4 },
  io: { albedo: 0.25, relief: 0.05 },
  europa: { albedo: 0.18, relief: 0.03 },
  ganymede: { albedo: 0.3, relief: 0.07 },
  callisto: { albedo: 0.35, relief: 0.1 },
};

/** Key 0..9 -> body name. */
const HOTKEYS = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon'];

// ------------------------------------------------------------------ procedural assets
/** Saturn's ring profile (C, B, Cassini Division, A, Encke and Keeler gaps) from the published ring radii, as a 1-D RGBA strip. */
function makeRingTexture(gl: WebGL2RenderingContext, innerKm: number, outerKm: number): WebGLTexture {
  const n = 2048;
  const px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = innerKm + ((outerKm - innerKm) * (i + 0.5)) / n;
    const rip = 0.85 + 0.15 * Math.sin(r * 0.011 + Math.sin(r * 0.0031) * 3);
    let a = 0;
    let c: V3 = [200, 180, 150];
    if (r < 91975) { a = 0.2 * rip; c = [150, 135, 120]; }
    else if (r < 117507) { a = Math.min(0.92, 0.55 + (r - 91975) / 25000) * rip; c = [214, 190, 155]; }
    else if (r < 122053) { a = 0.06; c = [170, 155, 135]; }
    else {
      a = 0.62 * rip;
      c = [205, 185, 155];
      if (Math.abs(r - 133589) < 165 || Math.abs(r - 136505) < 18) a = 0.05;
    }
    px.set([c[0], c[1], c[2], Math.round(clamp(a, 0, 1) * 255)], i * 4);
  }
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

async function tryLoad(r: Renderer, url: string, srgb: boolean, clamp = false): Promise<WebGLTexture | null> {
  try {
    return await r.loadTexture(url, { srgb, clamp });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the demo
export function startSolar(canvas: HTMLCanvasElement): () => void {
  const renderer = new Renderer(canvas, { dynamicResolution: true, renderScale: 1, motionBlur: 0.5, temporalUpscale: true, lensFlare: 1 });
  
  const startMs = Date.now();

  // ---- scene objects, created once; positions and rotations are updated every frame
  const bodyObjs = new Map<string, SceneObject>();
  const sunObj: StarObj = {
    kind: 'star', pos: makePos(Tier.Planet, [0, 0, 0], [0, 0, 0]), radius: 6.957e8, lum: 1, temp: 5772,
    spin: poleOf(286.13, 63.87), spots: 0.5, cell: 22, seed: 0.37, activity: 1,
  };
  bodyObjs.set('sun', sunObj);
  const objects: SceneObject[] = [sunObj];
  for (const d of DEFS) {
    if (d.name === 'sun') continue;
    const b: BodyObj = { kind: 'body', lightId: 'solar:sun', pos: sunObj.pos, radius: d.radius, spin: poleOf(d.ra, d.dec), rot: 0, tint: d.tint, lum: 0 };
    if (d.atm) b.atmosphere = d.atm;
    if (LIVE.has(d.name)) b.flow = 1;
    if (d.name === 'mars') b.storm = 1; // procedural dust storms
    if (d.name === 'jupiter') b.vortex = GRS_BASE; // swirling, drifting Great Red Spot
    if (d.name === 'earth') b.bump = 9000;
    const dtl = DETAIL[d.name];
    if (dtl) b.detail = dtl;
    bodyObjs.set(d.name, b);
    objects.push(b);
  }
  const satDef = DEFS.find((d) => d.name === 'saturn');
  const saturn = bodyObjs.get('saturn') as BodyObj;
  const ring: RingObj = {
    kind: 'ring', lightId: 'solar:sun', pos: sunObj.pos, radius: satDef?.radius ?? 5.8232e7, normal: saturn.spin,
    inner: 74658e3 / (satDef?.radius ?? 5.8232e7), outer: 136775e3 / (satDef?.radius ?? 5.8232e7),
    tex: makeRingTexture(renderer.gl, 74658, 136775),
  };
  objects.push(ring);
  const solarLight: SceneLight = {
    id: 'solar:sun',
    pos: sunObj.pos,
    lum: 1,
    temp: 5772,
    radius: 6.957e8,
  };

  const scene: Scene = {
    time: 0,
    lights: [solarLight],
    objects,
  };

  // Saturn's ring: the Cassini-based strip in ./textures/solar/hi/ (about 16 km/texel) replaces the procedural one when it loads.
  void (async () => {
    const t = await tryLoad(renderer, 'textures/solar/hi/saturn_rings.png', true, true);
    if (!t) return;
    const old = ring.tex;
    ring.tex = t;
    if (old) renderer.gl.deleteTexture(old);
  })();

  // ---- texture tiers. The base maps in ./textures/solar/ load once. The 4096x2048 maps in ./textures/solar/hi/ stream in for the
  // nearest HI_MAX bodies when the camera is close and are deleted again when it leaves.
  const baseTex = new Map<string, BodyTextures>();
  const hiTex = new Map<string, BodyTextures>();
  const hiState = new Map<string, 'loading' | 'ready' | 'failed'>();
  const hiWanted = new Set<string>();
  const maxTexSize = renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE) as number;

  /** Base maps with whatever hi-res maps are resident layered on top (mask and height stay at base resolution). */
  const applyTex = (name: string): void => {
    const o = bodyObjs.get(name);
    if (!o || (o.kind !== 'body' && o.kind !== 'star')) return;
    const merged: BodyTextures = { ...baseTex.get(name), ...hiTex.get(name) };
    if (Object.keys(merged).length > 0) o.tex = merged;
    else delete o.tex;
    if (name === 'jupiter' && o.kind === 'body') o.vortex = hiTex.get(name)?.albedo ? GRS_HI : GRS_BASE; // the spot sits elsewhere in the 4K map
  };
  const freeSet = (s: BodyTextures): void => {
    for (const t of [s.albedo, s.night, s.clouds, s.mask, s.height, s.flare]) if (t) renderer.gl.deleteTexture(t);
  };
  const loadHi = async (name: string): Promise<void> => {
    const spec = HI_RES[name];
    if (!spec || maxTexSize < 4096) {
      hiState.set(name, 'failed');
      return;
    }
    hiState.set(name, 'loading');
    const set: BodyTextures = {};
    const albedo = await tryLoad(renderer, `textures/solar/hi/${spec.albedo}.jpg`, true);
    if (albedo) set.albedo = albedo;
    if (spec.night) {
      const t = await tryLoad(renderer, `textures/solar/hi/${spec.night}.jpg`, true);
      if (t) set.night = t;
    }
    if (spec.clouds) {
      const t = await tryLoad(renderer, `textures/solar/hi/${spec.clouds}.jpg`, false);
      if (t) set.clouds = t;
    }
    if (spec.mask) {
      const t = await tryLoad(renderer, `textures/solar/hi/${spec.mask}.jpg`, false);
      if (t) set.mask = t;
    }
    if (spec.height) {
      const t = await tryLoad(renderer, `textures/solar/hi/${spec.height}.jpg`, false);
      if (t) set.height = t;
    }
    if (spec.flare) {
      const t = await tryLoad(renderer, `textures/solar/hi/${spec.flare}.jpg`, false);
      if (t) set.flare = t;
    }
    if (Object.keys(set).length === 0) {
      hiState.set(name, 'failed'); // files missing: do not retry every frame
      return;
    }
    if (!hiWanted.has(name)) {
      freeSet(set); // the camera left while it was loading
      hiState.delete(name);
      return;
    }
    hiTex.set(name, set);
    hiState.set(name, 'ready');
    applyTex(name);
  };
  const freeHi = (name: string): void => {
    const set = hiTex.get(name);
    hiTex.delete(name);
    hiState.delete(name);
    applyTex(name); // back to the base maps before the big ones are deleted
    if (set) freeSet(set);
  };
  const updateHiRes = (cam: V3): void => {
    const near: { name: string; r: number }[] = [];
    for (const def of DEFS) {
      if (!HI_RES[def.name] || hiState.get(def.name) === 'failed') continue;
      const r = len(sub(cam, helio.get(def.name) ?? [0, 0, 0])) / def.radius;
      if (r < HI_ENTER || (hiState.has(def.name) && r < HI_LEAVE)) near.push({ name: def.name, r });
    }
    near.sort((a, b) => a.r - b.r);
    hiWanted.clear();
    for (const n of near.slice(0, HI_MAX)) hiWanted.add(n.name);
    for (const name of hiWanted) if (!hiState.has(name)) void loadHi(name);
    for (const [name, st] of hiState) if (st === 'ready' && !hiWanted.has(name)) freeHi(name);
  };

  // optional maps from ./textures/solar/
  void (async () => {
    for (const d of DEFS) {
      const o = bodyObjs.get(d.name);
      if (!o || (o.kind !== 'body' && o.kind !== 'star')) continue;
      const t: BodyTextures = {};
      const albedo = await tryLoad(renderer, `textures/solar/${d.name}.jpg`, true);
      if (albedo) t.albedo = albedo;
      if (d.name === 'sun') {
        const flare = await tryLoad(renderer, 'textures/solar/sun_flare.jpg', false);
        if (flare) t.flare = flare;
      }
      if (d.name === 'earth') {
        const night = await tryLoad(renderer, 'textures/solar/earth_night.jpg', true);
        const clouds = await tryLoad(renderer, 'textures/solar/earth_clouds.jpg', false);
        const mask = await tryLoad(renderer, 'textures/solar/earth_specular.jpg', false);
        const height = await tryLoad(renderer, 'textures/solar/earth_height.jpg', false);
        if (night) t.night = night;
        if (clouds) t.clouds = clouds;
        if (mask) t.mask = mask;
        if (height) t.height = height;
      }
      if (Object.keys(t).length > 0) {
        baseTex.set(d.name, t);
        applyTex(d.name);
      }
    }
  })();

  // ---- state
  const helio = new Map<string, V3>();
  let simSeconds = 0;
  let rate = 1;
  let savedRate = 1;
  let anchor = 'sun';
  let camOff: V3 = [0, 3.0e9, 2.2e11]; // relative to the anchor, metres
  let fwd: V3 = [0, -0.01, -1];
  let up: V3 = [0, 1, 0];
  let right: V3 = unit(cross(fwd, up));
  const vel: V3 = [0, 0, 0];
  let speedMul = 1;
  const keys = new Set<string>();
  let dragging = false;
  let last = performance.now();
  let raf = 0;

  const frameState = (): { jd: number; T: number; d: number } => {
    const jd = 2440587.5 + (startMs + simSeconds * 1000) / 86400000;
    return { jd, T: (jd - 2451545) / 36525, d: jd - 2451545 };
  };

  const updateEphemeris = (): void => {
    const { T, d } = frameState();
    for (const def of DEFS) helio.set(def.name, def.at(T, d, [0, 0, 0], helio));
  };

  const orient = (): void => {
    const { d } = frameState();
    for (const def of DEFS) {
      const o = bodyObjs.get(def.name);
      if (!o || o.kind !== 'body') continue;
      const S = poleOf(def.ra, def.dec);
      const Q = nodeOf(def.ra);
      const U = unit(cross(S, Math.abs(S[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
      const V = cross(S, U);
      const phiQ = Math.atan2(dot(Q, V), dot(Q, U));
      o.rot = (((phiQ + (def.w0 + def.wRate * d) * D2R) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    }
  };

  const camHelio = (): V3 => add(helio.get(anchor) ?? [0, 0, 0], camOff);

  const setAnchor = (name: string, off: V3): void => {
    anchor = name;
    camOff = off;
    vel.fill(0);
    renderer.resetTemporal();
  };

  const radiusOf = (name: string): number => DEFS.find((d) => d.name === name)?.radius ?? 1;

  const jump = (name: string): void => {
    const p = helio.get(name) ?? [0, 0, 0];
    const toSun = len(p) > 1 ? unit(mul(p, -1)) : unit([0.3, 0.25, 1]);
    const off = mul(unit(add(toSun, [0, 0.25, 0])), radiusOf(name) * (name === 'sun' ? 5 : 4));
    fwd = unit(mul(off, -1));
    right = unit(cross(fwd, [0, 1, 0]));
    up = cross(right, fwd);
    setAnchor(name, off);
  };

  // ---- input
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    const digit = /^Digit(\d)$/.exec(e.code);
    if (digit) jump(HOTKEYS[Number(digit[1])] ?? 'sun');
    else if (e.code === 'Period') rate = rate === 0 ? savedRate * 4 : rate * 4;
    else if (e.code === 'Comma') rate = rate === 0 ? savedRate / 4 : rate / 4;
    else if (e.code === 'Slash') rate = 1;
    else if (e.code === 'KeyP') {
      if (rate === 0) rate = savedRate;
      else {
        savedRate = rate;
        rate = 0;
      }
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => void keys.delete(e.code);
  const look = (dx: number, dy: number): void => {
    const yaw = -dx * 0.0022;
    const pitch = -dy * 0.0022;
    fwd = unit(rotate(fwd, up, yaw));
    right = unit(rotate(right, up, yaw));
    fwd = unit(rotate(fwd, right, pitch));
    up = unit(cross(right, fwd));
    right = unit(cross(fwd, up));
  };
  const onMove = (e: MouseEvent): void => {
    if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY);
  };
  const onDown = (e: MouseEvent): void => {
    if (e.button === 0) dragging = true;
  };
  const onUp = (): void => {
    dragging = false;
  };
  const onClick = (): void => {
    Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    speedMul = clamp(speedMul * Math.exp(-e.deltaY * 0.001), 1 / 64, 64);
  };
  const onResize = (): void => renderer.resize();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  window.addEventListener('resize', onResize);
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ---- frame
  updateEphemeris();
  jump('earth');

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    simSeconds += dt * rate;
    updateEphemeris();
    orient();

    // floating origin: re-anchor to the body that looks biggest from here, with hysteresis
    const ch = camHelio();
    let best = anchor;
    let bestScore = Infinity;
    let curScore = Infinity;
    let alt = Infinity;
    for (const def of DEFS) {
      const dist = len(sub(ch, helio.get(def.name) ?? [0, 0, 0]));
      const score = dist / def.radius;
      alt = Math.min(alt, dist - def.radius);
      if (score < bestScore) {
        bestScore = score;
        best = def.name;
      }
      if (def.name === anchor) curScore = score;
    }
    if (best !== anchor && bestScore * 1.25 < curScore) {
      setAnchor(best, sub(ch, helio.get(best) ?? [0, 0, 0]));
    }

    // the rings count as a surface too: speed shrinks as you approach the ring plane, so you can drift down to particle scale
    {
      const rel = sub(ch, helio.get('saturn') ?? [0, 0, 0]);
      const h = Math.abs(dot(rel, [saturn.spin[0], saturn.spin[1], saturn.spin[2]]));
      const rr = Math.sqrt(Math.max(dot(rel, rel) - h * h, 0));
      if (rr > ring.inner * ring.radius && rr < ring.outer * ring.radius) alt = Math.min(alt, h);
    }

    // movement: speed follows altitude above the nearest surface
    const dirIn: V3 = [0, 0, 0];
    const k = (c: string): number => (keys.has(c) ? 1 : 0);
    const f = k('KeyW') - k('KeyS');
    const s = k('KeyD') - k('KeyA');
    const u = k('Space') - k('KeyC');
    const mv = add(add(mul(fwd, f), mul(right, s)), mul(up, u));
    if (len(mv) > 0) dirIn.splice(0, 3, ...unit(mv));
    const speed = Math.max(alt, 1) * 0.9 * speedMul * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 6 : 1);
    const a = 1 - Math.exp(-dt / 0.15);
    for (let i = 0; i < 3; i++) vel[i] = (vel[i] as number) + ((dirIn[i] as number) * speed - (vel[i] as number)) * a;
    camOff = add(camOff, mul(vel, dt));
    const roll = (k('KeyE') - k('KeyQ')) * 1.2 * dt;
    if (roll !== 0) {
      right = unit(rotate(right, fwd, roll));
      up = unit(cross(right, fwd));
    }
    // keep the camera out of the ground
    const c2 = camHelio();
    for (const def of DEFS) {
      const p = helio.get(def.name) ?? [0, 0, 0];
      const off = sub(c2, p);
      const dist = len(off);
      if (dist < def.radius + 2) camOff = add(camOff, mul(unit(off), def.radius + 2 - dist));
    }

    updateHiRes(camHelio());

    // hand everything to the renderer relative to the anchor
    const origin = helio.get(anchor) ?? [0, 0, 0];
    const at = (p: V3): WorldPos => makePos(Tier.Planet, [0, 0, 0], sub(p, origin));
    for (const def of DEFS) {
      const o = bodyObjs.get(def.name);
      if (o) o.pos = at(helio.get(def.name) ?? [0, 0, 0]);
    }
    ring.pos = saturn.pos;
    solarLight.pos = sunObj.pos;
    scene.time = simSeconds;
    const cam: Camera = { pos: makePos(Tier.Planet, [0, 0, 0], camOff), right, up, forward: fwd, fovY: (60 * Math.PI) / 180 };
    renderer.render(scene, cam, dt);
  };
  raf = requestAnimationFrame(frame);

  return (): void => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.removeEventListener('resize', onResize);
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('click', onClick);
    canvas.removeEventListener('wheel', onWheel);
    renderer.dispose();
  };
}
