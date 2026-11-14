/**
 * graphics/shaders.ts  (GLSL ES 3.00 / WebGL2). Shader SOURCE ONLY: no WebGL calls, no scene logic.
 * renderer.ts compiles these; every program is a plain {vertex, fragment} pair.
 *
 * CONVENTIONS (all programs)
 *  - Positions are CAMERA-RELATIVE METERS, produced on the CPU from coords.ts (deltaInto) in float64.
 *  - Camera uniforms: uCamRight/uCamUp/uCamForward (unit), uTanHalfFov (x = tanY*aspect, y = tanY),
 *    uResolution (px of the CURRENT target), uTime (wrap on CPU to < 1e5 s), uDepthRange (near, far m).
 *  - PRE-EXPOSURE: every scene pass multiplies its output by uExposure, so HDR targets (RGBA16F) hold
 *    values near 1. Tonemap applies only uPostExposure on top. Outputs are NaN/overflow-safe.
 *  - Radiance units are physical (W m^-2 sr^-1); illuminants (uSunColor) carry W m^-2.
 *  - Depth: reversed logarithmic. gl.depthFunc(GREATER), clearDepth(0). Only planet + rings write it.
 *  - Fullscreen programs: drawArrays(TRIANGLES, 0, 3) with an empty VAO, no buffers.
 *  - Closest-approach math (s = t - tc) keeps float32 exact even when a body is 1e20 m away.
 *  - Draw far to near: background, cosmicWeb, galaxy, nebula, stars, pulsar, blackhole, planet, rings,
 *    clouds, atmosphere, aurora, then bloomDown/bloomUp, tonemap.
 *  - blackhole reads uSceneColor (needs mipmaps) + uHistory and writes a full frame: ping-pong HDR targets.
 *  - Black hole: Kerr geodesics (uKerr=1) or fast Schwarzschild; disk kinematics are approximate.
 */

export type ShaderName =
  | 'background' | 'stars' | 'blackhole' | 'nebula' | 'galaxy' | 'cosmicWeb' | 'pulsar'
  | 'planet' | 'atmosphere' | 'clouds' | 'aurora' | 'rings'
  | 'bloomDown' | 'bloomUp' | 'tonemap' | 'copy';

export interface ShaderSource {
  readonly name: ShaderName;
  readonly vertex: string;
  readonly fragment: string;
  /** none = replace, add = (ONE, ONE), over = premultiplied (ONE, ONE_MINUS_SRC_ALPHA). */
  readonly blend: 'none' | 'add' | 'over';
  readonly writesDepth: boolean;
  readonly readsScene: boolean;
}

/** Fixed attribute locations of the stars program (layout(location = N) in the shader). */
export const ATTRIBUTES = { position: 0, luminosity: 1, temperature: 2, radius: 3 } as const;

/**
 * PLASMA CONTRACT (physics.ts -> blackhole shader). Optional: with uPlasmaMix = 0 the disk keeps its flat,
 * realistic procedural look; physics.ts only ADDS realism on top.
 * Texture: RGBA16F, LINEAR + mipmaps, wrap S = CLAMP, wrap T = REPEAT. Written in the disk's non-rotating frame
 * for the time it was built (physics advects it). Between rebuilds the shader rotates the lookup by the local
 * Keplerian rate times uPlasmaAge (R_g / c since the build), so the plasma orbits smoothly at any simulation speed.
 *   u = ln(r / rIn) / ln(rOut / rIn)      r in R_g, rIn = diskInnerRg > 0 ? diskInnerRg : iscoRadiusRg(spin)
 *   v = azimuth / TAU + 0.5               azimuth = atan2(y, x) in the frame whose z axis is the spin axis
 *   R = density / mean density (clumps, spiral arms, gaps; ~1 average)
 *   G = temperature / Novikov-Thorne temperature (~1; MRI heating, shocks)
 *   B = hot-spot / flare emissivity (>= 0; magnetic reconnection, orbiting blobs)
 *   A = reserved (write 1)
 * Uniforms: uPlasma (sampler), uPlasmaMix (0..1), uPlasmaSize (texture size in texels), uPlasmaAge (R_g / c).
 */
export const PLASMA = {
  format: 'RGBA16F',
  channels: { r: 'density', g: 'temperature', b: 'hotspot', a: 'reserved' },
  mapping: 'u = ln(r/rIn)/ln(rOut/rIn); v = azimuth/TAU + 0.5',
  uniforms: ['uPlasma', 'uPlasmaMix', 'uPlasmaSize', 'uPlasmaAge'],
} as const;

/** ISCO radius in R_g (identical to the shader's), so physics.ts maps the plasma texture the same way. */
export function iscoRadiusRg(spin: number): number {
  const a = Math.min(Math.max(spin, 0), 0.998);
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

const glsl = (...parts: readonly string[]): string => parts.join('\n');
const VERT = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
const FRAG = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';

const FULLSCREEN_VS = glsl(VERT, `
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`);

const MATH = `
const float PI = 3.14159265358979;
const float TAU = 6.28318530717959;
const float C_LIGHT = 299792458.0;
const float SIGMA_SB = 5.670374419e-8;
const float HDR_MAX = 60000.0;
float safeLength(vec3 v) {
  float m = max(max(abs(v.x), abs(v.y)), abs(v.z));
  return m > 0.0 ? m * length(v / m) : 0.0;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float halfChord(vec3 m, float r) {
  float h2 = r * r - dot(m, m);
  return h2 >= 0.0 ? sqrt(h2) : -1.0;
}
float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseHG(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
float phaseMie(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}`;

const NOISE = `
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash13(i), b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0)), d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0)), g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0)), k = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
const mat3 FBM_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
float fbm(vec3 p, int octaves) {
  int n = max(octaves, 1);
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    s += a * noise3(p);
    p = FBM_ROT * p * 2.0 + 7.31;
    a *= 0.5;
  }
  return s / (1.0 - exp2(-float(n)));
}
float ridged(vec3 p, int octaves) {
  int n = max(octaves, 1);
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float v = 1.0 - abs(noise3(p) * 2.0 - 1.0);
    s += a * v * v;
    p = FBM_ROT * p * 2.0 + 3.17;
    a *= 0.5;
  }
  return s / (1.0 - exp2(-float(n)));
}
vec3 voronoi3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  float d1 = 9.0, d2 = 9.0, d3 = 9.0;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 r = g + hash33(i + g) - f;
        float d = dot(r, r);
        if (d < d1) { d3 = d2; d2 = d1; d1 = d; }
        else if (d < d2) { d3 = d2; d2 = d; }
        else if (d < d3) { d3 = d; }
      }
  return sqrt(vec3(d1, d2, d3));
}`;

const COLOR = `
// Planckian locus fit (Kim et al.), chromaticity only: linear sRGB with max component = 1.
vec3 blackbodyColor(float T) {
  T = clamp(T, 1667.0, 25000.0);
  float t = 1.0 / T, t2 = t * t, t3 = t2 * t;
  float x = T < 4000.0
    ? -0.2661239e9 * t3 - 0.2343589e6 * t2 + 0.8776956e3 * t + 0.179910
    : -3.0258469e9 * t3 + 2.1070379e6 * t2 + 0.2226347e3 * t + 0.240390;
  float x2 = x * x, x3 = x2 * x;
  float y;
  if (T < 2222.0) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
  else if (T < 4000.0) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
  vec3 xyz = vec3(x / y, 1.0, (1.0 - x - y) / y);
  vec3 rgb = vec3(
     3.2404542 * xyz.x - 1.5371385 * xyz.y - 0.4985314 * xyz.z,
    -0.9692660 * xyz.x + 1.8760108 * xyz.y + 0.0415560 * xyz.z,
     0.0556434 * xyz.x - 0.2040259 * xyz.y + 1.0572252 * xyz.z);
  rgb = max(rgb, vec3(0.0));
  return rgb / max(max(rgb.r, rgb.g), max(rgb.b, 1e-6));
}
// Bolometric blackbody radiance sigma*T^4/pi, ordered to avoid float32 overflow up to ~1e11 K.
float blackbodyRadiance(float T) { return (SIGMA_SB * T * T) * (T * T) / PI; }
vec3 srgbEncode(vec3 c) {
  c = clamp(c, vec3(0.0), vec3(1.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}`;

const CAMERA = `
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalfFov;
uniform vec2 uResolution;
uniform float uTime;
uniform float uExposure;
uniform vec2 uDepthRange;
vec3 viewRay(vec2 fragCoord) {
  vec2 ndc = fragCoord / uResolution * 2.0 - 1.0;
  return normalize(uCamForward + uCamRight * (ndc.x * uTanHalfFov.x) + uCamUp * (ndc.y * uTanHalfFov.y));
}
// Reversed logarithmic depth: 1 = near, 0 = far (use depthFunc GREATER, clear 0).
float logDepth01(float viewZ) {
  float d = log2(max(viewZ, uDepthRange.x) / uDepthRange.x) / log2(uDepthRange.y / uDepthRange.x);
  return clamp(1.0 - d, 0.0, 1.0);
}
vec3 hdrClamp(vec3 c) {
  if (any(isnan(c))) c = vec3(0.0);
  return clamp(c, vec3(0.0), vec3(HDR_MAX));
}
vec4 hdrOut(vec3 rgb, float a) { return vec4(hdrClamp(rgb * uExposure), a); }`;

const BODY = `
uniform vec3 uCenter;   // body centre, camera-relative metres
uniform float uRadius;  // metres`;

const ATMOS = `
uniform float uAtmoHeight;
uniform vec3 uBetaR;     // Rayleigh extinction, 1/m (Earth: 5.8e-6, 13.5e-6, 33.1e-6)
uniform float uBetaM;    // Mie extinction, 1/m (Earth: 21e-6)
uniform float uHR;       // Rayleigh scale height, m (Earth: 8000)
uniform float uHM;       // Mie scale height, m (Earth: 1200)
uniform float uMieG;     // Mie anisotropy (Earth: 0.76)
uniform vec3 uSunDir;    // unit vector from the body towards the star
uniform vec3 uSunColor;  // irradiance at the body, W/m^2 (colour included)
#define VIEW_STEPS 16
#define LIGHT_STEPS 6
// Optical depth (Rayleigh, Mie) from p (relative to centre) along L to space. false = planet shadow.
bool lightDepth(vec3 p, vec3 L, out vec2 od) {
  float tcL = -dot(p, L);
  vec3 mL = p + L * tcL;
  if (tcL > 0.0 && dot(mL, mL) < uRadius * uRadius) { od = vec2(0.0); return false; }
  float ra = uRadius + uAtmoHeight;
  float tEnd = tcL + sqrt(max(ra * ra - dot(mL, mL), 0.0));
  float ds = max(tEnd, 0.0) / float(LIGHT_STEPS);
  vec2 acc = vec2(0.0);
  for (int i = 0; i < LIGHT_STEPS; i++) {
    vec3 q = mL + L * ((float(i) + 0.5) * ds - tcL);
    float h = max(length(q) - uRadius, 0.0);
    acc += vec2(exp(-h / uHR), exp(-h / uHM)) * ds;
  }
  od = acc;
  return true;
}
vec3 transmittanceOf(vec2 od) { return exp(-(uBetaR * od.x + vec3(uBetaM * 1.11 * od.y))); }
vec3 skyAmbientRadiance(float ndl) {
  return uSunColor * (vec3(1.0) - exp(-uBetaR * uHR * 2.0)) * 0.25 * pow(0.5 + 0.5 * ndl, 2.0) / PI;
}
// Segments of the ray (as s = t - tc along m + rd*s) inside rIn < r < rOut, planet-occluded.
// xy = first segment, zw = second; a segment is empty when its y <= x.
vec4 shellSegmentsS(vec3 ro, float tc, vec3 m, float rIn, float rOut) {
  float hO = halfChord(m, rOut);
  if (hO < 0.0) return vec4(1.0, -1.0, 1.0, -1.0);
  float hI = halfChord(m, rIn);
  float sCam = -tc;
  float a = max(-hO, sCam);
  if (hI < 0.0) return vec4(a, hO, 1.0, -1.0);
  vec4 r = vec4(a, -hI, max(hI, sCam), hO);
  float hP = halfChord(m, uRadius);
  bool blocked = safeLength(ro) > uRadius && hP >= 0.0 && -hP > sCam;
  if (blocked) r.zw = vec2(1.0, -1.0);
  return r;
}`;

// ---------------------------------------------------------------------------------------------
// background: CMB + anisotropy. Uniforms: uCmbTemperature (2.725), uCmbBrightness, uCmbContrast.
// (The real CMB is invisible; brightness/contrast are artistic gains.)
// ---------------------------------------------------------------------------------------------
const BACKGROUND_FS = glsl(FRAG, MATH, NOISE, CAMERA, `
uniform float uCmbTemperature;
uniform float uCmbBrightness;
uniform float uCmbContrast;
out vec4 fragColor;
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  float a = fbm(rd * 2.5 + 3.1, 5) - 0.5;
  float b = fbm(rd * 9.0 + 11.7, 4) - 0.5;
  float T = uCmbTemperature * (1.0 + uCmbContrast * (a + 0.35 * b));
  float radiance = (SIGMA_SB * T * T) * (T * T) / PI;
  fragColor = hdrOut(vec3(0.62, 0.72, 1.0) * radiance * uCmbBrightness, 1.0);
}`);

// ---------------------------------------------------------------------------------------------
// stars: GPU point sprites. Attributes: position (m, camera-relative), luminosity (W), temperature (K),
// radius (m). Uniforms: uPsfSigmaPx (~0.9), uPointSizeMax (<= ALIASED_POINT_SIZE_RANGE max), uSpikeStrength.
// Flux = L / (4 pi d^2) is evaluated overflow-safe; kernel is normalised per steradian.
// ---------------------------------------------------------------------------------------------
const STARS_VS = glsl(VERT, MATH, CAMERA, `
layout(location = 0) in vec3 aPosition;
layout(location = 1) in float aLuminosity;
layout(location = 2) in float aTemperature;
layout(location = 3) in float aRadius;
uniform float uPsfSigmaPx;
uniform float uPointSizeMax;
out vec3 vColor;
out float vSigmaPx;
out float vHalfPx;
out float vTemp;
void main() {
  vTemp = aTemperature;
  vColor = vec3(0.0);
  vSigmaPx = 1.0;
  vHalfPx = 1.0;
  float z = dot(aPosition, uCamForward);
  float d = safeLength(aPosition);
  if (z <= 0.0 || d < 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    return;
  }
  vec2 ndc = vec2(dot(aPosition, uCamRight) / (z * uTanHalfFov.x), dot(aPosition, uCamUp) / (z * uTanHalfFov.y));
  float pixAng = 2.0 * uTanHalfFov.y / uResolution.y;
  float rPx = (aRadius / d) / pixAng;
  float sigma = sqrt(uPsfSigmaPx * uPsfSigmaPx + 0.25 * rPx * rPx);
  float flux = (aLuminosity * (1.0 / (4.0 * PI)) / d) / d;
  vColor = vec3(flux);
  gl_Position = vec4(ndc, 0.0, 1.0);
  float halfPx = clamp(sigma * 6.0, 1.5, 0.5 * uPointSizeMax);
  gl_PointSize = halfPx * 2.0;
  vSigmaPx = sigma;
  vHalfPx = halfPx;
}`);

const STARS_FS = glsl(FRAG, MATH, COLOR, CAMERA, `
uniform float uSpikeStrength;
in vec3 vColor;
in float vSigmaPx;
in float vHalfPx;
in float vTemp;
out vec4 fragColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  vec2 p = q * vHalfPx;
  float r2 = dot(p, p);
  float s2 = vSigmaPx * vSigmaPx;
  float core = exp(-0.5 * r2 / s2) / (TAU * s2);
  float al = 3.0 * vSigmaPx;
  float a2 = al * al;
  float halo = (1.5 / (PI * a2)) * pow(1.0 + r2 / a2, -2.5);
  float k = 0.88 * core + 0.12 * halo;
  float arm = exp(-abs(p.x) * 0.9 / vSigmaPx) * exp(-abs(p.y) / (14.0 * vSigmaPx))
            + exp(-abs(p.y) * 0.9 / vSigmaPx) * exp(-abs(p.x) / (14.0 * vSigmaPx));
  k += uSpikeStrength * 0.04 * arm / (TAU * s2);
  k *= 1.0 - smoothstep(0.8, 1.0, length(q));
  float pixAng = 2.0 * uTanHalfFov.y / uResolution.y;
  fragColor = hdrOut(vColor * blackbodyColor(vTemp) * k / (pixAng * pixAng), 1.0);
}`);

// ---------------------------------------------------------------------------------------------
// blackhole: black holes, gravastars and neutron stars (uSurfaceRg > 2). Reads uSceneColor, writes a full frame.
//  - uKerr = 1: Kerr null geodesics (Kerr-Schild Hamiltonian, RK2, spin axis = uSpinAxis). uKerr = 0: fast
//    Schwarzschild bending. Disk kinematics (Doppler/redshift) use Kerr Omega but approximate lapse.
//  - Bipolar relativistic jets (uJetGain > 0), Doppler-boosted (delta^3), along +/- spin axis.
//  - Shear-limited disk turbulence (flow-map, distance-faded) -> no sub-pixel dust.
//  - Mip/anisotropic-filtered lensing: uSceneColor MUST have mipmaps (LINEAR_MIPMAP_LINEAR, generateMipmap).
//  - Supersampling (uSamples 1..8, jittered) + temporal smoothing (uHistory = previous output of this pass,
//    rotation-reprojected, colour-clamped). Set uHistoryValid = 0 after a camera teleport / large move.
// Disk = thin opaque surface found at the equatorial-plane crossings (primary + lensed secondary images).
// uDiskOpacity is optical depth per crossing / 20 (internally at least 3), uDiskHeight is unused.
// uDiskVisTemp (K, default 12000): hottest displayed colour; keeps the disk glowing instead of washing to blue-white.
// PLASMA: optional uPlasma texture from physics.ts (see PLASMA contract at the top); uPlasmaMix = 0 -> flat procedural disk; uPlasmaAge (R_g/c since the texture was built) rotates it differentially.
// Uniforms: uCenter (m), uRg (GM/c^2, m), uSpinAxis, uSpin (0..0.998), uKerr, uBoundRg (auto-raised to enclose the disk), uDiskInnerRg (<=0 -> ISCO),
// uDiskOuterRg, uDiskHeight (H/r), uDiskTemperature (peak K), uDiskOpacity, uDiskGain, uSurfaceRg,
// uSurfaceTemperature, uMaxSteps (<=320), uFallback, uJetGain, uJetLengthRg, uJetWidth (Rg), uSamples, uJitter (px),
// uMaxFootprint (px, ~16), uTemporalBlend (0..0.95), uHistoryValid, uPrevCamRight/Up/Forward, uPrevTanHalfFov.
// ---------------------------------------------------------------------------------------------
const BLACKHOLE_FS = glsl(FRAG, MATH, NOISE, COLOR, CAMERA, `
uniform vec3 uCenter;
uniform float uRg;
uniform vec3 uSpinAxis;
uniform float uSpin;
uniform float uKerr;
uniform float uBoundRg;
uniform float uDiskInnerRg;
uniform float uDiskOuterRg;
uniform float uDiskHeight;
uniform float uDiskTemperature;
uniform float uDiskOpacity;
uniform float uDiskGain;
uniform float uDiskVisTemp;
uniform float uSurfaceRg;
uniform float uSurfaceTemperature;
uniform int uMaxSteps;
uniform vec3 uFallback;
uniform float uJetGain;
uniform float uJetLengthRg;
uniform float uJetWidth;
uniform int uSamples;
uniform vec2 uJitter;
uniform float uMaxFootprint;
uniform float uTemporalBlend;
uniform float uHistoryValid;
uniform vec3 uPrevCamRight;
uniform vec3 uPrevCamUp;
uniform vec3 uPrevCamForward;
uniform vec2 uPrevTanHalfFov;
uniform sampler2D uSceneColor;
uniform sampler2D uHistory;
uniform sampler2D uPlasma;
uniform float uPlasmaMix;
uniform vec2 uPlasmaSize;
uniform float uPlasmaAge;
out vec4 fragColor;

float iscoRadius(float a) {
  a = clamp(a, 0.0, 0.998);
  float z1 = 1.0 + pow(1.0 - a * a, 1.0 / 3.0) * (pow(1.0 + a, 1.0 / 3.0) + pow(1.0 - a, 1.0 / 3.0));
  float z2 = sqrt(3.0 * a * a + z1 * z1);
  return 3.0 + z2 - sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
}
// 1 - s/sqrt(b^2+s^2), cancellation-free.
float omf(float b, float s) {
  float q = sqrt(b * b + s * s);
  return s > 0.0 ? (b * b) / (q * (q + s)) : 1.0 - s / q;
}
vec3 bhAccel(vec3 p, float h2) {
  float r2 = dot(p, p);
  return (-3.0 * h2 / (r2 * r2 * sqrt(r2))) * p;
}
vec2 rot2(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(c * v.x + s * v.y, -s * v.x + c * v.y);
}

// ---- Kerr (Kerr-Schild Cartesian, M = 1, spin along +z). Forward null rays in Kerr(-a) = backward rays in Kerr(a).
float kerrR(vec3 x, float a) {
  float a2 = a * a;
  float t = dot(x, x) - a2;
  return sqrt(max(0.5 * (t + sqrt(t * t + 4.0 * a2 * x.z * x.z)), 1e-6));
}
void kerrGeom(vec3 x, float a, out float f, out vec3 l) {
  float a2 = a * a;
  float r = kerrR(x, a);
  float r2 = r * r;
  f = 2.0 * r2 * r / (r2 * r2 + a2 * x.z * x.z);
  float d = r2 + a2;
  l = vec3((r * x.x + a * x.y) / d, (r * x.y - a * x.x) / d, x.z / r);
}
float kerrH(vec3 x, vec3 p, float a) {
  float f;
  vec3 l;
  kerrGeom(x, a, f, l);
  float k = 1.0 + dot(l, p);
  return 0.5 * (dot(p, p) - 1.0 - f * k * k);
}
void kerrDeriv(vec3 x, vec3 p, float a, out vec3 dx, out vec3 dp) {
  float f;
  vec3 l;
  kerrGeom(x, a, f, l);
  float k = 1.0 + dot(l, p);
  dx = p - f * k * l;
  float e = 0.01 * max(length(x), 1.0);
  float H0 = 0.5 * (dot(p, p) - 1.0 - f * k * k);
  dp = -vec3(kerrH(x + vec3(e, 0.0, 0.0), p, a) - H0,
             kerrH(x + vec3(0.0, e, 0.0), p, a) - H0,
             kerrH(x + vec3(0.0, 0.0, e), p, a) - H0) / e;
}

vec3 trace(vec2 fc) {
  vec3 n = normalize(uSpinAxis);
  vec3 e1 = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(n, e1);
  vec3 rdW = viewRay(fc);
  vec3 roW = -uCenter / uRg;
  vec3 rd = vec3(dot(rdW, e1), dot(rdW, e2), dot(rdW, n));
  vec3 ro = vec3(dot(roW, e1), dot(roW, e2), dot(roW, n));
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  float b = safeLength(m);
  vec3 toC = b > 1e-4 ? -m / b : vec3(0.0);
  float rIn = uDiskInnerRg > 0.0 ? uDiskInnerRg : iscoRadius(clamp(uSpin, 0.0, 0.998));
  float rOut = max(uDiskOuterRg, rIn * 1.5);
  float rb = max(max(uBoundRg, rOut * 1.3), uJetGain > 0.0 ? uJetLengthRg * 1.05 : 0.0);
  bool inside = safeLength(ro) < rb;
  float h = b < rb ? sqrt(rb * rb - b * b) : 0.0;
  bool hits = b < 4.0e4 && (inside || (b < rb && tc - h > 0.0));
  float a = clamp(uSpin, 0.0, 0.998);
  float rPlus = 1.0 + sqrt(1.0 - a * a);
  bool kerr = uKerr > 0.5;

  vec3 acc = vec3(0.0);
  float trans = 1.0;
  int fate = 0;
  vec3 p = ro;
  vec3 v = rd;
  vec3 dirOut = rd;
  vec3 surf = vec3(0.0);

  if (!hits) {
    if (b > 1e-4 && b < 4.0e4) dirOut = normalize(rd + toC * (2.0 / b * omf(b, -tc)));
  } else {
    if (!inside) {
      v = normalize(rd + toC * (2.0 / b * (omf(b, -tc) - omf(b, -h))));
      p = m - rd * h;
    }
    vec3 hv = cross(p, v);
    float h2 = dot(hv, hv);
    vec3 pm = vec3(0.0);
    if (kerr) {
      float f;
      vec3 l;
      kerrGeom(p, -a, f, l);
      float c = dot(l, v);
      float A = max(1.0 - f * c * c, 1e-3);
      pm = ((f * c + sqrt(f * f * c * c + A * (1.0 + f))) / A) * v;
    }
    float tw = mod(uTime * C_LIGHT / uRg, 4000.0);
    float ph = fract(tw / 100.0);
    float pxAng = 2.0 * uTanHalfFov.y / uResolution.y;
    float jetLen = uJetLengthRg;

    for (int i = 0; i < 320; i++) {
      if (i >= max(uMaxSteps, 240)) break;
      vec3 pPrev = p;
      float r = length(p);
      float rk = kerr ? kerrR(p, a) : r;
      if (uSurfaceRg > 0.0 && r < uSurfaceRg) { fate = 2; break; }
      if (rk < (kerr ? rPlus * 1.01 : 2.0)) { fate = 1; break; }
      if (r > rb && dot(p, v) > 0.0) { fate = 3; break; }
      float ell = clamp(0.04 * r, 0.015, 6.0);
      if (kerr) ell = min(ell, 0.15 * (rk - rPlus) + 0.02);
      vec3 vn = normalize(v);
      float z = p.z;
      float rc = length(p.xy);

      if (uJetGain > 0.0) {
        float az = abs(z);
        float w = uJetWidth + 0.08 * az;
        if (az > 2.5 && az < jetLen && rc < 3.0 * w) {
          ell = min(ell, 0.5 + 0.05 * az);
          float dens = exp(-(rc * rc) / (w * w)) * pow(az, -1.2);
          dens *= 0.6 + 0.8 * noise3(vec3(p.xy * 0.3, az * 0.25 - tw * 0.02));
          const float bj = 0.9;
          float gj = inversesqrt(1.0 - bj * bj);
          float dl = 1.0 / (gj * (1.0 + bj * sign(z) * vn.z));
          acc += trans * vec3(0.45, 0.65, 1.0) * uJetGain * dens * dl * dl * dl * ell;
        }
      }

      if (kerr) {
        vec3 dx1, dp1, dx2, dp2;
        kerrDeriv(p, pm, -a, dx1, dp1);
        float dt = ell / max(length(dx1), 1e-3);
        kerrDeriv(p + 0.5 * dt * dx1, pm + 0.5 * dt * dp1, -a, dx2, dp2);
        p += dt * dx2;
        pm += dt * dp2;
        v = dx2;
      } else {
        float dt = ell / max(length(v), 1e-4);
        vec3 a0v = bhAccel(p, h2);
        p += v * dt + 0.5 * a0v * dt * dt;
        vec3 a1v = bhAccel(p, h2);
        v += 0.5 * (a0v + a1v) * dt;
      }
      if ((pPrev.z > 0.0) != (p.z > 0.0)) {
        float tt = pPrev.z / (pPrev.z - p.z);
        vec3 hp = mix(pPrev, p, tt);
        float rc2 = length(hp.xy);
        if (rc2 > rIn && rc2 < rOut) {
          vec3 vn2 = normalize(v);
          float x = rc2 / rIn;
          float pxSize = length(hp - ro) * pxAng;
          vec4 pl = vec4(1.0, 1.0, 0.0, 1.0);
          if (uPlasmaMix > 0.0) {
            float lnR = log(rOut / rIn);
            float dTexel = max(rc2 * lnR / uPlasmaSize.x, rc2 * TAU / uPlasmaSize.y);
            float lod = log2(max(pxSize / dTexel, 1.0));
            // The texture is for the time it was built: orbit it forward by the Keplerian rate since then.
            float omP = 1.0 / (pow(rc2, 1.5) + a);
            vec2 puv = vec2(clamp(log(x) / lnR, 0.0, 1.0), (atan(hp.y, hp.x) - omP * uPlasmaAge) / TAU + 0.5);
            pl = mix(pl, textureLod(uPlasma, puv, lod), uPlasmaMix);
          }
          float prof = 2.05 * pow(x, -0.75) * pow(max(1.0 - inversesqrt(x), 0.0), 0.25);
          float Te = uDiskTemperature * prof * pl.g;
          vec3 phiDir = normalize(vec3(-hp.y, hp.x, 0.0));
          float om = 1.0 / (pow(rc2, 1.5) + a);
          float beta = min(om * rc2 * inversesqrt(max(1.0 - 2.0 / rc2, 0.05)), 0.92);
          float gam = inversesqrt(1.0 - beta * beta);
          float dopp = 1.0 / (gam * (1.0 + beta * dot(phiDir, vn2)));
          float g = clamp(dopp * sqrt(max(1.0 - 2.0 / rc2, 0.0)), 0.35, 1.8);
          float To = g * Te;
          float wv = 0.03 * pow(rc2 / 10.0, -0.5);
          float n0 = fbm(vec3(rot2(hp.xy, wv * 100.0 * ph) * 0.35, 0.0), 3);
          float n1 = fbm(vec3(rot2(hp.xy, wv * 100.0 * (ph - 1.0)) * 0.35, 0.0), 3);
          float lr = log(rc2);
          float bands = 0.6 + 0.8 * noise3(vec3(lr * 22.0, 3.7, 0.0));
          float fineBands = 0.8 + 0.4 * noise3(vec3(lr * 90.0, 1.3, 0.0));
          float tex = bands * (0.6 + 0.8 * mix(n0, n1, ph));
          tex *= mix(1.0, fineBands, 1.0 - smoothstep(0.3, 1.0, length(hp - ro) * pxAng / (0.011 * rc2)));
          tex = mix(1.0, tex, 1.0 - smoothstep(0.3, 1.0, pxSize / (0.05 * rc2)));
          tex = mix(tex, pl.r, uPlasmaMix);
          float edge = (1.0 - smoothstep(0.9 * rOut, rOut, rc2)) * smoothstep(rIn, rIn * 1.04, rc2);
          // Display colour: hot white-yellow core cooling to orange/red; intensity keeps the physical T^4 falloff.
          float ratio = To / max(uDiskTemperature, 1.0);
          float tmax = uDiskVisTemp > 0.0 ? uDiskVisTemp : 12000.0;
          float Tcol = 1700.0 + (tmax - 1700.0) * pow(clamp(ratio, 0.0, 1.8) / 1.8, 0.75);
          float I4 = ratio * ratio * ratio * ratio;
          vec3 S = blackbodyColor(Tcol) * blackbodyRadiance(uDiskTemperature) * I4 * uDiskGain * tex;
          S += blackbodyColor(Tcol * 1.2) * blackbodyRadiance(uDiskTemperature) * I4 * uDiskGain * pl.b;
          float al = edge * (1.0 - exp(-max(uDiskOpacity * 20.0, 3.0))) * clamp(0.45 + 0.55 * pl.r, 0.0, 1.0);
          acc += trans * S * al;
          trans *= 1.0 - al;
          if (trans < 0.01) { fate = 4; break; }
        }
      }
    }

    if (fate == 0 && length(p) < rb * 0.5) fate = 1;
    vec3 vn = normalize(v);
    if (fate == 2) {
      float To = uSurfaceTemperature * sqrt(max(1.0 - 2.0 / uSurfaceRg, 0.0));
      float limb = 0.4 + 0.6 * max(dot(normalize(p), -vn), 0.0);
      surf = blackbodyColor(To) * blackbodyRadiance(To) * uDiskGain * limb * uExposure;
    }
    if (fate == 0 || fate == 3) {
      float s = dot(p, vn);
      vec3 perp = p - vn * s;
      float bp = safeLength(perp);
      if (fate == 3 && bp > 1e-3) vn = normalize(vn - (perp / bp) * (2.0 / bp * omf(bp, s)));
      dirOut = vn;
    }
  }

  vec3 dirW = dirOut.x * e1 + dirOut.y * e2 + dirOut.z * n;
  float zc = dot(dirW, uCamForward);
  vec2 uv = zc > 1e-4
    ? vec2(dot(dirW, uCamRight) / (zc * uTanHalfFov.x), dot(dirW, uCamUp) / (zc * uTanHalfFov.y)) * 0.5 + 0.5
    : vec2(-1.0);
  vec2 g1 = dFdx(uv);
  vec2 g2 = dFdy(uv);
  float fp = max(length(g1 * uResolution), length(g2 * uResolution));
  float sc = min(1.0, uMaxFootprint / max(fp, 1e-6));
  vec3 sceneC = textureGrad(uSceneColor, uv, g1 * sc, g2 * sc).rgb;
  bool onScreen = all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)));
  vec3 bg = onScreen ? sceneC : uFallback;
  if (fate == 1 || fate == 4) bg = vec3(0.0);
  if (fate == 2) bg = surf;
  return hdrClamp(acc * uExposure + trans * bg);
}

void main() {
  int ns = clamp(uSamples, 1, 8);
  vec3 sum = vec3(0.0);
  vec3 cmin = vec3(1.0e30);
  vec3 cmax = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (i >= ns) break;
    vec2 o = ns > 1 ? fract(vec2(0.5) + float(i) * vec2(0.7548776662, 0.5698402910)) - 0.5 : vec2(0.0);
    vec3 c = trace(gl_FragCoord.xy + o + uJitter);
    sum += c;
    cmin = min(cmin, c);
    cmax = max(cmax, c);
  }
  vec3 col = sum / float(ns);
  if (uTemporalBlend > 0.0 && uHistoryValid > 0.5) {
    vec3 rd0 = viewRay(gl_FragCoord.xy);
    float z = dot(rd0, uPrevCamForward);
    if (z > 1e-4) {
      vec2 ndc = vec2(dot(rd0, uPrevCamRight) / (z * uPrevTanHalfFov.x), dot(rd0, uPrevCamUp) / (z * uPrevTanHalfFov.y));
      if (abs(ndc.x) < 1.0 && abs(ndc.y) < 1.0) {
        vec3 hist = textureLod(uHistory, ndc * 0.5 + 0.5, 0.0).rgb;
        vec3 lo = min(cmin, col * 0.5);
        vec3 hi = max(cmax, col * 2.0 + 1e-4);
        col = mix(col, clamp(hist, lo, hi), uTemporalBlend);
      }
    }
  }
  fragColor = vec4(hdrClamp(col), 1.0);
}`);

// ---------------------------------------------------------------------------------------------
// nebula: emission + dust + reflection raymarch inside a sphere. Blend: over.
// Uniforms: uCenter, uRadius, uSeed, uDensity (dust optical depth), uEmissionGain (radiance per unit
// relative length), uColorOiii/uColorHa/uColorSii (inner->outer ionisation zones), uScatterColor,
// uStarLight (central illuminator), uSteps (<=128), uOctaves.
// ---------------------------------------------------------------------------------------------
const NEBULA_FS = glsl(FRAG, MATH, NOISE, CAMERA, BODY, `
uniform float uSeed;
uniform float uDensity;
uniform float uEmissionGain;
uniform vec3 uColorOiii;
uniform vec3 uColorHa;
uniform vec3 uColorSii;
uniform vec3 uScatterColor;
uniform vec3 uStarLight;
uniform int uSteps;
uniform int uOctaves;
out vec4 fragColor;
float nebulaDensity(vec3 q, out float dust) {
  float r = length(q);
  float fall = 1.0 - smoothstep(0.25, 1.0, r);
  vec3 s = vec3(uSeed * 13.37);
  float warp = fbm(q * 1.3 + s, 3);
  float n = fbm(q * 2.4 + warp * 1.7 + s, uOctaves);
  float d = fbm(q * 3.1 - warp * 1.2 + s + 5.5, max(uOctaves - 1, 2));
  dust = smoothstep(0.52, 0.78, d) * fall;
  return smoothstep(0.38, 0.82, n) * fall;
}
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  float h = halfChord(m, uRadius);
  if (h < 0.0) discard;
  float s0 = max(-h, -tc);
  if (h <= s0) discard;
  int n = clamp(uSteps, 8, 128);
  float ds = (h - s0) / float(n);
  float sl = ds / uRadius;
  float jit = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 128; i++) {
    if (i >= n || trans < 0.01) break;
    vec3 q = (m + rd * (s0 + (float(i) + jit) * ds)) / uRadius;
    float dust;
    float rho = nebulaDensity(q, dust);
    float r = length(q);
    vec3 emit = mix(mix(uColorOiii, uColorHa, smoothstep(0.1, 0.5, r)), uColorSii, smoothstep(0.55, 0.95, r));
    vec3 e = emit * rho * rho * uEmissionGain + uScatterColor * uStarLight * rho / (1.0 + 9.0 * r * r);
    acc += trans * e * sl;
    trans *= exp(-(dust * 1.5 + rho * 0.15) * uDensity * sl);
  }
  fragColor = hdrOut(acc, 1.0 - trans);
}`);

// ---------------------------------------------------------------------------------------------
// galaxy: bulge + exponential disk + logarithmic spiral arms + dust lanes + HII knots. Blend: over.
// Uniforms: uCenter, uRadius, uNormal (disk axis), uArms, uPitch (tan of pitch angle ~0.25), uPhase (rad),
// uThickness (disk height / radius ~0.015), uBrightness, uDustGain, uSeed, uSteps (<=96), uOctaves,
// uBulgeColor, uDiskColor, uYoungColor.
// ---------------------------------------------------------------------------------------------
const GALAXY_FS = glsl(FRAG, MATH, NOISE, CAMERA, BODY, `
uniform vec3 uNormal;
uniform float uArms;
uniform float uPitch;
uniform float uPhase;
uniform float uThickness;
uniform float uBrightness;
uniform float uDustGain;
uniform float uSeed;
uniform int uSteps;
uniform int uOctaves;
uniform vec3 uBulgeColor;
uniform vec3 uDiskColor;
uniform vec3 uYoungColor;
out vec4 fragColor;
vec3 gN;
vec3 gE1;
vec3 gE2;
void galaxySample(vec3 q, out vec3 emit, out float dust) {
  float y = dot(q, gN);
  vec3 pp = q - gN * y;
  float rho = length(pp);
  vec2 xy = vec2(dot(pp, gE1), dot(pp, gE2));
  float phase = uArms * (atan(xy.y, xy.x) - log(max(rho, 0.03)) / uPitch) + uPhase;
  float spiral = 0.5 + 0.5 * cos(phase);
  float arms = spiral * spiral * spiral;
  float edge = 1.0 - smoothstep(0.75, 1.0, rho);
  float prof = exp(-rho / 0.24) * exp(-abs(y) / uThickness) * edge;
  float br2 = rho * rho + (y * 1.7) * (y * 1.7);
  float bulge = pow(1.0 + br2 / 0.0036, -1.9) * edge;
  float nz = fbm(vec3(xy * 8.0, y * 40.0) + uSeed, uOctaves);
  float disk = prof * (0.30 + 0.70 * arms) * (0.55 + 0.9 * nz);
  float young = prof * arms * arms * smoothstep(0.5, 0.75, nz) * smoothstep(0.06, 0.22, rho);
  float lane = 0.5 + 0.5 * cos(phase + 0.9);
  dust = prof * lane * lane * lane * (0.4 + nz) * smoothstep(0.05, 0.2, rho);
  vec3 diskCol = mix(uBulgeColor, uDiskColor, smoothstep(0.05, 0.55, rho));
  emit = uBulgeColor * bulge * 6.0 + diskCol * disk * 1.6 + uYoungColor * young * 3.5;
}
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  float h = halfChord(m, uRadius);
  if (h < 0.0) discard;
  float s0 = max(-h, -tc);
  if (h <= s0) discard;
  gN = normalize(uNormal);
  gE1 = normalize(abs(gN.y) < 0.99 ? cross(gN, vec3(0.0, 1.0, 0.0)) : cross(gN, vec3(1.0, 0.0, 0.0)));
  gE2 = cross(gN, gE1);
  int n = clamp(uSteps, 8, 96);
  float ds = (h - s0) / float(n);
  float sl = ds / uRadius;
  float jit = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  for (int i = 0; i < 96; i++) {
    if (i >= n || trans < 0.01) break;
    vec3 q = (m + rd * (s0 + (float(i) + jit) * ds)) / uRadius;
    vec3 emit;
    float dust;
    galaxySample(q, emit, dust);
    acc += trans * emit * sl * uBrightness;
    trans *= exp(-dust * uDustGain * sl);
  }
  fragColor = hdrOut(acc, 1.0 - trans);
}`);

// ---------------------------------------------------------------------------------------------
// cosmicWeb: periodic Voronoi filaments/sheets/nodes, log-spaced steps through voids. Blend: add.
// Uniforms: uCamCell (camera position in cell units, reduced modulo ~1024 on the CPU), uCellSize (m),
// uMinDist, uMaxDist (m, set >= 40 cells), uFilament (~0.12), uGain, uSteps (<=96),
// uVisibility (0..1): 0 inside a galaxy, ramp to 1 as the camera reaches the cluster/supercluster tiers.
// ---------------------------------------------------------------------------------------------
const COSMICWEB_FS = glsl(FRAG, MATH, NOISE, CAMERA, `
uniform vec3 uCamCell;
uniform float uCellSize;
uniform float uMinDist;
uniform float uMaxDist;
uniform float uFilament;
uniform float uGain;
uniform float uVisibility;
uniform int uSteps;
out vec4 fragColor;
void main() {
  if (uVisibility <= 0.001) { fragColor = vec4(0.0); return; }
  vec3 rd = viewRay(gl_FragCoord.xy);
  int n = clamp(uSteps, 16, 96);
  float t0 = max(min(uMinDist, 0.05 * uCellSize), 1.0);
  float ratio = pow(uMaxDist / t0, 1.0 / float(n));
  float t = t0 * pow(ratio, ign(gl_FragCoord.xy));
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 96; i++) {
    if (i >= n) break;
    float u = float(i) / float(n);
    float dt = t * (ratio - 1.0);
    vec3 p = uCamCell + rd * (t / uCellSize);
    vec3 v = voronoi3(p);
    float sheet = exp(-(v.y - v.x) / uFilament);
    float fil = exp(-(v.z - v.x) / uFilament);
    float clump = noise3(p * 5.0);
    float node = fil * smoothstep(0.65, 1.0, clump);
    float fade = exp(-2.5 * u) * smoothstep(0.0, 0.06, u + 0.02) * (1.0 - smoothstep(0.8, 1.0, u));
    vec3 col = mix(vec3(0.45, 0.58, 1.0), vec3(1.0, 0.78, 0.5), node);
    acc += col * (0.15 * sheet + fil * fil + 2.5 * node) * (0.6 + 0.8 * clump) * fade * (dt / uCellSize) * uGain;
    t *= ratio;
  }
  fragColor = hdrOut(acc * uVisibility, 0.0);
}`);

// ---------------------------------------------------------------------------------------------
// pulsar: neutron-star surface + two rotating lighthouse beams (volumetric). Blend: over.
// Uniforms: uCenter, uSpinAxis, uTilt (rad), uPeriod (s), uBeamHalfAngle (rad), uBeamLength (m),
// uStarRadius (m), uStarTemperature (K), uBeamRadiance, uSteps (<=96).
// ---------------------------------------------------------------------------------------------
const PULSAR_FS = glsl(FRAG, MATH, COLOR, CAMERA, `
uniform vec3 uCenter;
uniform vec3 uSpinAxis;
uniform float uTilt;
uniform float uPeriod;
uniform float uBeamHalfAngle;
uniform float uBeamLength;
uniform float uStarRadius;
uniform float uStarTemperature;
uniform float uBeamRadiance;
uniform int uSteps;
out vec4 fragColor;
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  vec3 n = normalize(uSpinAxis);
  vec3 e1 = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0.0, 1.0, 0.0)) : cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(n, e1);
  float phi = TAU * fract(uTime / uPeriod);
  vec3 axis = cos(uTilt) * n + sin(uTilt) * (cos(phi) * e1 + sin(phi) * e2);
  float hs = halfChord(m, uStarRadius);
  bool star = hs >= 0.0 && tc - hs > 0.0;
  vec3 acc = vec3(0.0);
  float hb = halfChord(m, uBeamLength);
  if (hb >= 0.0) {
    int cnt = clamp(uSteps, 8, 96);
    float s0 = max(-hb, -tc);
    float s1 = star ? -hs : hb;
    if (s1 > s0) {
      float ds = (s1 - s0) / float(cnt);
      float w0 = max(1.0 - cos(uBeamHalfAngle), 1e-6);
      float r0 = uStarRadius * 8.0;
      float jit = ign(gl_FragCoord.xy);
      for (int i = 0; i < 96; i++) {
        if (i >= cnt) break;
        vec3 p = m + rd * (s0 + (float(i) + jit) * ds);
        float r = max(length(p), uStarRadius);
        float ca = abs(dot(p, axis)) / r;
        float w = exp(-(1.0 - ca) / w0);
        float q = r / r0;
        acc += vec3(0.7, 0.85, 1.0) * w / (1.0 + q * q) * ds / uBeamLength * uBeamRadiance;
      }
    }
  }
  float a = 0.0;
  if (star) {
    vec3 pn = normalize(m - rd * hs);
    float limb = 0.4 + 0.6 * max(dot(pn, -rd), 0.0);
    acc += blackbodyColor(uStarTemperature) * blackbodyRadiance(uStarTemperature) * limb;
    a = 1.0;
  }
  fragColor = hdrOut(acc, a);
}`);

// ---------------------------------------------------------------------------------------------
// planet: ray-traced sphere with procedural surface, writes log depth. Blend: none (opaque).
// uKind 0 = ocean/land world (sea, ice, 2D clouds), 1 = gas giant (bands, storm), 2 = airless/icy (craters).
// Uniforms: uCenter, uRadius, uRot (mat3 local->world), uSunDir, uSunColor, atmosphere set (uAtmoHeight=0 for none),
// uSeed, uOctaves, uSeaLevel (0..1), uIce (0..1), uBump, uCloud (0..1), uWind, uBandFreq, uCloudDrift-free;
// palettes: uPalLow, uPalHigh, uPalOceanShallow, uPalOceanDeep, uBandA/B/C, uStormColor.
// ---------------------------------------------------------------------------------------------
const PLANET_FS = glsl(FRAG, MATH, NOISE, COLOR, CAMERA, BODY, ATMOS, `
uniform mat3 uRot;
uniform int uKind;
uniform float uSeed;
uniform int uOctaves;
uniform float uSeaLevel;
uniform float uIce;
uniform float uBump;
uniform float uCloud;
uniform float uWind;
uniform float uBandFreq;
uniform vec3 uPalLow;
uniform vec3 uPalHigh;
uniform vec3 uPalOceanShallow;
uniform vec3 uPalOceanDeep;
uniform vec3 uBandA;
uniform vec3 uBandB;
uniform vec3 uBandC;
uniform vec3 uStormColor;
out vec4 fragColor;

float craterHeight(vec3 p) {
  float h = 0.0;
  for (int s = 0; s < 2; s++) {
    float sc = s == 0 ? 6.0 : 17.0;
    vec3 q = p * sc + uSeed * 3.1 + float(s) * 19.0;
    vec3 i = floor(q);
    vec3 f = fract(q);
    for (int z = -1; z <= 1; z++)
      for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
          vec3 g = vec3(float(x), float(y), float(z));
          vec3 hc = hash33(i + g);
          if (hc.y > 0.45) continue;
          vec3 c = g + hash33(i + g + 17.0) - f;
          float k = length(c) / (0.18 + 0.30 * hc.x);
          h += ((k < 1.0 ? -0.6 * (1.0 - k * k) : 0.0) + 0.25 * exp(-(k - 1.0) * (k - 1.0) / 0.03)) / float(s + 1);
        }
  }
  return h;
}
float landHeight(vec3 p) {
  float cont = fbm(p * 1.6 + uSeed, uOctaves);
  float mount = ridged(p * 5.0 + uSeed * 1.7, max(uOctaves - 1, 2));
  return cont * 0.72 + mount * 0.28 * smoothstep(0.35, 0.75, cont);
}
float heightField(vec3 p) {
  if (uKind == 2) return landHeight(p) * 0.5 + craterHeight(p) * 0.35 + 0.3;
  return landHeight(p);
}
float orenNayar(vec3 N, vec3 L, vec3 V, float rough) {
  float s2 = rough * rough;
  float A = 1.0 - 0.5 * s2 / (s2 + 0.33);
  float B = 0.45 * s2 / (s2 + 0.09);
  float nlr = dot(N, L), nvr = dot(N, V);
  vec3 lp = L - N * nlr, vp = V - N * nvr;
  float cd = max(dot(lp, vp) * inversesqrt(max(dot(lp, lp) * dot(vp, vp), 1e-8)), 0.0);
  float nl = clamp(nlr, 0.0, 1.0), nv = clamp(nvr, 0.001, 1.0);
  float mx = max(nl, nv), mn = min(nl, nv);
  float sinA = sqrt(max(1.0 - mn * mn, 0.0));
  float tanB = sqrt(max(1.0 - mx * mx, 0.0)) / max(mx, 1e-3);
  return nl * (A + B * cd * sinA * tanB);
}
float ggx(float nh, float a) {
  float a2 = a * a;
  float d = nh * nh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}
vec3 gasGiantAlbedo(vec3 nl) {
  float ang = uTime * uWind * (1.0 - 0.45 * nl.y * nl.y);
  float ca = cos(ang), sa = sin(ang);
  vec3 q = vec3(ca * nl.x - sa * nl.z, nl.y, sa * nl.x + ca * nl.z);
  float l0 = uSeed * TAU;
  float dlon = mod(atan(q.z, q.x) - l0 + PI, TAU) - PI;
  float dlat = asin(clamp(q.y, -1.0, 1.0)) + 0.28;
  float storm = exp(-(dlon * dlon) / 0.12 - (dlat * dlat) / 0.017);
  float turb = fbm(vec3(q.x * 3.5, q.y * 9.0, q.z * 3.5) + uSeed, uOctaves) - 0.5;
  float band = 0.5 + 0.5 * sin(q.y * uBandFreq + turb * 5.0 + storm * 2.5);
  float fine = fbm(vec3(q.x * 14.0, q.y * 40.0, q.z * 14.0) + uSeed * 2.0, 3);
  vec3 c = mix(uBandA, uBandB, smoothstep(0.25, 0.75, band));
  c = mix(c, uBandC, smoothstep(0.55, 0.9, fine) * 0.5);
  return mix(c, uStormColor, storm * 0.85);
}
float cloudCover(vec3 nl) {
  vec3 cp = nl * 3.0 + uSeed + vec3(uTime * 0.004, 0.0, 0.0);
  float v = fbm(cp + fbm(cp * 0.5, 3) * 1.5, 5);
  return smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.2, v);
}
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  float hc = halfChord(m, uRadius);
  if (hc < 0.0 || tc - hc <= 0.0) discard;
  gl_FragDepth = logDepth01((tc - hc) * dot(rd, uCamForward));
  vec3 Ng = normalize(m - rd * hc);
  vec3 V = -rd;
  vec3 L = normalize(uSunDir);
  float ndlg = dot(Ng, L);
  vec3 nl = normalize(Ng * uRot);

  vec3 sun = uSunColor;
  vec3 ambient = vec3(0.0);
  if (uAtmoHeight > 0.0) {
    vec2 lod;
    if (lightDepth(Ng * uRadius, L, lod)) sun *= transmittanceOf(lod);
    else sun = vec3(0.0);
    ambient = skyAmbientRadiance(ndlg);
  }
  float lit = smoothstep(-0.04, 0.08, ndlg);
  vec3 col;

  if (uKind == 1) {
    vec3 alb = gasGiantAlbedo(nl);
    float limb = 0.55 + 0.45 * pow(max(dot(Ng, V), 0.0), 0.6);
    col = alb * (sun * max(ndlg, 0.0) * lit / PI * limb + ambient);
  } else {
    float h0 = heightField(nl);
    float water = 0.0;
    float rough = 0.85;
    vec3 alb;
    float lat = abs(nl.y);
    if (uKind == 0) {
      float elev = h0 - uSeaLevel;
      float moist = fbm(nl * 3.0 + uSeed * 5.0 + 9.0, 3);
      float temp = 1.0 - lat * 1.15 - max(elev, 0.0) * 1.2 + (fbm(nl * 2.0 + uSeed * 2.0 + 4.0, 2) - 0.5) * 0.25;
      float th = 0.1 + 0.7 * uIce;
      float cold = 1.0 - smoothstep(th - 0.06, th + 0.06, temp);
      if (elev < 0.0) {
        water = -elev;
        alb = mix(uPalOceanShallow, uPalOceanDeep, 1.0 - exp(-water * 18.0));
        rough = 0.1;
        alb = mix(alb, vec3(0.9, 0.95, 1.0), cold * 0.9);
        if (cold > 0.5) { water = 0.0; rough = 0.6; }
      } else {
        vec3 lowc = mix(uPalLow, uPalLow * vec3(1.35, 1.2, 0.85), 1.0 - moist);
        alb = mix(lowc, uPalHigh, smoothstep(0.05, 0.3, elev));
        alb = mix(alb, vec3(0.92, 0.95, 1.0), cold);
      }
    } else {
      float tone = fbm(nl * 6.0 + uSeed * 4.0, 3);
      alb = mix(uPalLow, uPalHigh, smoothstep(0.3, 0.7, tone));
      alb = mix(alb, vec3(0.92, 0.95, 1.0), uIce * 0.85);
    }
    vec3 Nw = Ng;
    if (water <= 0.0) {
      vec3 t1 = normalize(cross(nl, abs(nl.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 t2 = cross(nl, t1);
      float e = 0.004;
      float h1 = heightField(normalize(nl + e * t1));
      float h2 = heightField(normalize(nl + e * t2));
      vec3 grad = ((h1 - h0) * t1 + (h2 - h0) * t2) / e;
      Nw = normalize(uRot * normalize(nl - uBump * grad));
    } else {
      vec3 wp = nl * 600.0 + vec3(uTime * 0.4, 0.0, uTime * 0.3);
      vec3 dn = vec3(noise3(wp), noise3(wp + 31.7), noise3(wp + 57.3)) - 0.5;
      Nw = normalize(Ng + dn * 0.05);
    }
    float nv = max(dot(Nw, V), 0.001);
    if (water > 0.0) {
      float F = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
      vec3 Hh = normalize(L + V);
      float a = 0.09;
      float nlw = max(dot(Nw, L), 0.0);
      float k = a * 0.5;
      float G = (nlw / (nlw * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
      vec3 spec = sun * (ggx(max(dot(Nw, Hh), 0.0), a) * G * F) / (4.0 * nv) * lit;
      col = alb * (sun * max(ndlg, 0.0) * lit / PI + ambient) * (1.0 - F) + F * ambient + spec;
    } else {
      col = alb * (sun * orenNayar(Nw, L, V, rough) * lit / PI + ambient);
    }
    if (uKind == 0 && uCloud > 0.0) {
      float c = cloudCover(nl);
      float shadow = 1.0 - 0.5 * cloudCover(normalize(nl - (L * uRot) * 0.03));
      col *= shadow;
      vec3 cc = vec3(0.92) * (sun * max(ndlg, 0.0) * lit / PI + ambient);
      col = mix(col, cc, c * 0.95);
    }
  }
  fragColor = hdrOut(col, 1.0);
}`);

// ---------------------------------------------------------------------------------------------
// atmosphere: Rayleigh + Mie single scattering around a planet. Blend: over. Uses the ATMOS uniforms.
// ---------------------------------------------------------------------------------------------
const ATMOSPHERE_FS = glsl(FRAG, MATH, CAMERA, BODY, ATMOS, `
out vec4 fragColor;
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  vec4 seg = shellSegmentsS(ro, tc, m, uRadius, uRadius + uAtmoHeight);
  if (seg.y <= seg.x) discard;
  vec3 L = normalize(uSunDir);
  float ds = (seg.y - seg.x) / float(VIEW_STEPS);
  vec2 od = vec2(0.0);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int i = 0; i < VIEW_STEPS; i++) {
    vec3 p = m + rd * (seg.x + (float(i) + 0.5) * ds);
    float h = max(length(p) - uRadius, 0.0);
    vec2 dens = vec2(exp(-h / uHR), exp(-h / uHM)) * ds;
    od += dens;
    vec2 lod;
    if (lightDepth(p, L, lod)) {
      vec3 att = transmittanceOf(od + lod);
      sumR += att * dens.x;
      sumM += att * dens.y;
    }
  }
  float mu = dot(rd, L);
  vec3 sc = uSunColor * (sumR * uBetaR * phaseR(mu) + sumM * uBetaM * phaseMie(mu, uMieG));
  vec3 tr = transmittanceOf(od);
  fragColor = hdrOut(sc, 1.0 - dot(tr, vec3(1.0 / 3.0)));
}`);

// ---------------------------------------------------------------------------------------------
// clouds: volumetric cloud shell (Beer-powder, dual-lobe phase). Blend: over. Uses the ATMOS uniforms.
// Extra: uCloudBottom, uCloudTop (altitudes m), uCloudScale (noise wavelength m), uCoverage (0..1),
// uCloudDensity (extinction 1/m, ~0.02), uCloudDrift (vec3 noise units/s), uSteps (<=96).
// ---------------------------------------------------------------------------------------------
const CLOUDS_FS = glsl(FRAG, MATH, NOISE, CAMERA, BODY, ATMOS, `
uniform float uCloudBottom;
uniform float uCloudTop;
uniform float uCloudScale;
uniform float uCoverage;
uniform float uCloudDensity;
uniform vec3 uCloudDrift;
uniform int uSteps;
out vec4 fragColor;
float cloudDensity(vec3 p) {
  float h = (length(p) - uRadius - uCloudBottom) / (uCloudTop - uCloudBottom);
  if (h < 0.0 || h > 1.0) return 0.0;
  float prof = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.55, 1.0, h));
  vec3 q = p / uCloudScale + uCloudDrift * uTime;
  float base = fbm(q * 0.35, 4);
  float cov = smoothstep(1.0 - uCoverage, 1.25 - uCoverage, base);
  float det = fbm(q * 2.1 + 3.3, 3);
  return max(cov - 0.35 * det * (1.0 - cov * 0.5), 0.0) * prof;
}
void marchClouds(vec3 m, vec3 rd, float s0, float s1, float jit, vec3 L, vec3 sunCol, vec3 ambCol, float phase,
                 inout vec3 acc, inout float trans) {
  int n = clamp(uSteps, 8, 96);
  float ds = (s1 - s0) / float(n);
  float thick = uCloudTop - uCloudBottom;
  float lstep = thick * 0.18;
  for (int i = 0; i < 96; i++) {
    if (i >= n || trans < 0.01) break;
    vec3 p = m + rd * (s0 + (float(i) + jit) * ds);
    float rho = cloudDensity(p);
    if (rho <= 0.002) continue;
    float od = 0.0;
    for (int k = 1; k <= 4; k++) od += cloudDensity(p + L * (float(k) * lstep)) * uCloudDensity * lstep;
    float hgt = clamp((length(p) - uRadius - uCloudBottom) / thick, 0.0, 1.0);
    float beer = exp(-od) + 0.35 * exp(-0.2 * od);
    vec3 S = sunCol * phase * beer + ambCol * (0.4 + 0.6 * hgt);
    float a = 1.0 - exp(-rho * uCloudDensity * ds);
    acc += trans * S * a;
    trans *= 1.0 - a;
  }
}
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  vec4 seg = shellSegmentsS(ro, tc, m, uRadius + uCloudBottom, uRadius + uCloudTop);
  bool a1 = seg.y > seg.x, a2 = seg.w > seg.z;
  if (!a1 && !a2) discard;
  vec3 L = normalize(uSunDir);
  float mid = a1 ? 0.5 * (seg.x + seg.y) : 0.5 * (seg.z + seg.w);
  vec3 pm = m + rd * mid;
  vec2 lod;
  vec3 sunCol = lightDepth(pm, L, lod) ? uSunColor * transmittanceOf(lod) : vec3(0.0);
  vec3 ambCol = skyAmbientRadiance(dot(normalize(pm), L));
  float mu = dot(rd, L);
  float phase = mix(phaseHG(mu, 0.8), phaseHG(mu, -0.3), 0.35);
  float jit = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  if (a1) marchClouds(m, rd, seg.x, seg.y, jit, L, sunCol, ambCol, phase, acc, trans);
  if (a2) marchClouds(m, rd, seg.z, seg.w, jit, L, sunCol, ambCol, phase, acc, trans);
  fragColor = hdrOut(acc, 1.0 - trans);
}`);

// ---------------------------------------------------------------------------------------------
// aurora: curtains along the auroral ovals, night side only. Blend: add.
// Extra: uMagAxis, uAuroraStrength, uAuroraOval (rad, ~1.17), uAuroraBottom/uAuroraTop (altitudes m).
// ---------------------------------------------------------------------------------------------
const AURORA_FS = glsl(FRAG, MATH, NOISE, CAMERA, BODY, ATMOS, `
uniform vec3 uMagAxis;
uniform float uAuroraStrength;
uniform float uAuroraOval;
uniform float uAuroraBottom;
uniform float uAuroraTop;
out vec4 fragColor;
vec3 auroraAt(vec3 p) {
  float r = length(p);
  float u = (r - uRadius - uAuroraBottom) / (uAuroraTop - uAuroraBottom);
  if (u < 0.0 || u > 1.0) return vec3(0.0);
  vec3 n = p / r;
  vec3 ax = normalize(uMagAxis);
  float mlat = asin(clamp(dot(n, ax), -1.0, 1.0));
  float oval = exp(-pow((abs(mlat) - uAuroraOval) / 0.09, 2.0));
  if (oval < 0.01) return vec3(0.0);
  vec3 e1 = normalize(abs(ax.y) < 0.99 ? cross(ax, vec3(0.0, 1.0, 0.0)) : cross(ax, vec3(1.0, 0.0, 0.0)));
  float lon = atan(dot(n, cross(ax, e1)), dot(n, e1));
  float curtain = pow(smoothstep(0.45, 0.85, fbm(vec3(lon * 6.0, mlat * 40.0, uTime * 0.08), 4)), 1.5) + 0.15;
  float rays = 0.4 + 0.9 * noise3(vec3(lon * 60.0, mlat * 180.0, uTime * 0.3));
  float night = 1.0 - smoothstep(-0.1, 0.2, dot(n, normalize(uSunDir)));
  float g = exp(-pow((u - 0.10) / 0.12, 2.0));
  float red = 0.35 * exp(-pow((u - 0.60) / 0.25, 2.0));
  float pur = 0.25 * exp(-pow(u / 0.04, 2.0));
  vec3 col = vec3(0.10, 1.0, 0.35) * g + vec3(1.0, 0.12, 0.15) * red + vec3(0.55, 0.2, 1.0) * pur;
  return col * oval * curtain * rays * night;
}
void main() {
  if (uAuroraStrength <= 0.0) discard;
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  vec4 seg = shellSegmentsS(ro, tc, m, uRadius + uAuroraBottom, uRadius + uAuroraTop);
  vec3 acc = vec3(0.0);
  float jit = ign(gl_FragCoord.xy);
  for (int k = 0; k < 2; k++) {
    float s0 = k == 0 ? seg.x : seg.z;
    float s1 = k == 0 ? seg.y : seg.w;
    if (s1 <= s0) continue;
    float ds = (s1 - s0) / 16.0;
    for (int i = 0; i < 16; i++) acc += auroraAt(m + rd * (s0 + (float(i) + jit) * ds)) * ds;
  }
  fragColor = hdrOut(acc * uAuroraStrength, 0.0);
}`);

// ---------------------------------------------------------------------------------------------
// rings: ray-plane annulus, slab single scattering, planet shadow, writes log depth. Blend: over.
// Extra: uRingNormal, uRingInner, uRingOuter (m), uRingOpacity (peak optical depth), uRingColorA/B, uSeed.
// Uses uCenter/uRadius (planet), uSunDir, uSunColor.
// ---------------------------------------------------------------------------------------------
const RINGS_FS = glsl(FRAG, MATH, NOISE, CAMERA, BODY, `
uniform vec3 uRingNormal;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingOpacity;
uniform vec3 uRingColorA;
uniform vec3 uRingColorB;
uniform float uSeed;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
out vec4 fragColor;
void main() {
  vec3 rd = viewRay(gl_FragCoord.xy);
  vec3 ro = -uCenter;
  vec3 n = normalize(uRingNormal);
  float dn = dot(rd, n);
  if (abs(dn) < 1e-5) discard;
  float t = dot(uCenter, n) / dn;
  if (t <= 0.0) discard;
  vec3 p = ro + rd * t;
  vec3 pp = p - n * dot(p, n);
  float rho = length(pp);
  if (rho < uRingInner || rho > uRingOuter) discard;
  float u = (rho - uRingInner) / (uRingOuter - uRingInner);
  float bands = fbm(vec3(u * 70.0, uSeed, 0.0), 4);
  float fine = noise3(vec3(u * 600.0, uSeed + 3.0, 1.0));
  float gap = 1.0 - 0.95 * exp(-pow((u - 0.62) / 0.025, 2.0));
  float tau = uRingOpacity * gap * (0.25 + 1.1 * bands) * (0.7 + 0.6 * fine)
            * smoothstep(0.0, 0.05, u) * (1.0 - smoothstep(0.93, 1.0, u));
  float cosV = max(abs(dn), 0.02);
  float alpha = 1.0 - exp(-tau / cosV);
  if (alpha < 0.003) discard;
  vec3 L = normalize(uSunDir);
  float cosI = max(abs(dot(L, n)), 0.02);
  float tcL = -dot(p, L);
  vec3 mL = p + L * tcL;
  bool shadow = tcL > 0.0 && dot(mL, mL) < uRadius * uRadius;
  float k = 1.0 / cosI, k2 = 1.0 / cosV;
  float S;
  if (dot(ro, n) * dot(L, n) > 0.0) {
    S = cosI / (cosI + cosV) * (1.0 - exp(-tau * (k + k2)));
  } else {
    float T = abs(k2 - k) < 1e-3 ? tau * k * exp(-tau * k) : k2 * (exp(-tau * k) - exp(-tau * k2)) / (k2 - k);
    S = 0.5 * cosI * T;
  }
  vec3 alb = mix(uRingColorA, uRingColorB, bands);
  vec3 rad = shadow ? vec3(0.0) : alb * uSunColor / PI * S;
  gl_FragDepth = logDepth01(t * dot(rd, uCamForward));
  fragColor = hdrOut(rad, alpha);
}`);

// ---------------------------------------------------------------------------------------------
// post-processing. bloomDown: uSource, uTexel (1/source size), uInvOutSize, uFirstPass (1 on the first
// level: Karis average). bloomUp: uSource (lower mip), uPrev (this level's down result), uTexel, uInvOutSize,
// uRadius, uWeight. tonemap: uScene, uBloom, uPostExposure, uBloomStrength, uVignette. copy: uSource.
// ---------------------------------------------------------------------------------------------
const BLOOM_DOWN_FS = glsl(FRAG, MATH, `
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uInvOutSize;
uniform float uFirstPass;
out vec4 fragColor;
vec3 S(vec2 uv, vec2 o) { return textureLod(uSource, uv + o * uTexel, 0.0).rgb; }
vec3 karis(vec3 c) { return c / (1.0 + luma(c)); }
void main() {
  vec2 uv = gl_FragCoord.xy * uInvOutSize;
  vec3 a = S(uv, vec2(-2.0, 2.0)), b = S(uv, vec2(0.0, 2.0)), c = S(uv, vec2(2.0, 2.0));
  vec3 d = S(uv, vec2(-2.0, 0.0)), e = S(uv, vec2(0.0, 0.0)), f = S(uv, vec2(2.0, 0.0));
  vec3 g = S(uv, vec2(-2.0, -2.0)), h = S(uv, vec2(0.0, -2.0)), i = S(uv, vec2(2.0, -2.0));
  vec3 j = S(uv, vec2(-1.0, 1.0)), k = S(uv, vec2(1.0, 1.0)), l = S(uv, vec2(-1.0, -1.0)), m = S(uv, vec2(1.0, -1.0));
  vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25;
  vec3 g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
  vec3 r;
  if (uFirstPass > 0.5) {
    vec3 w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
    r = w4 * 0.5 + (w0 + w1 + w2 + w3) * 0.125;
  } else {
    r = g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125;
  }
  fragColor = vec4(max(r, vec3(0.0)), 1.0);
}`);

const BLOOM_UP_FS = glsl(FRAG, `
uniform sampler2D uSource;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform vec2 uInvOutSize;
uniform float uRadius;
uniform float uWeight;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uInvOutSize;
  vec2 d = uTexel * uRadius;
  vec3 s = textureLod(uSource, uv + d * vec2(-1.0, 1.0), 0.0).rgb + 2.0 * textureLod(uSource, uv + d * vec2(0.0, 1.0), 0.0).rgb
         + textureLod(uSource, uv + d * vec2(1.0, 1.0), 0.0).rgb + 2.0 * textureLod(uSource, uv + d * vec2(-1.0, 0.0), 0.0).rgb
         + 4.0 * textureLod(uSource, uv, 0.0).rgb + 2.0 * textureLod(uSource, uv + d * vec2(1.0, 0.0), 0.0).rgb
         + textureLod(uSource, uv + d * vec2(-1.0, -1.0), 0.0).rgb + 2.0 * textureLod(uSource, uv + d * vec2(0.0, -1.0), 0.0).rgb
         + textureLod(uSource, uv + d * vec2(1.0, -1.0), 0.0).rgb;
  fragColor = vec4(textureLod(uPrev, uv, 0.0).rgb + s * (uWeight / 16.0), 1.0);
}`);

const TONEMAP_FS = glsl(FRAG, MATH, COLOR, `
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uPostExposure;
uniform float uBloomStrength;
uniform float uVignette;
out vec4 fragColor;
vec3 acesFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec2 size = vec2(textureSize(uScene, 0));
  vec2 uv = gl_FragCoord.xy / size;
  vec3 col = texelFetch(uScene, ivec2(gl_FragCoord.xy), 0).rgb;
  col += textureLod(uBloom, uv, 0.0).rgb * uBloomStrength;
  col *= uPostExposure;
  vec2 q = uv * 2.0 - 1.0;
  col *= 1.0 - uVignette * dot(q, q) * 0.25;
  col = srgbEncode(acesFilm(col));
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`);

const COPY_FS = glsl(FRAG, `
uniform sampler2D uSource;
out vec4 fragColor;
void main() { fragColor = vec4(texelFetch(uSource, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`);

const program = (
  name: ShaderName,
  fragment: string,
  blend: ShaderSource['blend'],
  writesDepth = false,
  readsScene = false,
  vertex: string = FULLSCREEN_VS,
): ShaderSource => ({ name, vertex, fragment, blend, writesDepth, readsScene });

/** Every program, keyed by name. renderer.ts compiles/links these and caches uniform locations. */
export const SHADERS: Readonly<Record<ShaderName, ShaderSource>> = {
  background: program('background', BACKGROUND_FS, 'none'),
  stars: program('stars', STARS_FS, 'add', false, false, STARS_VS),
  blackhole: program('blackhole', BLACKHOLE_FS, 'none', false, true),
  nebula: program('nebula', NEBULA_FS, 'over'),
  galaxy: program('galaxy', GALAXY_FS, 'over'),
  cosmicWeb: program('cosmicWeb', COSMICWEB_FS, 'add'),
  pulsar: program('pulsar', PULSAR_FS, 'over'),
  planet: program('planet', PLANET_FS, 'none', true),
  atmosphere: program('atmosphere', ATMOSPHERE_FS, 'over'),
  clouds: program('clouds', CLOUDS_FS, 'over'),
  aurora: program('aurora', AURORA_FS, 'add'),
  rings: program('rings', RINGS_FS, 'over', true),
  bloomDown: program('bloomDown', BLOOM_DOWN_FS, 'none'),
  bloomUp: program('bloomUp', BLOOM_UP_FS, 'none'),
  tonemap: program('tonemap', TONEMAP_FS, 'none'),
  copy: program('copy', COPY_FS, 'none'),
};

export const SHADER_NAMES = Object.keys(SHADERS) as ShaderName[];
