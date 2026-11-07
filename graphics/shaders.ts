/**
 * graphics/shaders.ts
 * Every GLSL program the engine uses, as strings (WebGL2 / GLSL ES 3.00).
 *
 * Conventions shared by all scene shaders
 *  - Positions arrive CAMERA-RELATIVE in metres (computed in float64 on the CPU by coords.ts), so the
 *    camera is always the origin and there is no precision loss at any scale.
 *  - Depth is LOGARITHMIC in true radial distance (0.1 m .. 1e27 m) written via gl_FragDepth.
 *  - Radiance units: 1.0 = irradiance of the Sun at 1 AU, per steradian. The Sun's disc is RSUN (14720).
 *    A point source of flux S (same units) is spread over the pixel footprint, so stars, nebulae and
 *    planet surfaces share one consistent photometric scale.
 *  - Everything is written PRE-EXPOSED into an RGBA16F target. Exposure lives in a 1x1 R32F texture
 *    (unit 7) that is updated on the GPU every frame (auto-exposure, no CPU read-back).
 *  - Output is premultiplied alpha. alpha = 0 means purely additive light.
 */

/** Field-line geometry shared by FIELD_VERT and the renderer's draw call. */
export const FIELD_SHELLS = 4;
export const FIELD_AZ = 8;
export const FIELD_SEGS = 40;
export const FIELD_INSTANCES = FIELD_SHELLS * FIELD_AZ * FIELD_SEGS;

/** Number of prominence loops per star; the renderer uploads 3 vec4 per loop. */
export const PROM_LOOPS = 6;

// Previous-frame camera, for motion blur and temporal reprojection.
// uPrevRel = (previous camera position) - (current camera position), metres, computed in float64 on the CPU.
const PREV = `
uniform vec3 uPrevRight;
uniform vec3 uPrevUp;
uniform vec3 uPrevFwd;
uniform vec2 uPrevTan;
uniform vec3 uPrevRel;
// Where a world point at unit direction dir, radial distance d (m) was on screen one frame ago.
// Returns false when it was behind the previous camera.
bool prevNdc(vec3 dir, float d, out vec2 pn) {
  vec3 q = dir - uPrevRel / max(d, 1e-3);
  vec3 v = vec3(dot(q, uPrevRight), dot(q, uPrevUp), dot(q, uPrevFwd));
  pn = v.xy / (max(v.z, 1e-4) * uPrevTan);
  return v.z > 1e-4;
}
`;

export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define PI 3.14159265359
const float AU = 1.495978707e11;
const float RSUN = 14720.0;
const float NEAR = 0.1;
const float FAR = 1e27;
uniform sampler2D uExp;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uTanHalf;
uniform vec2 uRes;
uniform float uPixelSr;
uniform float uTime;
uniform float uFrame;
uniform vec2 uJitter;   // temporal-upscale sub-pixel jitter, NDC units
uniform vec4 uMB;       // x shutter, y motion blur on, z max streak (px)
${PREV}
float expo() { return texelFetch(uExp, ivec2(0), 0).r; }
float ldepth(float d) { return log2(1.0 + d / NEAR) / log2(1.0 + FAR / NEAR); }
// length() overflows float32 for |v| > 1e19; this does not.
float safeLen(vec3 v) {
  float m = max(abs(v.x), max(abs(v.y), abs(v.z)));
  return m == 0.0 ? 0.0 : m * length(v / m);
}
vec4 outc(vec3 c, float a) { return vec4(min(c, vec3(60000.0)), a); }

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0));
  float k = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}
// Blackbody colour, linear sRGB, normalised to luminance 1 (brightness comes from physics, not this).
// Analytic approximation of the Planckian locus, valid 1000-40000 K (clamped outside).
vec3 blackbody(float T) {
  float t = clamp(T, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 255.0 : 329.698727446 * pow(t - 60.0, -0.1332047592);
  c.g = t <= 66.0 ? 99.4708025861 * log(t) - 161.1195681661 : 288.1221695283 * pow(t - 60.0, -0.0755148492);
  c.b = t >= 66.0 ? 255.0 : (t <= 19.0 ? 0.0 : 138.5177312231 * log(t - 10.0) - 305.0447927307);
  c = pow(clamp(c / 255.0, 0.0, 1.0), vec3(2.2));
  return c / dot(c, vec3(0.2126, 0.7152, 0.0722));
}
`;

// ---------------------------------------------------------------------------------------------
// Impostor vertex shader: a tangent-plane quad that bounds the object's angular footprint.
// Fullscreen mode (uFull) is used when the camera is inside the object or it spans most of the sky.
// ---------------------------------------------------------------------------------------------
export const IMP_VERT =
  PRELUDE +
  `
in vec2 aCorner;
uniform vec3 uDir;
uniform vec3 uT1;
uniform vec3 uT2;
uniform float uTanR;
uniform float uFull;
out vec3 vRay;
void main() {
  vec3 ray;
  if (uFull > 0.5) {
    vec2 c = aCorner * 1.01;   // a hair oversized so the jitter shift never exposes an edge
    ray = uCamFwd + c.x * uTanHalf.x * uCamRight + c.y * uTanHalf.y * uCamUp;
    gl_Position = vec4(c + uJitter, 0.0, 1.0);
  } else {
    ray = uDir + (aCorner.x * uT1 + aCorner.y * uT2) * uTanR;
    vec3 v = vec3(dot(ray, uCamRight), dot(ray, uCamUp), dot(ray, uCamFwd));
    gl_Position = vec4(v.x / uTanHalf.x + uJitter.x * v.z, v.y / uTanHalf.y + uJitter.y * v.z, 0.0, v.z);
  }
  vRay = ray;
}
`;

const SKY = `
uniform sampler2D uMapTex;
uniform sampler2D uCmbTex;
uniform vec4 uSky; // x: map radiance scale, y: CMB radiance scale, z: has map, w: has CMB
vec2 eqUv(vec3 d) {
  return vec2(atan(d.z, d.x) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI);
}
// LOD from the angular size of a pixel, so there is no seam artefact at the atan() wrap.
vec3 skyRadiance(vec3 d) {
  vec2 uv = eqUv(d);
  vec3 c = vec3(0.0);
  if (uSky.z > 0.5) {
    float lod = max(0.0, log2(sqrt(uPixelSr) * float(textureSize(uMapTex, 0).x) / (2.0 * PI)));
    c += uSky.x * textureLod(uMapTex, uv, lod).rgb;
  }
  if (uSky.w > 0.5) {
    float lod = max(0.0, log2(sqrt(uPixelSr) * float(textureSize(uCmbTex, 0).x) / (2.0 * PI)));
    c += uSky.y * textureLod(uCmbTex, uv, lod).rgb;
  }
  return c;
}
`;

const IMP_HEAD = `
in vec3 vRay;
layout(location = 0) out vec4 oColor;
uniform vec3 uCenterR; // object centre relative to the camera, in units of uRad
uniform float uRad;    // the unit length, metres
// Ray from the origin vs sphere of radius R at centre c. Uses closest approach: stable at huge distances.
vec2 sphereHit(vec3 c, vec3 rd, float R) {
  float t = dot(c, rd);
  vec3 p = c - rd * t;
  float h2 = dot(p, p);
  float r2 = R * R;
  if (h2 > r2) return vec2(-1.0);
  float s = sqrt(r2 - h2);
  return vec2(t - s, t + s);
}
float dep(float tR) { return ldepth(max(tR, 0.0) * uRad); }
`;

// ---------------------------------------------------------------------------------------------
// Sky: real star map (e.g. NASA SVS Deep Star Maps) + Planck CMB false-colour map, fullscreen.
// ---------------------------------------------------------------------------------------------
export const SKY_FRAG =
  PRELUDE +
  SKY +
  IMP_HEAD +
  `
void main() {
  vec3 rd = normalize(vRay);
  vec3 c = vec3(0.0);
  vec3 cv = vec3(dot(rd, uCamRight), dot(rd, uCamUp), dot(rd, uCamFwd));
  vec2 ndc = cv.xy / (max(cv.z, 1e-4) * uTanHalf);
  vec2 pn;
  bool blur = false;
  vec2 vel = vec2(0.0);
  if (uMB.y > 0.5 && prevNdc(rd, 1e27, pn)) {
    vel = (ndc - pn) * uMB.x;
    float px = length(vel * 0.5 * uRes);
    vel *= min(1.0, uMB.z / max(px, 1e-4));
    blur = px > 0.75;
  }
  if (blur) {
    // camera rotation: average the map along the screen-space motion of this pixel
    float jit = hash13(vec3(gl_FragCoord.xy, uFrame));
    for (int i = 0; i < 8; i++) {
      vec2 n = ndc + vel * ((float(i) + jit) / 8.0 - 0.5);
      c += skyRadiance(normalize(uCamFwd + n.x * uTanHalf.x * uCamRight + n.y * uTanHalf.y * uCamUp));
    }
    c *= 0.125;
  } else {
    c = skyRadiance(rd);
  }
  oColor = vec4(min(c * expo(), vec3(60000.0)), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Point stars (catalogue tiles + far-LOD proxies for anything sub-pixel). Magnitude-correct flux.
// Per instance: position (m, relative to the tile origin), luminosity (Lsun), temperature (K).
// ---------------------------------------------------------------------------------------------
export const STAR_VERT =
  PRELUDE +
  `
in vec2 aCorner;
in vec3 aPos;
in float aLum;
in float aTemp;
uniform vec3 uTileRel;
out vec2 vOff;
out vec3 vCol;
out float vS;
out float vLh;
out float vPeak;
void main() {
  vec3 rel = uTileRel + aPos;
  float d = safeLen(rel);
  vec3 dir = rel / max(d, 1e-30);
  vec3 v = vec3(dot(dir, uCamRight), dot(dir, uCamUp), dot(dir, uCamFwd));
  float r = AU / max(d, 1e-30);
  float flux = aLum * r * r;                 // Sun-at-1AU irradiance units
  float sigma = 0.65;                        // PSF core, pixels
  float peak = flux * expo() / (uPixelSr * 2.0 * PI * sigma * sigma);
  if (v.z <= 1e-4 || aLum <= 0.0 || peak < 0.003) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vOff = vec2(0.0);
    vCol = vec3(0.0);
    vS = 1.0;
    vLh = 0.0;
    vPeak = 0.0;
    return;
  }
  float S = clamp(2.5 * sigma * (1.0 + 0.9 * log2(1.0 + peak)), 2.0, 128.0);
  vec2 ndc = v.xy / (v.z * uTanHalf);
  // Motion blur: during the exposure the star slides along a screen-space segment of length 2*Lh.
  vec2 axis = vec2(1.0, 0.0);
  float len = 0.0;
  vec2 pn;
  if (uMB.y > 0.5 && prevNdc(dir, d, pn)) {
    vec2 vel = (ndc - pn) * 0.5 * uRes * uMB.x;
    float l = length(vel);
    if (l > 1e-3) {
      axis = vel / l;
      len = min(l, uMB.z);
    }
  }
  float Lh = 0.5 * len;
  vec2 off = vec2(aCorner.x * (S + Lh), aCorner.y * S);
  vec2 px = axis * off.x + vec2(-axis.y, axis.x) * off.y;
  gl_Position = vec4(ndc + px * 2.0 / uRes + uJitter, 0.0, 1.0);
  vOff = off;
  vS = S;
  vLh = Lh;
  vPeak = peak;
  vCol = blackbody(aTemp);
}
`;

export const STAR_FRAG =
  PRELUDE +
  `
in vec2 vOff;
in vec3 vCol;
in float vS;
in float vLh;
in float vPeak;
layout(location = 0) out vec4 oColor;
float erfA(float x) {
  float x2 = x * x;
  float t = x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2);
  return sign(x) * sqrt(1.0 - exp(-t));
}
void main() {
  const float sg = 0.65;
  float u = vOff.x;   // along the motion segment
  float w = vOff.y;   // across it
  float core;
  if (vLh < 0.02) {
    core = exp(-(u * u + w * w) / (2.0 * sg * sg));
  } else {
    // gaussian PSF averaged along the segment [-Lh, Lh]: energy is conserved, so the streak dims as it lengthens
    float k = 0.70710678 / sg;
    core = exp(-w * w / (2.0 * sg * sg)) * (1.2533141 * sg / (2.0 * vLh)) * (erfA((u + vLh) * k) - erfA((u - vLh) * k));
  }
  float dseg = length(vec2(max(abs(u) - vLh, 0.0), w));
  float halo = 0.03 / pow(1.0 + dseg / (3.0 * sg), 2.0) / (1.0 + vLh / (3.0 * sg));
  float edge = 1.0 - smoothstep(0.55 * vS, vS, dseg);
  oColor = outc(vCol * vPeak * (core + halo) * edge, 0.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Cosmic web / galaxy clusters / superclusters: soft emissive blobs or capsules (filaments).
// ---------------------------------------------------------------------------------------------
export const GLOW_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform vec3 uAxisR;  // half-length vector of the filament axis, in units of uRad (0 = round blob)
uniform vec3 uColor;  // radiance
uniform float uSeed;
void main() {
  vec3 rd = normalize(vRay);
  vec3 P0 = uCenterR - uAxisR;
  vec3 d = 2.0 * uAxisR;
  float b = dot(d, rd);
  float dd = dot(d, d);
  float e = dot(P0, d);
  float f = dot(P0, rd);
  float den = dd - b * b;
  float s = den > 1e-6 * max(dd, 1e-12) ? clamp((f * b - e) / den, 0.0, 1.0) : 0.5;
  vec3 pc = P0 + s * d;                // closest point on the axis segment
  vec3 q = pc - rd * dot(pc, rd);      // perpendicular offset from the ray
  float dist = length(q);
  gl_FragDepth = ldepth(max(dot(uCenterR, rd), 0.0) * uRad);
  if (dist >= 1.0) discard;
  float g = exp(-dist * dist * 5.0) * (1.0 - smoothstep(0.6, 1.0, dist));
  float n = 0.55 + 0.9 * fbm((pc - uCenterR) * 3.0 + vec3(uSeed, s * 4.0, uSeed * 0.5));
  oColor = outc(uColor * g * n * expo(), 0.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Galaxies: raymarched stellar disc with logarithmic spiral arms, bulge, halo and dust lanes
// (spiral), ellipticals and irregulars. Inclination is correct because it is a real 3-D volume.
// ---------------------------------------------------------------------------------------------
export const GALAXY_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform vec3 uNormal;
uniform float uType;   // 0 spiral, 1 elliptical, 2 irregular
uniform float uArms;
uniform float uPitch;  // radians
uniform float uBulge;
uniform float uFlat;   // spiral: disc scale height; elliptical: axis ratio
uniform float uSeed;
uniform vec3 uColor;   // mean surface radiance
void main() {
  vec3 rd = normalize(vRay);
  gl_FragDepth = ldepth(max(dot(uCenterR, rd), 0.0) * uRad);
  vec2 h = sphereHit(uCenterR, rd, 1.0);
  if (h.y < 0.0) discard;
  float t0 = max(h.x, 0.0);
  float dt = (h.y - t0) / 56.0;
  vec3 N = normalize(uNormal);
  vec3 U = normalize(cross(N, abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 V = cross(N, U);
  float jit = hash13(vec3(gl_FragCoord.xy, uFrame));
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 56; i++) {
    vec3 p = rd * (t0 + (float(i) + jit) * dt) - uCenterR;
    vec3 q = vec3(dot(p, U), dot(p, N), dot(p, V));
    float rr = length(q);
    if (rr > 1.0) continue;
    float r = length(q.xz);
    float dens = 0.0;
    float dust = 0.0;
    vec3 em = vec3(1.0);
    if (uType < 0.5) {
      float th = atan(q.z, q.x);
      float ph = uArms * (th - log(max(r, 0.03)) / tan(uPitch));
      float arm = pow(0.5 + 0.5 * cos(ph), 2.5);
      float prof = exp(-r * 3.4) * (1.0 - exp(-r * 30.0));
      float hz = max(uFlat, 0.004);
      float vert = exp(-abs(q.y) / hz);
      float clump = 0.6 + 0.8 * fbm(vec3(q.x, q.y * 6.0, q.z) * 9.0 + uSeed);
      float disk = prof * vert * (0.25 + 1.3 * arm * smoothstep(0.05, 0.35, r)) * clump;
      float bulge = uBulge * exp(-length(q * vec3(1.0, 1.6, 1.0)) * 11.0);
      dens = disk + bulge + 0.015 * exp(-rr * 3.0);
      float young = clamp(arm * smoothstep(0.1, 0.6, r) * disk / max(dens, 1e-4), 0.0, 1.0);
      em = mix(vec3(1.0, 0.82, 0.58), vec3(0.58, 0.72, 1.0), young);
      float dArm = pow(0.5 + 0.5 * cos(ph + 1.1), 3.0);
      dust = prof * dArm * exp(-abs(q.y) / (hz * 0.7)) * smoothstep(0.08, 0.3, r) * (0.5 + fbm(q * 14.0 + uSeed));
    } else if (uType < 1.5) {
      float re = length(vec3(q.x, q.y / max(uFlat, 0.2), q.z));
      dens = 1.2 * exp(-re * 7.0) + 0.2 * exp(-re * 2.0);
      em = vec3(1.0, 0.84, 0.64);
    } else {
      float n = fbm(q * 4.0 + uSeed);
      dens = smoothstep(0.38, 0.75, n) * exp(-rr * 2.2) * 1.6;
      em = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.8, 0.7), fbm(q * 9.0 - uSeed));
      dust = 0.2 * smoothstep(0.5, 0.8, fbm(q * 7.0 + 3.0 * uSeed)) * exp(-rr * 2.0);
    }
    col += T * em * dens * dt * 9.0;
    T *= exp(-dust * dt * 14.0);
  }
  oColor = outc(col * uColor * expo(), 1.0 - T);
}
`;

// ---------------------------------------------------------------------------------------------
// Nebulae (emission + dust absorption). uNoise = 0 gives a smooth glowing ball (boson star).
// ---------------------------------------------------------------------------------------------
export const NEBULA_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uDensity;
uniform float uNoise;
uniform float uSeed;
void main() {
  vec3 rd = normalize(vRay);
  gl_FragDepth = ldepth(max(dot(uCenterR, rd), 0.0) * uRad);
  vec2 h = sphereHit(uCenterR, rd, 1.0);
  if (h.y < 0.0) discard;
  float t0 = max(h.x, 0.0);
  float dt = (h.y - t0) / 40.0;
  float jit = hash13(vec3(gl_FragCoord.xy, uFrame));
  vec3 col = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < 40; i++) {
    vec3 p = rd * (t0 + (float(i) + jit) * dt) - uCenterR;
    float r = length(p);
    if (r > 1.0) continue;
    float base = 1.0 - smoothstep(0.15, 1.0, r);
    float n1 = fbm(p * 3.2 + uSeed);
    float n2 = fbm(p * 7.3 - uSeed);
    float d = base * mix(1.0, smoothstep(0.32, 0.78, n1) * (0.55 + 0.9 * n2), uNoise) * uDensity;
    vec3 em = mix(uColor, uColor2, smoothstep(0.3, 0.7, n2));
    col += T * em * d * dt * 6.0;
    T *= exp(-d * dt * 3.0);
  }
  oColor = outc(col * expo(), 1.0 - T);
}
`;

// ---------------------------------------------------------------------------------------------
// Star surfaces: Planck radiance from temperature, wavelength-dependent limb darkening,
// granulation, sunspots, corona. Also used for quasi-stars (huge radius, low uCell, no spots).
// Magnetic activity (uAct > 0): prominence loops above the limb and flare kernels on the disc.
// The loops (6, regenerated every lifecycle) are built on the CPU and arrive in uLoops, in star-radius
// units: [centre dir c.xyz, half-span phi] [tangent t.xyz, height H] [tube width, life, flare, twist].
//  - Prominences: each loop is a chain of 8 Gaussian-tube segments; the line integral along the ray is
//    analytic (w*sqrt(pi)/sin(angle) * exp(-d^2/w^2)), so threads stay razor sharp at any distance.
//  - Flares: a flaring loop brightens (and whitens) and its two footpoints flash on the disc.
// ---------------------------------------------------------------------------------------------
export const STAR_SURFACE_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform float uTemp;
uniform vec3 uSpin;
uniform float uSpots;
uniform float uCell;
uniform float uSeed;
uniform float uAct;
uniform vec4 uLoops[${PROM_LOOPS * 3}];
const float PROM_K = 6.0;    // prominence radiance, in units of photosphere radiance per unit path length
const float FLARE_K = 3.0;   // peak white-light flare kernel, in photospheres
const float DISC_MAX = 0.55;  // displayed level of the photosphere before tone mapping
uniform sampler2D uAlbedo;   // photosphere map (luminance 0.5 = unmodulated blackbody)
uniform sampler2D uFlare;    // plasma-filament map (red channel, 0.5 = unmodulated), tiles in both directions
uniform float uHasAlbedo;
uniform float uHasFlare;
// Scene-time phases, wrapped in float64 on the CPU (uTime itself loses precision after a long fast-forward).
uniform vec4 uStarT0;   // x spin angle (0.03 rad/s), y photosphere cross-fade phase (0.04 per s), z granulation noise offset (0.02), w prominence noise offset (0.04)
uniform vec4 uStarT1;   // x, y, z fine-detail noise offsets (0.05, 0.09, 0.15), w prominence flow phase (0.7 rad/s)
uniform vec3 uStarT2;   // x prominence plasma-map v offset (0.004), y flare-map u offset (0.002), z flare-map v offset (0.001)
// Equirectangular lookup in the Sun's rotating frame (same convention as the planets: u = longitude, v = colatitude).
vec2 sunUv(vec3 n) {
  vec3 S = normalize(uSpin);
  vec3 U = normalize(cross(S, abs(S.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 V = cross(S, U);
  vec3 q = vec3(dot(n, U), dot(n, S), dot(n, V));
  float lon = atan(q.z, q.x) + uStarT0.x;
  return vec2(fract(lon / (2.0 * PI) + 0.5), acos(clamp(q.y, -1.0, 1.0)) / PI);
}
// The flare map tiles in both directions but its V axis is clamped by the sampler, so fold V (mirror) instead of wrapping it.
vec2 foldUv(vec2 p) {
  return vec2(p.x, 0.01 + 0.98 * abs(2.0 * fract(0.5 * p.y) - 1.0));
}
// Catmull-Rom reconstruction (5 filtered taps). Plain bilinear turns a magnified texel into a soft diamond; this keeps it crisp.
vec3 sampCubic(sampler2D t, vec2 uv, vec2 gx, vec2 gy) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 p = uv * sz;
  vec2 c = floor(p - 0.5) + 0.5;
  vec2 f = p - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (c - 1.0) / sz;
  vec2 p3 = (c + 2.0) / sz;
  vec2 p12 = (c + w2 / w12) / sz;
  float k0 = w12.x * w0.y;
  float k1 = w0.x * w12.y;
  float k2 = w12.x * w12.y;
  float k3 = w3.x * w12.y;
  float k4 = w12.x * w3.y;
  vec3 r = textureGrad(t, vec2(p12.x, p0.y), gx, gy).rgb * k0
         + textureGrad(t, vec2(p0.x, p12.y), gx, gy).rgb * k1
         + textureGrad(t, p12, gx, gy).rgb * k2
         + textureGrad(t, vec2(p3.x, p12.y), gx, gy).rgb * k3
         + textureGrad(t, vec2(p12.x, p3.y), gx, gy).rgb * k4;
  return max(r / (k0 + k1 + k2 + k3 + k4), 0.0);
}
// Map lookup with the true screen-space footprint (gx, gy = uv change per pixel): hardware trilinear + anisotropic filtering
// when the map is minified or at grazing angles (no more over-blurred horizons), Catmull-Rom when it is magnified.
vec3 texG(sampler2D t, vec2 uv, vec2 gx, vec2 gy) {
  vec2 sz = vec2(textureSize(t, 0));
  float foot = max(length(gx * sz), length(gy * sz));
  vec3 b = textureGrad(t, uv, gx, gy).rgb;
  if (foot >= 1.0) return b;
  return mix(sampCubic(t, uv, gx, gy), b, smoothstep(0.5, 1.0, foot));
}
vec3 rod(vec3 v, vec3 k, float a) {
  float c = cos(a);
  float s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
// Gaussian tube (1/e radius w) around segment AB, integrated along the ray o2 + s*rd.
// smin: smallest valid ray parameter (the camera). tpar: position along AB of the closest approach.
float tubePath(vec3 o2, vec3 rd, vec3 A, vec3 B, float w, float smin, out float tpar) {
  vec3 v = B - A;
  vec3 w0 = o2 - A;
  float c = dot(v, v);
  float bb = dot(rd, v);
  float d = dot(rd, w0);
  float e = dot(v, w0);
  float D = c - bb * bb;
  float tp = D > 1e-8 * c ? clamp((e - bb * d) / D, 0.0, 1.0) : 0.5;
  float sc = bb * tp - d;
  tpar = tp;
  if (sc < smin) return 0.0;
  vec3 dv = w0 + rd * sc - v * tp;
  float d2 = dot(dv, dv);
  float sinA = max(sqrt(max(D, 0.0) / max(c, 1e-12)), 0.1);
  float g = exp(-d2 / (w * w)) + 0.45 * exp(-d2 / (6.8 * w * w));
  return 1.7724539 * w / sinA * g;
}
vec3 prominences(vec3 rd, float tc) {
  vec3 o2 = rd * tc - uCenterR;   // point of the ray nearest the star centre, star-relative
  vec3 acc = vec3(0.0);
  float flod = 0.0;   // mip level of the plasma map for this pixel
  if (uHasFlare > 0.5) flod = max(0.0, log2(max(sqrt(uPixelSr) * length(uCenterR) * 2.0 * float(textureSize(uFlare, 0).x), 1e-6)));
  for (int k = 0; k < ${PROM_LOOPS}; k++) {
    vec4 A = uLoops[3 * k];
    vec4 B = uLoops[3 * k + 1];
    vec4 C = uLoops[3 * k + 2];
    if (C.y <= 0.001) continue;
    vec3 c = A.xyz;
    vec3 t = B.xyz;
    float phi = A.w;
    float H = B.w;
    float w = C.x;
    vec3 bc = c * (1.0 + 0.5 * H);
    float rho = 0.5 * H + sin(phi) + 0.12;
    float tb = dot(bc - o2, rd);
    if (length(o2 + rd * tb - bc) > rho + 4.0 * w) continue;
    vec3 n3 = cross(c, t);
    float best = 0.0;
    vec3 pPrev = vec3(0.0);
    for (int s = 0; s <= 8; s++) {
      float u = float(s) / 8.0;
      float th = phi * (2.0 * u - 1.0);
      float rad = 1.0 + H * pow(max(cos(1.5707963 * (2.0 * u - 1.0)), 0.0), 0.8);
      vec3 p = rad * (c * cos(th) + t * sin(th)) + n3 * (C.w * sin(3.1415927 * u));
      if (s > 0) {
        float tp;
        float path = tubePath(o2, rd, pPrev, p, w * (0.75 + 0.5 * sin(3.1415927 * (u - 0.0625))), -tc, tp);
        if (path > 0.004) {
          float ua = (float(s - 1) + tp) / 8.0;
          float flow = 0.72 + 0.28 * sin(ua * 37.7 - uStarT1.w + float(k) * 1.9);
          float thread = 0.6 + 0.8 * vnoise(vec3(ua * 11.0 + float(k) * 3.7, tp * 5.0 + uStarT0.w, float(k)));
          if (uHasFlare > 0.5) {   // plasma map: knots and strands drifting along the loop
            vec2 fu = vec2(ua * 3.0 + float(k) * 0.37, 0.25 + 0.5 * fract(float(k) * 0.618) + uStarT2.x);
            thread *= 0.35 + 1.3 * textureLod(uFlare, foldUv(fu), flod).r;
          }
          best = max(best, path * flow * thread);
        }
      }
      pPrev = p;
    }
    vec3 hot = mix(vec3(1.0, 0.24, 0.30), vec3(0.85, 0.92, 1.0), clamp(C.z * 1.4, 0.0, 1.0));  // H-alpha pink -> white-blue
    acc += hot * best * C.y * (1.0 + 2.5 * C.z);
  }
  return acc * PROM_K;
}
// Flare kernels at the footpoints of every flaring loop; n = unit surface normal.
float flares(vec3 n) {
  float acc = 0.0;
  for (int k = 0; k < ${PROM_LOOPS}; k++) {
    vec4 A = uLoops[3 * k];
    vec4 B = uLoops[3 * k + 1];
    vec4 C = uLoops[3 * k + 2];
    float fl = C.z * step(0.001, C.y);
    if (fl <= 0.001) continue;
    vec3 f1 = A.xyz * cos(A.w) + B.xyz * sin(A.w);
    vec3 f2 = A.xyz * cos(A.w) - B.xyz * sin(A.w);
    acc += fl * (exp(-420.0 * (1.0 - dot(n, f1))) + exp(-420.0 * (1.0 - dot(n, f2))));
  }
  return acc;
}
void main() {
  vec3 rd = normalize(vRay);
  float L0 = RSUN * pow(uTemp / 5772.0, 4.0);
  vec3 tint = blackbody(uTemp);
  // A dark-adapted exposure is ~1e4x brighter than the photosphere can be shown at, so the disc used to clip to flat white and hide
  // every bit of plasma detail. dispK caps the displayed level but scales disc, flares, corona and prominences together, so all of
  // their contrast against each other (and the surface texture) is preserved. Below the cap (sun-adapted exposure) it is exactly 1.
  float dispK = min(1.0, DISC_MAX / max(L0 * expo(), 1e-30));
  float tc = dot(uCenterR, rd);
  vec2 h = sphereHit(uCenterR, rd, 1.0);
  gl_FragDepth = ldepth(max(tc, 0.0) * uRad);
  // map lookups: uv and its seam-safe per-pixel change, taken before any divergent control flow
  vec3 Ps = rd * h.x - uCenterR;
  vec3 dpx = dFdx(Ps);
  vec3 dpy = dFdy(Ps);
  vec2 uv = vec2(0.0);
  vec2 gx = vec2(0.0);
  vec2 gy = vec2(0.0);
  if (uHasAlbedo > 0.5 || uHasFlare > 0.5) {
    uv = sunUv(normalize(Ps));
    gx = clamp(sunUv(normalize(Ps + dpx)) - uv, vec2(-0.5), vec2(0.5));
    gy = clamp(sunUv(normalize(Ps + dpy)) - uv, vec2(-0.5), vec2(0.5));
    gx.x -= floor(gx.x + 0.5);
    gy.x -= floor(gy.x + 0.5);
    gx = clamp(gx, vec2(-0.08), vec2(0.08));
    gy = clamp(gy, vec2(-0.08), vec2(0.08));
  }
  if (h.x < 0.0) {
    float b = length(uCenterR - rd * tc);
    if (tc < 0.0 || b < 1.0 || b >= 1.8) discard;
    float cor = 0.04 * exp(-(b - 1.0) * 7.0) * (1.0 - smoothstep(1.4, 1.8, b));
    vec3 em = tint * L0 * cor;
    if (uAct > 0.0) em += L0 * prominences(rd, tc);
    oColor = outc(em * expo() * dispK, 0.0);
    return;
  }
  vec3 P = rd * h.x - uCenterR;
  float mu = clamp(dot(P, -rd), 0.0, 1.0);
  vec3 q = rod(P, normalize(uSpin), uStarT0.x);
  float gran = 0.82 + 0.36 * fbm(q * uCell + vec3(uSeed, 0.0, uStarT0.z));
  vec3 chroma = vec3(1.0);
  if (uHasAlbedo > 0.5) {
    // Photosphere map. Two copies advected by a slowly varying flow field and cross-faded (period 25 s) make the plasma boil.
    vec2 flow = (vec2(vnoise(q * 5.0 + vec3(uSeed, 0.0, 3.0)), vnoise(q * 5.0 + vec3(0.0, uSeed, 9.0))) - 0.5) * 0.012;
    float ph = uStarT0.y;
    vec3 t0 = texG(uAlbedo, uv + flow * (ph - 0.5), gx, gy);
    vec3 t1 = texG(uAlbedo, uv + flow * (fract(ph + 0.5) - 0.5), gx, gy);
    vec3 tx = mix(t1, t0, 1.0 - abs(2.0 * ph - 1.0));
    float tl = max(dot(tx, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
    // sub-texel detail once the camera is nearer than a map texel; every octave fades out before it can alias
    float fp = max(length(dpx), length(dpy));
    float fine = 0.22 * (1.0 - smoothstep(0.35, 0.9, fp * 300.0)) * (vnoise(q * 300.0 + vec3(uSeed, uStarT1.x, 0.0)) - 0.5) * 2.0
               + 0.18 * (1.0 - smoothstep(0.35, 0.9, fp * 900.0)) * (vnoise(q * 900.0 + vec3(0.0, uStarT1.y, uSeed)) - 0.5) * 2.0
               + 0.14 * (1.0 - smoothstep(0.35, 0.9, fp * 2700.0)) * (vnoise(q * 2700.0 + vec3(uStarT1.z, uSeed, 0.0)) - 0.5) * 2.0;
    gran = (tl / 0.5) * (1.0 + fine);
    chroma = clamp(tx / tl, vec3(0.5), vec3(1.6));
  }
  float spot = smoothstep(0.6, 0.72, fbm(q * 2.4 + uSeed * 3.1)) * uSpots;
  vec3 limb = 1.0 - vec3(0.55, 0.68, 0.82) * (1.0 - mu);
  vec3 col = tint * L0 * gran * chroma * limb * mix(1.0, 0.3, spot);
  if (uAct > 0.0) {
    float fk = flares(P);
    if (uHasFlare > 0.5 && fk > 0.001) fk *= 0.45 + 1.1 * texG(uFlare, foldUv(vec2(uv.x * 8.0 + uStarT2.y, uv.y * 4.0 + uStarT2.z)), gx * vec2(8.0, 4.0), gy * vec2(8.0, 4.0)).r;
    col += vec3(1.0, 0.93, 0.85) * L0 * FLARE_K * fk * (0.35 + 0.65 * mu);
  }
  oColor = outc(col * expo() * dispK, 1.0);
  gl_FragDepth = ldepth(h.x * uRad);
}
`;

// ---------------------------------------------------------------------------------------------
// Planets and moons: albedo / night lights / clouds / ocean mask / height (bump) maps, Lambert
// lighting from a physical star flux, eclipse shadows from up to 4 occluders, ocean glint, and
// single-scattering Rayleigh + Mie atmosphere (limb halo, blue sky, red sunsets, sunlit-through-air).
// ---------------------------------------------------------------------------------------------
export const BODY_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform vec3 uSpin;
uniform float uRot;
uniform float uMotionPass;
uniform float uPrevBodyValid;
uniform vec3 uPrevBodyCenterR;
uniform vec3 uPrevSpin;
uniform float uPrevRot;
uniform float uPrevRadiusRatio;
uniform float uCloudDrift;      // cloud-layer drift as a texture-u offset in [0, 1), wrapped in float64 on the CPU
uniform float uPrevCloudDrift;
uniform vec3 uDustT;          // dust-storm time: x fract(time / 240), y whole 240 s cycles (wrapped), z noise offset; wrapped in float64 on the CPU
uniform vec3 uPrevDustT;
uniform vec2 uVortexSin;        // sin(0.05 t) and sin(0.021 t + 1.3) for the vortex swirl and libration, from float64 on the CPU
uniform float uTimeStep;        // |scene time - previous frame scene time|, from float64 on the CPU
uniform float uFlowPhase;       // fract(time / 50) of the zonal jets, wrapped in float64 on the CPU
uniform float uPrevFlowPhase;
uniform float uRecalWeight;   // per-planet recalibration: share of the current frame forced into this planet's pixels (1 = history discarded)
uniform vec4 uLight;     // xyz: unit direction to the star, w: flux at the body
uniform float uLightT;
uniform float uLightAng; // angular radius of the star as seen from the body
uniform float uAtmH;   // atmosphere height, units of body radius (0 = airless)
uniform vec3 uBetaR;   // Rayleigh scattering, per body radius
uniform float uBetaM;  // Mie scattering, per body radius
uniform float uHR;
uniform float uHM;
uniform float uG;
uniform vec4 uHas;     // x night, y clouds, z ocean mask, w height
uniform float uHasAlbedo;
uniform float uFlow;   // stylised live surface: clouds drift over the ground; cloudless bodies get zonal band flow
uniform float uStorm;  // procedural dust storms (0 = none)
uniform vec4 uVortex;  // swirling baked-in vortex: xy position in the albedo map, z latitude half-extent (rad), w swirl angle (rad)
uniform vec3 uTint;
uniform float uNightScale;
uniform float uBump;   // height range in body radii
uniform vec4 uDetail;  // procedural close-up detail: x albedo contrast, y lit micro-relief, z stretch along latitude
uniform vec4 uOcc[4];  // xyz occluder centre (body radii, relative to this body), w occluder radius
uniform sampler2D uAlbedo;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uMask;
uniform sampler2D uHeight;

vec2 bodyUv(vec3 n) {
  vec3 S = normalize(uSpin);
  vec3 U = normalize(cross(S, abs(S.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 V = cross(S, U);
  vec3 q = vec3(dot(n, U), dot(n, S), dot(n, V));
  float lon = atan(q.z, q.x) - uRot;
  return vec2(fract(lon / (2.0 * PI) + 0.5), acos(clamp(q.y, -1.0, 1.0)) / PI);
}
// Jupiter's Great Red Spot (stylised): inside a smooth oval window around uVortex.xy the lookup is rotated back and
// forth and nudged east-west, so the baked-in spot swirls and drifts against the bands. s is the albedo-map coordinate.
vec2 vortexWarp(vec2 s) {
  float lon0 = (uVortex.x - 0.5) * 2.0 * PI;
  float lat0 = (0.5 - uVortex.y) * PI;
  float cl = max(cos(lat0), 0.2);
  float dl = (s.x - 0.5) * 2.0 * PI - lon0;
  dl -= 2.0 * PI * floor((dl + PI) / (2.0 * PI));
  vec2 d = vec2(dl * cl, (0.5 - s.y) * PI - lat0);
  vec2 e = vec2(d.x / 1.5, d.y) / uVortex.z;
  float w = exp(-2.0 * dot(e, e));
  float ang = uVortex.w * w * uVortexSin.x;         // swirl, about a 2 minute period
  float drift = 0.012 * w * uVortexSin.y;    // slow east-west libration, about +-0.7 degrees
  float ca = cos(ang);
  float sa = sin(ang);
  vec2 r = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);
  r.x += drift;
  return vec2((lon0 + r.x / cl) / (2.0 * PI) + 0.5, 0.5 - (lat0 + r.y) / PI);
}

// Mars-style regional dust storms (stylised, procedural): four cells bloom, drift east and fade, each life starting at
// a new place. Scene time, so they speed up with the simulation.
float dustStormAmount(vec2 uv, vec3 tm) {
  float lon = (uv.x - 0.5) * 2.0 * PI;
  float lat = (0.5 - uv.y) * PI;
  vec3 p = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
  float dust = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float t = tm.x + fi * 0.25;
    float life = fract(t);
    float cyc = (tm.y + floor(t)) * 4.0 + fi;
    float la = (hash13(vec3(cyc, 1.7, 3.1)) - 0.5) * 1.4;
    float lo = (hash13(vec3(cyc, 5.3, 9.7)) - 0.5) * 2.0 * PI + life * 0.3;
    float size = 0.1 + 0.14 * hash13(vec3(cyc, 8.9, 2.3));
    vec3 c = vec3(cos(la) * cos(lo), sin(la), cos(la) * sin(lo));
    float d = acos(clamp(dot(p, c), -1.0, 1.0));
    float rag = vnoise(p * 9.0 + vec3(fi * 11.0, 0.0, tm.z));
    float k = sin(life * PI);
    dust += k * k * (1.0 - smoothstep(0.0, size * (0.6 + 0.8 * rag), d));
  }
  return dust;
}
vec3 dustStorms(vec3 alb, vec2 uv) {
  float dust = dustStormAmount(uv, uDustT);
  return mix(alb, vec3(0.58, 0.36, 0.19), clamp(dust * 0.6 * uStorm, 0.0, 0.85));
}

// Approximate the cross-faded pair of zonal-flow samples by its weighted mean longitude.
// The TAA current-frame weight rises with the simulation step to limit blend residuals.
float zonalFlowOffset(float latitude, float phase) {
  float jet = sin(latitude * 6.0) * 0.03 * uFlow;
  float p0 = phase;
  float p1 = fract(p0 + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  return mix(jet * (p1 - 0.5), jet * (p0 - 0.5), w0);
}

// Weight of the local Great Red Spot warp. Its neighbourhood is intentionally history-rejected
// because it combines two differently warped samples and has no single exact pixel velocity.
float vortexInfluence(vec2 s) {
  float lon0 = (uVortex.x - 0.5) * 2.0 * PI;
  float lat0 = (0.5 - uVortex.y) * PI;
  float cl = max(cos(lat0), 0.2);
  float dl = (s.x - 0.5) * 2.0 * PI - lon0;
  dl -= 2.0 * PI * floor((dl + PI) / (2.0 * PI));
  vec2 d = vec2(dl * cl, (0.5 - s.y) * PI - lat0);
  vec2 e = vec2(d.x / 1.5, d.y) / uVortex.z;
  return exp(-2.0 * dot(e, e));
}
// Catmull-Rom reconstruction (5 filtered taps). Plain bilinear turns a magnified texel into a soft diamond; this keeps it crisp.
vec3 sampCubic(sampler2D t, vec2 uv, vec2 gx, vec2 gy) {
  vec2 sz = vec2(textureSize(t, 0));
  vec2 p = uv * sz;
  vec2 c = floor(p - 0.5) + 0.5;
  vec2 f = p - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (c - 1.0) / sz;
  vec2 p3 = (c + 2.0) / sz;
  vec2 p12 = (c + w2 / w12) / sz;
  float k0 = w12.x * w0.y;
  float k1 = w0.x * w12.y;
  float k2 = w12.x * w12.y;
  float k3 = w3.x * w12.y;
  float k4 = w12.x * w3.y;
  vec3 r = textureGrad(t, vec2(p12.x, p0.y), gx, gy).rgb * k0
         + textureGrad(t, vec2(p0.x, p12.y), gx, gy).rgb * k1
         + textureGrad(t, p12, gx, gy).rgb * k2
         + textureGrad(t, vec2(p3.x, p12.y), gx, gy).rgb * k3
         + textureGrad(t, vec2(p12.x, p3.y), gx, gy).rgb * k4;
  return max(r / (k0 + k1 + k2 + k3 + k4), 0.0);
}
// Map lookup with the true screen-space footprint (gx, gy = uv change per pixel): hardware trilinear + anisotropic filtering
// when the map is minified or at grazing angles (no more over-blurred horizons), Catmull-Rom when it is magnified.
vec3 texG(sampler2D t, vec2 uv, vec2 gx, vec2 gy) {
  vec2 sz = vec2(textureSize(t, 0));
  float foot = max(length(gx * sz), length(gy * sz));
  vec3 b = textureGrad(t, uv, gx, gy).rgb;
  if (foot >= 1.0) return b;
  return mix(sampCubic(t, uv, gx, gy), b, smoothstep(0.5, 1.0, foot));
}
// Body-fixed unit direction (rotates with the surface) for the procedural detail.
vec3 bodyDir(vec3 n) {
  vec3 S = normalize(uSpin);
  vec3 U = normalize(cross(S, abs(S.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 V = cross(S, U);
  vec3 q = vec3(dot(n, U), dot(n, S), dot(n, V));
  float cr = cos(uRot);
  float sr = sin(uRot);
  return vec3(q.x * cr + q.z * sr, q.y, q.z * cr - q.x * sr);
}
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}
float dhash(vec3 i) { return float(pcg3(uvec3(ivec3(i))).x) * (1.0 / 4294967296.0); }
// Value noise with a quintic fade, -1..1. Integer hash, so it stays clean at very high lattice indices.
float dnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dhash(i);
  float b = dhash(i + vec3(1.0, 0.0, 0.0));
  float c = dhash(i + vec3(0.0, 1.0, 0.0));
  float d = dhash(i + vec3(1.0, 1.0, 0.0));
  float e = dhash(i + vec3(0.0, 0.0, 1.0));
  float g = dhash(i + vec3(1.0, 0.0, 1.0));
  float h = dhash(i + vec3(0.0, 1.0, 1.0));
  float k = dhash(i + vec3(1.0, 1.0, 1.0));
  return 2.0 * mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z) - 1.0;
}
const mat3 DROT = mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64);
// Fractal detail finer than the map. Starts at one texel (f0 = texels per body radius) and keeps halving the cell size
// until a cell is about one pixel wide (fp = pixel footprint in body radii), so it is always band-limited to the screen.
// Returns (albedo variation -1..1, height in body radii). bands > 1 stretches the features along lines of latitude.
vec2 surfDetail(vec3 pb, float fp, float f0, float bands) {
  float a = 0.0;
  float h = 0.0;
  float amp = 1.0;
  float F = f0;
  vec3 pr = pb;
  for (int i = 0; i < 12; i++) {
    float w = 1.0 - smoothstep(0.30, 1.0, fp * F * bands);
    if (w <= 0.0) break;
    vec3 q = pr * F;
    q.y *= bands;
    float nz = dnoise(q + float(i) * 13.7);
    a += amp * w * nz;
    h += w * nz / F;
    amp *= 0.62;
    F *= 2.0;
    if (bands < 1.5) pr = DROT * pr;
  }
  return vec2(a / 2.4, h);
}
float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}
float rayExit(vec3 p, vec3 d, float R) {
  float b = dot(p, d);
  float c = dot(p, p) - R * R;
  return -b + sqrt(max(b * b - c, 0.0));
}
vec3 lightOD(vec3 P, vec3 L, float Ra) {
  float ds = rayExit(P, L, Ra) / 4.0;
  vec3 od = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec3 s = P + L * (float(i) + 0.5) * ds;
    float h = max(length(s) - 1.0, 0.0);
    od += (uBetaR * exp(-h / uHR) + vec3(1.1 * uBetaM * exp(-h / uHM))) * ds;
  }
  return od;
}
bool inPlanetShadow(vec3 P, vec3 L) {
  float b = dot(P, L);
  return b < 0.0 && dot(P, P) - b * b < 1.0;
}
void main() {
  vec3 rd = normalize(vRay);
  float Ra = 1.0 + uAtmH;
  vec2 ha = sphereHit(uCenterR, rd, Ra);
  vec2 hs = sphereHit(uCenterR, rd, 1.0);
  bool hitS = hs.x > 0.0;
  vec3 L = uLight.xyz;
  vec3 E = blackbody(uLightT) * uLight.w;
  vec3 P = rd * hs.x - uCenterR;
  vec3 n = hitS ? normalize(P) : vec3(0.0, 1.0, 0.0);
  // derivatives are taken before any divergent control flow
  float hgt = (uBump > 0.0 && uHas.w > 0.5) ? textureLod(uHeight, bodyUv(n), 0.0).r : 0.0;
  vec3 dpx = dFdx(P);
  vec3 dpy = dFdy(P);
  float dhx = dFdx(hgt);
  float dhy = dFdy(hgt);
  // uv and its per-pixel change (seam-safe), so every map is sampled with its real screen footprint
  vec2 uv = bodyUv(n);
  vec2 gx = clamp(bodyUv(normalize(P + dpx)) - uv, vec2(-0.5), vec2(0.5));
  vec2 gy = clamp(bodyUv(normalize(P + dpy)) - uv, vec2(-0.5), vec2(0.5));
  gx.x -= floor(gx.x + 0.5);
  gy.x -= floor(gy.x + 0.5);
  gx = clamp(gx, vec2(-0.08), vec2(0.08));
  gy = clamp(gy, vec2(-0.08), vec2(0.08));
  float fp = max(length(dpx), length(dpy));
  float f0 = uHasAlbedo > 0.5 ? float(textureSize(uAlbedo, 0).x) / (2.0 * PI) : 160.0;
  vec2 dt = vec2(0.0);
  if (uDetail.x > 0.0 || uDetail.y > 0.0) dt = surfDetail(bodyDir(n), fp, f0, uDetail.z);
  float ddx = dFdx(dt.y);
  float ddy = dFdy(dt.y);
  gl_FragDepth = ldepth(max(hitS ? hs.x : ha.x, 0.0) * uRad);
  if (ha.y < 0.0 || (!hitS && uAtmH <= 0.0)) discard;

  if (uMotionPass > 0.5) {
    if (!hitS || uPrevBodyValid < 0.5) {
      oColor = vec4(0.0);
      return;
    }

    vec3 axisNow = normalize(uSpin);
    vec3 uNow = normalize(cross(axisNow, abs(axisNow.y) < 0.99
      ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 vNow = cross(axisNow, uNow);
    vec3 qNow = vec3(dot(n, uNow), dot(n, axisNow), dot(n, vNow));
    float bodyLongitude = atan(qNow.z, qNow.x) - uRot;
    float bodyCosLat = length(qNow.xz);
    float latitude = asin(clamp(qNow.y, -1.0, 1.0));

    float historyCurrentWeight = 0.0;
    bool historyValid = true;

    // Earth-like moving cloud layer: only cloud-covered pixels reject history.
    if (uFlow > 0.0 && uHas.y > 0.5) {
      vec2 cloudUvNow = uv;
      vec2 cloudUvPrev = uv;
      cloudUvNow.x += uCloudDrift;
      cloudUvPrev.x += uPrevCloudDrift;
      float cloudNow = texG(uClouds, cloudUvNow, gx, gy).r;
      float cloudPrev = texG(uClouds, cloudUvPrev, gx, gy).r;
      if (max(cloudNow, cloudPrev) > 0.001) historyValid = false;
    }

    // Reject history if a moving dust feature affects this surface point in either frame.
    if (uStorm > 0.0) {
      float dustNow = dustStormAmount(uv, uDustT);
      float dustPrev = dustStormAmount(uv, uPrevDustT);
      if (max(dustNow, dustPrev) * 0.6 * uStorm > 0.001) {
        historyValid = false;
      }
    }

    // Gas-giant zonal bands move independently of solid-body rotation. Track the effective
    // cross-faded longitude; use more current-frame weight because the pair is not a single layer.
    if (uFlow > 0.0 && uHas.y < 0.5 && uHasAlbedo > 0.5) {
      if (uVortex.w > 0.0 && vortexInfluence(uv) > 0.002) {
        historyValid = false;
      } else {
        float currentFlowOffset = zonalFlowOffset(latitude, uFlowPhase);
        float previousFlowOffset = zonalFlowOffset(latitude, uPrevFlowPhase);
        bodyLongitude += 2.0 * PI * (currentFlowOffset - previousFlowOffset);
        historyCurrentWeight = clamp(0.45 + 0.08 * uTimeStep, 0.45, 0.9);
      }
    }

    if (!historyValid) {
      oColor = vec4(0.0);
      return;
    }

    // Per-planet visual recalibration: while the renderer rebuilds this planet's appearance it asks for a larger
    // share of the current frame (1 discards the history outright). Only this planet's pixels carry it.
    historyCurrentWeight = max(historyCurrentWeight, uRecalWeight);

    // Rebuild the previous-frame normal from the same body-fixed longitude/latitude.
    vec3 axisPrev = normalize(uPrevSpin);
    vec3 uPrev = normalize(cross(axisPrev, abs(axisPrev.y) < 0.99
      ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 previousV = cross(axisPrev, uPrev);
    float previousLongitude = bodyLongitude + uPrevRot;
    vec3 nPrev = uPrev * (cos(previousLongitude) * bodyCosLat)
               + axisPrev * qNow.y
               + previousV * (sin(previousLongitude) * bodyCosLat);

    vec3 qPrev = uPrevBodyCenterR + nPrev * uPrevRadiusRatio - uPrevRel / uRad;
    vec3 vPrev = vec3(
      dot(qPrev, uPrevRight),
      dot(qPrev, uPrevUp),
      dot(qPrev, uPrevFwd)
    );
    if (vPrev.z <= 1e-4) {
      oColor = vec4(0.0);
      return;
    }

    vec2 prevNdc = vPrev.xy / (vPrev.z * uPrevTan);
    oColor = vec4(prevNdc * 0.5 + 0.5, historyCurrentWeight, 1.0);
    return;
  }

  vec3 surf = vec3(0.0);
  if (hitS) {
    float mu = max(dot(n, -rd), 0.0);
    vec2 uvC = uv;
    uvC.x += uCloudDrift;   // clouds drift against the surface
    float cl = uHas.y > 0.5 ? texG(uClouds, uvC, gx, gy).r : 0.0;
    float ocean = uHas.z > 0.5 ? texG(uMask, uv, gx, gy).r : 0.0;
    vec3 alb = uTint;
    if (uHasAlbedo > 0.5) {
      if (uFlow > 0.0 && uHas.y < 0.5) {
        // zonal jets: bands slide in opposite directions with latitude. Two layers offset by half a period
        // cross-fade, so the shear stays bounded however long the simulation runs.
        float lat = (0.5 - uv.y) * PI;
        float jet = sin(lat * 6.0) * 0.03 * uFlow;
        float p0 = uFlowPhase;
        float p1 = fract(uFlowPhase + 0.5);
        vec2 s0 = vec2(uv.x + jet * (p0 - 0.5), uv.y);
        vec2 s1 = vec2(uv.x + jet * (p1 - 0.5), uv.y);
        if (uVortex.w > 0.0) {
          s0 = vortexWarp(s0);
          s1 = vortexWarp(s1);
        }
        vec3 a0 = texG(uAlbedo, s0, gx, gy);
        vec3 a1 = texG(uAlbedo, s1, gx, gy);
        alb = mix(a1, a0, 1.0 - abs(2.0 * p0 - 1.0));
      } else {
        alb = texG(uAlbedo, uv, gx, gy);
      }
    }
    if (uStorm > 0.0) alb = dustStorms(alb, uv);
    alb *= max(1.0 + uDetail.x * (1.0 - 0.9 * ocean) * dt.x, 0.0);   // close-up detail beyond the map's texels
    alb = mix(alb, vec3(0.9), cl);
    vec3 nb = n;
    bool hasMapBump = uBump > 0.0 && uHas.w > 0.5;
    float relK = uDetail.y * (1.0 - ocean) * (1.0 - cl) * smoothstep(0.0, 0.25, mu);
    if (hasMapBump || relK > 0.0) {
      vec3 r1 = cross(dpy, n);
      vec3 r2 = cross(n, dpx);
      float det = dot(dpx, r1);
      float bx = (hasMapBump ? uBump * dhx : 0.0) + relK * ddx;
      float by = (hasMapBump ? uBump * dhy : 0.0) + relK * ddy;
      nb = normalize(abs(det) * n - sign(det) * (bx * r1 + by * r2));
    }
    float ndl = dot(nb, L);
    float ndlG = dot(n, L);
    // eclipses: fraction of the star's disc covered by each occluder
    float sh = 1.0;
    for (int i = 0; i < 4; i++) {
      if (uOcc[i].w > 0.0) {
        vec3 oc = uOcc[i].xyz - n;
        float dO = max(length(oc), uOcc[i].w * 1.0001);
        float ao = asin(clamp(uOcc[i].w / dO, 0.0, 1.0));
        float sep = acos(clamp(dot(oc / dO, L), -1.0, 1.0));
        float sa = max(uLightAng, 1e-6);
        float cov = (1.0 - smoothstep(abs(sa - ao) + 1e-6, sa + ao, sep)) * min(1.0, ao * ao / (sa * sa));
        sh *= 1.0 - cov;
      }
    }
    vec3 Tsun = uAtmH > 0.0 ? exp(-lightOD(n * 1.00001, L, Ra)) : vec3(1.0);
    // The perturbed normal (bump / micro-relief) must never light ground whose true spherical normal faces away from the star:
    // past the terminator the surface stays black, instead of speckles that the auto-exposure would then chase.
    float horizon = smoothstep(0.0, 0.02, ndlG);
    vec3 diff = alb * E * Tsun * max(ndl, 0.0) / PI * sh * horizon;
    vec3 night = vec3(0.0);
    if (uHas.x > 0.5) {
      night = texG(uNight, uv, gx, gy) * uNightScale
            * (1.0 - smoothstep(-0.12, 0.02, ndlG)) * (1.0 - cl * 0.7);
    }
    float ang = acos(clamp(dot(reflect(rd, nb), L), -1.0, 1.0));
    float rough = 0.05;
    vec3 spec = ocean * (1.0 - cl) * 0.02 * E * Tsun * exp(-ang * ang / (2.0 * rough * rough))
              / (2.0 * PI * rough * rough) * sh * step(0.0, ndlG);
    surf = diff + night + spec;
  }

  vec3 ins = vec3(0.0);
  vec3 odV = vec3(0.0);
  if (uAtmH > 0.0) {
    float ts = max(ha.x, 0.0);
    float te = hitS ? hs.x : ha.y;
    float ds = max(te - ts, 0.0) / 12.0;
    float mu = dot(rd, L);
    float pr = phaseR(mu);
    float pm = phaseM(mu, uG);
    for (int i = 0; i < 12; i++) {
      vec3 p = rd * (ts + (float(i) + 0.5) * ds) - uCenterR;
      float hh = max(length(p) - 1.0, 0.0);
      float dR = exp(-hh / uHR);
      float dM = exp(-hh / uHM);
      odV += (uBetaR * dR + vec3(1.1 * uBetaM * dM)) * ds;
      if (!inPlanetShadow(p, L)) {
        vec3 att = exp(-(odV + lightOD(p, L, Ra)));
        ins += att * (uBetaR * dR * pr + vec3(uBetaM * dM * pm)) * ds;
      }
    }
    ins *= E;
  }
  vec3 Tv = exp(-odV);
  if (hitS) {
    oColor = outc((surf * Tv + ins) * expo(), 1.0);
  } else {
    oColor = outc(ins * expo(), 1.0 - dot(Tv, vec3(1.0 / 3.0)));
  }
}
`;

// ---------------------------------------------------------------------------------------------
// Planetary rings: radial profile texture (e.g. Cassini), lit by the star, planet shadow on rings,
// reflected vs transmitted light depending on which side the camera and the star are.
// ---------------------------------------------------------------------------------------------
export const RING_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform vec3 uNormal;
uniform float uIn;
uniform float uOut;
uniform vec4 uLight;
uniform float uLightT;
uniform sampler2D uRingTex;
uniform float uHasRing;
uniform float uRingH;   // camera height above the ring plane, metres (computed in doubles on the CPU, so it stays exact at 1 m)
uniform vec3 uRingE1;   // orthonormal basis of the ring plane
uniform vec3 uRingE2;
uniform vec2 uRingO;    // camera position in the plane = uRingO * 4096 m + uRingF, split so metre-scale detail survives float32
uniform vec2 uRingF;

uvec3 rpcg(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}
float rh(ivec2 c, int salt) { return float(rpcg(uvec3(uint(c.x), uint(c.y), uint(salt))).x) * (1.0 / 4294967296.0); }
// 2-D value noise, -1..1, on a world-anchored lattice of cell size lam metres (lam divides 4096, so cell indices are exact integers).
float rnoise2(vec2 loc, float lam, int salt) {
  int m = int(4096.0 / lam + 0.5);
  vec2 g = loc / lam;
  vec2 fl = floor(g);
  vec2 f = g - fl;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(fl) + ivec2(uRingO) * m;
  float a = rh(c, salt);
  float b = rh(c + ivec2(1, 0), salt);
  float d = rh(c + ivec2(0, 1), salt);
  float e = rh(c + ivec2(1, 1), salt);
  return 2.0 * mix(mix(a, b, f.x), mix(d, e, f.x), f.y) - 1.0;
}
float rnoise1(float x, float lam, int salt) {
  float g = x / lam;
  float fl = floor(g);
  float f = g - fl;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(int(fl), 0);
  return 2.0 * mix(rh(c, salt), rh(c + ivec2(1, 0), salt), f) - 1.0;
}
// One layer of individual ring particles: at most one jittered disc per lattice cell (cell size lam metres), random size,
// brightness and tilt. cov = coverage, shade = brightness, gl = specular glint. When a pixel is wider than a cell the layer
// fades to its average, so nothing aliases and the far view is unchanged.
void ringLayer(vec2 loc, float lam, float dens, float fw, int salt, vec3 H, vec3 nSide, vec3 e1, vec3 e2,
               out float cov, out float shade, out float gl) {
  int m = int(4096.0 / lam + 0.5);
  vec2 g = loc / lam;
  vec2 fl = floor(g);
  vec2 f = g - fl;
  ivec2 c = ivec2(fl) + ivec2(uRingO) * m;
  uvec3 h1 = rpcg(uvec3(uint(c.x), uint(c.y), uint(salt)));
  uvec3 h2 = rpcg(h1 ^ uvec3(0x9E3779B9u, 0x85EBCA6Bu, 0xC2B2AE35u));
  vec3 r1 = vec3(h1) * (1.0 / 4294967296.0);
  vec3 r2 = vec3(h2) * (1.0 / 4294967296.0);
  float rho = 0.28 + 0.22 * r2.x;
  vec2 ctr = rho + (1.0 - 2.0 * rho) * r1.yz;
  float d = length(f - ctr);
  float fc = fw / lam;
  float disc = r1.x < dens ? 1.0 - smoothstep(rho - 0.5 * fc, rho + 0.5 * fc, d) : 0.0;
  float wl = 1.0 - smoothstep(0.25, 0.8, fc);
  cov = mix(dens * 0.49, disc, wl);
  float q = d / rho;
  float sh = (0.55 + 0.9 * r2.y) * (1.0 - 0.35 * q * q) * 1.2;
  shade = mix(1.0, sh, wl);
  gl = 0.0;
  if (r2.z > 0.9 && disc > 0.0 && wl > 0.0) {
    uvec3 h3 = rpcg(h2 + 17u);
    vec2 tr = vec2(h3.xy & uvec2(65535u)) * (2.0 / 65535.0) - 1.0;
    vec3 nf = normalize(nSide + 0.6 * (tr.x * e1 + tr.y * e2));
    gl = disc * wl * pow(max(dot(nf, H), 0.0), 250.0);
  }
}
void main() {
  vec3 rd = normalize(vRay);
  vec3 N = normalize(uNormal);
  float dn = dot(rd, N);
  float dnS = abs(dn) < 1e-6 ? 1e-6 : dn;
  float t = -uRingH / uRad / dnS;
  gl_FragDepth = ldepth(max(t, 0.0) * uRad);
  // camera-relative hit point in metres, then plane coordinates relative to the lattice origin (all small numbers, so exact)
  float tM = t * uRad;
  vec3 Q = rd * tM;
  vec2 loc = uRingF + vec2(dot(Q, uRingE1), dot(Q, uRingE2));
  // derivatives are taken before any discard
  float fw = max(length(dFdx(loc)), length(dFdy(loc)));
  if (isnan(fw)) fw = 1e9;
  fw = min(fw, 1e9);
  if (t <= 0.0) discard;
  vec3 P = rd * t - uCenterR;
  float r = length(P);
  if (r < uIn || r > uOut) discard;
  float u = (r - uIn) / (uOut - uIn);
  vec4 rt = uHasRing > 0.5
    ? texture(uRingTex, vec2(u, 0.5))
    : vec4(0.75, 0.70, 0.60, smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.9, 1.0, u)) * 0.8);
  vec3 L = uLight.xyz;
  vec3 E = blackbody(uLightT) * uLight.w;
  float b = dot(P, L);
  float sh = (b < 0.0 && dot(P, P) - b * b < 1.0) ? 0.0 : 1.0;
  float same = (sign(dot(N, L)) * sign(dot(N, -uCenterR)) > 0.0) ? 1.0 : 0.0;
  float ndl = abs(dot(N, L));

  // ---- close-up detail: ringlets, clumps, then individual particles with glints. Every scale fades out once a pixel is too wide to resolve it.
  float alpha = rt.a;
  float shade = 1.0;
  float glintSum = 0.0;
  if (rt.a > 0.004 && fw < 3000.0) {
    float rm = r * uRad;
    float md = 0.0;
    float w;
    w = 1.0 - smoothstep(0.25, 0.85, fw / 20000.0); md += 0.28 * w * rnoise1(rm, 20000.0, 11);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 4000.0);  md += 0.22 * w * rnoise1(rm, 4000.0, 12);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 800.0);   md += 0.18 * w * rnoise1(rm, 800.0, 13);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 200.0);   md += 0.14 * w * rnoise1(rm, 200.0, 14);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 2048.0);  md += 0.22 * w * rnoise2(loc, 2048.0, 21);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 512.0);   md += 0.20 * w * rnoise2(loc, 512.0, 22);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 128.0);   md += 0.18 * w * rnoise2(loc, 128.0, 23);
    w = 1.0 - smoothstep(0.25, 0.85, fw / 32.0);    md += 0.16 * w * rnoise2(loc, 32.0, 24);
    float aT = clamp(rt.a * (1.0 + md), 0.0, 0.995);
    float cc = 1.0 - exp(log(max(1.0 - aT, 1e-3)) / 3.0);
    float dens = clamp(cc / 0.49, 0.0, 1.0);
    vec3 H = normalize(L - rd);
    vec3 nSide = dot(N, -rd) >= 0.0 ? N : -N;
    float c2, s2, g2, c1, s1, g1, c0, s0, g0;
    ringLayer(loc, 8.0, dens, fw, 3, H, nSide, uRingE1, uRingE2, c2, s2, g2);
    ringLayer(loc, 2.0, dens, fw, 2, H, nSide, uRingE1, uRingE2, c1, s1, g1);
    ringLayer(loc, 0.5, dens, fw, 1, H, nSide, uRingE1, uRingE2, c0, s0, g0);
    // coarse to fine, finer particles on top
    float A = c2;
    float B = s2 * c2;
    B = B * (1.0 - c1) + s1 * c1;
    A = A + c1 * (1.0 - A);
    B = B * (1.0 - c0) + s0 * c0;
    A = A + c0 * (1.0 - A);
    float mk = 1.0 - dens * 0.49;
    float meanA = 1.0 - mk * mk * mk;
    alpha = clamp(A * aT / max(meanA, 1e-3), 0.0, 1.0);
    shade = (B / max(A, 1e-3)) * (1.0 + 0.45 * md);
    glintSum = g0 + g1 + g2;
  }

  // phase behaviour: opposition surge when the sun is behind the camera, forward-scattering glare when the camera looks toward the sun through the rings
  float cosS = dot(rd, L);
  float phase;
  if (same > 0.5) {
    phase = 1.0 + 0.8 * exp(-acos(clamp(-cosS, -1.0, 1.0)) / 0.08);
  } else {
    float g = 0.82;
    float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosS, 1e-3), 1.5);
    phase = 1.0 + 0.15 * min(hg, 40.0);
  }
  vec3 rad = rt.rgb * E * sh * mix(0.12, 0.6, same) * ndl / PI * shade * phase;
  vec3 glint = E * sh * glintSum * (0.3 + 0.7 * ndl) * 6.0 * same;
  oColor = outc((rad + glint) * alpha * expo(), alpha);
}
`;

// Shared by compact objects and wormholes: look up what a bent ray sees.
const LENS = `
uniform sampler2D uScene; // copy of everything drawn so far (pre-exposed HDR)
vec3 lensed(vec3 dir) {
  vec3 v = vec3(dot(dir, uCamRight), dot(dir, uCamUp), dot(dir, uCamFwd));
  if (v.z > 1e-3) {
    vec2 ndc = v.xy / (v.z * uTanHalf) + uJitter;   // uScene holds the jittered image
    if (abs(ndc.x) < 0.998 && abs(ndc.y) < 0.998) return textureLod(uScene, ndc * 0.5 + 0.5, 0.0).rgb;
  }
  return skyRadiance(dir) * expo();
}
`;

// ---------------------------------------------------------------------------------------------
// Compact objects, general relativity: null geodesics are integrated per pixel (Schwarzschild
// bending, plus a gravitomagnetic term for spin). Covers black holes, white holes, gravastars,
// quark stars and neutron stars (opaque surface at uSurf.x Schwarzschild radii), plus a thin
// accretion disc (Shakura-Sunyaev temperature, relativistic Doppler + gravitational redshift),
// relativistic jets, and quasars/AGN. Lensing samples the already-rendered scene, so stars,
// galaxies and nebulae behind the hole are bent too. Units inside: Schwarzschild radius = 1.
// ---------------------------------------------------------------------------------------------
export const COMPACT_FRAG =
  PRELUDE +
  SKY +
  IMP_HEAD +
  LENS +
  `
uniform vec3 uSpin;
uniform float uA;       // dimensionless spin 0..0.998
uniform float uExtent;  // lens region radius in Schwarzschild radii
uniform vec4 uDisk;     // x inner radius (0 = ISCO), y outer radius, z peak temperature K, w opacity (0 = no disc)
uniform vec4 uSurf;     // x surface radius in rs (0 = event horizon), y surface temperature K
uniform vec3 uGlow;     // horizon radiance (white hole)
uniform vec4 uJet;      // x intensity, y length, z width slope, w enabled
uniform vec3 uJetColor;

float iscoRs(float a) {
  a = clamp(a, 0.0, 0.998);
  float z1 = 1.0 + pow(1.0 - a * a, 1.0 / 3.0) * (pow(1.0 + a, 1.0 / 3.0) + pow(1.0 - a, 1.0 / 3.0));
  float z2 = sqrt(3.0 * a * a + z1 * z1);
  float r = 3.0 + z2 - sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
  return 0.5 * r;
}
vec3 geoAcc(vec3 p, vec3 vel, float h2, vec3 J) {
  float r2 = dot(p, p);
  float r = sqrt(r2);
  vec3 g = -1.5 * h2 * p / (r2 * r2 * r);
  if (uA > 0.0) {
    vec3 rh = p / r;
    vec3 B = (3.0 * dot(J, rh) * rh - J) / (r2 * r);
    g += 0.5 * uA * cross(vel, B); // frame dragging, qualitative approximation
  }
  return g;
}
void main() {
  vec3 rd = normalize(vRay);
  vec3 ro = -uCenterR;
  float rcam = length(ro);
  float tt = dot(uCenterR, rd);
  float bimp = tt > 0.0 ? length(uCenterR - rd * tt) : rcam;
  float w = 1.0 - smoothstep(0.7 * uExtent, uExtent, bimp);
  gl_FragDepth = ldepth(max(tt, 0.0) * uRad);
  if (w <= 0.0) discard;

  vec3 J = normalize(uSpin);
  vec3 Ud = normalize(cross(J, abs(J.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 Vd = cross(J, Ud);

  float R0 = uExtent * 1.2;
  vec3 x = ro;
  if (rcam > R0) {
    vec2 hh = sphereHit(uCenterR, rd, R0);
    if (hh.x < 0.0) discard;
    x = rd * hh.x - uCenterR;
  }
  vec3 v = rd;
  float r0 = length(x);
  vec3 cr = cross(x, v);
  float h2 = dot(cr, cr);
  float rIn = uDisk.x > 0.0 ? uDisk.x : iscoRs(uA);
  float surfR = uSurf.x;
  float rcap = max(surfR, 1.0);
  float gcam = sqrt(max(1.0 - 1.0 / max(rcam, 1.0001), 0.02));
  float rEsc = r0 * 1.001;

  vec3 col = vec3(0.0);
  float T = 1.0;
  bool escaped = false;
  float prevY = dot(x, J);

  for (int i = 0; i < 160; i++) {
    float r = length(x);
    float dt = clamp(0.06 * r * r / (1.0 + r), 0.015, 2.0);
    vec3 a1 = geoAcc(x, v, h2, J);
    vec3 xn = x + v * dt + 0.5 * a1 * dt * dt;
    vec3 vn = normalize(v + 0.5 * (a1 + geoAcc(xn, v, h2, J)) * dt);
    float rn = length(xn);

    if (uJet.w > 0.5) {
      float yy = dot(xn, J);
      float ay = abs(yy);
      float rho = length(xn - J * yy);
      float wj = 0.4 + uJet.z * ay;
      float e = exp(-(rho * rho) / (wj * wj)) * exp(-ay / uJet.y) * step(1.2, ay);
      col += T * uJetColor * (uJet.x * e * dt);
    }

    float yn = dot(xn, J);
    if (uDisk.w > 0.0 && prevY * yn < 0.0) {
      float f = prevY / (prevY - yn);
      vec3 xc = mix(x, xn, f);
      float rc = length(xc);
      if (rc > rIn && rc < uDisk.y) {
        float vk = min(sqrt(0.5 / max(rc - 1.0, 0.05)), 0.95);   // orbital speed seen by a static observer
        vec3 tang = normalize(cross(J, xc));
        vec3 nph = -vn;                                           // photon travels from the disc to the camera
        float gam = inversesqrt(1.0 - vk * vk);
        float gd = 1.0 / (gam * (1.0 - vk * dot(tang, nph)));    // Doppler
        float g = gd * sqrt(max(1.0 - 1.0 / rc, 0.0)) / gcam;    // times gravitational redshift
        float xr = rIn / rc;
        float Tl = uDisk.z * 2.0 * pow(xr, 0.75) * pow(max(1.0 - sqrt(xr), 0.0), 0.25);
        float Tobs = Tl * g;
        float ang = atan(dot(xc, Vd), dot(xc, Ud)) - uTime * 4.0 / pow(rc, 1.5);
        float turb = 0.6 + 0.8 * fbm(vec3(cos(ang), sin(ang), 0.0) * rc * 1.3 + vec3(0.0, 0.0, rc * 2.0));
        turb *= 0.85 + 0.3 * sin(rc * 14.0);
        vec3 em = blackbody(Tobs) * (RSUN * pow(Tobs / 5772.0, 4.0)) * turb;
        float edge = smoothstep(rIn, rIn * 1.08, rc) * (1.0 - smoothstep(uDisk.y * 0.8, uDisk.y, rc));
        float al = clamp(uDisk.w * edge, 0.0, 1.0);
        col += T * em * al;
        T *= 1.0 - al;
      }
    }
    prevY = yn;

    if (rn <= rcap) {
      if (surfR > 0.0) {
        float gs = sqrt(max(1.0 - 1.0 / rcap, 0.001)) / gcam;
        float Ts = uSurf.y * gs;
        float mu = clamp(dot(normalize(xn), -vn), 0.0, 1.0);
        col += T * blackbody(Ts) * (RSUN * pow(Ts / 5772.0, 4.0)) * (0.4 + 0.6 * mu);
      } else {
        col += T * uGlow;
      }
      T = 0.0;
      break;
    }
    x = xn;
    v = vn;
    if (i > 2 && rn > rEsc && dot(x, v) > 0.0) {
      escaped = true;
      break;
    }
  }
  if (escaped) col += T * lensed(v);
  oColor = outc(col * w, w);
}
`;

// ---------------------------------------------------------------------------------------------
// Traversable wormhole (Ellis metric): null geodesics in (l, psi); rays crossing the throat see the
// other universe, rays that bounce see this universe's lensed scene.
// ---------------------------------------------------------------------------------------------
export const WORMHOLE_FRAG =
  PRELUDE +
  SKY +
  IMP_HEAD +
  LENS +
  `
uniform float uExtent;
uniform vec3 uOther;
void main() {
  vec3 rd = normalize(vRay);
  vec3 ro = -uCenterR;
  float rcam = length(ro);
  float tt = dot(uCenterR, rd);
  float bimp = tt > 0.0 ? length(uCenterR - rd * tt) : rcam;
  float w = 1.0 - smoothstep(0.7 * uExtent, uExtent, bimp);
  gl_FragDepth = ldepth(max(tt, 0.0) * uRad);
  if (w <= 0.0) discard;

  float R0 = uExtent * 1.2;
  vec3 x = ro;
  if (rcam > R0) {
    vec2 hh = sphereHit(uCenterR, rd, R0);
    if (hh.x < 0.0) discard;
    x = rd * hh.x - uCenterR;
  }
  float rc = length(x);
  vec3 Rh = x / rc;
  float ca = dot(rd, Rh);
  vec3 tp = rd - Rh * ca;
  float sa = length(tp);
  vec3 Th = sa > 1e-5 ? tp / sa : normalize(cross(Rh, abs(Rh.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  float Lm = rc * sa;                       // conserved angular momentum (E = 1, throat radius = 1)
  float l = sqrt(max(rc * rc - 1.0, 0.0));  // proper radial coordinate, + side
  float pl = ca;
  float psi = 0.0;
  float lEsc = l * 1.02 + 1.0;
  for (int i = 0; i < 120; i++) {
    float r2 = l * l + 1.0;
    float ds = clamp(0.05 * sqrt(r2), 0.02, 2.0);
    float lm = l + 0.5 * ds * pl;
    float plm = pl + 0.5 * ds * (Lm * Lm * l / (r2 * r2));
    float r2m = lm * lm + 1.0;
    l += ds * plm;
    pl += ds * (Lm * Lm * lm / (r2m * r2m));
    psi += ds * Lm / r2m;
    if (abs(l) > lEsc && pl * l > 0.0) break;
  }
  vec3 er = Rh * cos(psi) + Th * sin(psi);
  vec3 ep = -Rh * sin(psi) + Th * cos(psi);
  float rr = sqrt(l * l + 1.0);
  vec3 dirOut = normalize(abs(pl) * er + (Lm / rr) * ep);
  vec3 col = l > 0.0 ? lensed(dirOut) : skyRadiance(vec3(dirOut.z, -dirOut.y, dirOut.x)) * expo() * uOther;
  oColor = outc(col * w, w);
}
`;

// ---------------------------------------------------------------------------------------------
// Pulsars / magnetars: two rotating lighthouse beams about the magnetic axis. The star itself is a
// 'compact' object (neutron star surface) placed at the same position.
// ---------------------------------------------------------------------------------------------
export const PULSAR_FRAG =
  PRELUDE +
  IMP_HEAD +
  `
uniform vec3 uSpin;
uniform float uTilt;
uniform vec3 uColor;
uniform float uSharp;
uniform float uSpinPh;   // spin phase of the magnetic axis, wrapped in float64 on the CPU
void main() {
  vec3 rd = normalize(vRay);
  gl_FragDepth = ldepth(max(dot(uCenterR, rd), 0.0) * uRad);
  vec2 h = sphereHit(uCenterR, rd, 1.0);
  if (h.y < 0.0) discard;
  float t0 = max(h.x, 0.0);
  float dt = (h.y - t0) / 28.0;
  vec3 S = normalize(uSpin);
  vec3 U = normalize(cross(S, abs(S.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 V = cross(S, U);
  float ph = uSpinPh;
  vec3 axis = normalize(cos(uTilt) * S + sin(uTilt) * (cos(ph) * U + sin(ph) * V));
  float jit = hash13(vec3(gl_FragCoord.xy, uFrame));
  float e = 0.0;
  for (int i = 0; i < 28; i++) {
    vec3 p = rd * (t0 + (float(i) + jit) * dt) - uCenterR;
    float r = length(p);
    if (r > 1.0 || r < 0.004) continue;
    float ca = abs(dot(p / r, axis));
    float beam = pow(ca, uSharp);
    e += beam / (0.02 + r * r) * (1.0 - smoothstep(0.8, 1.0, r)) * dt;
  }
  oColor = outc(uColor * e * 0.05 * expo(), 0.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Pulsar magnetic field lines: the dipole r = L sin^2(theta) about the magnetic axis, drawn as thin
// camera-facing ribbons (one instance per segment, geometry generated from gl_InstanceID, no buffers).
// The axis is tilted from the spin axis and the whole field rotates rigidly with the star, exactly like
// the beams in PULSAR_FRAG. Lengths are in units of the pulsar's radius (beam length); L runs up to
// ~0.92 so the outermost closed line sits just inside the light cylinder.
// ---------------------------------------------------------------------------------------------
export const FIELD_VERT =
  PRELUDE +
  `
const int NAZ = ${FIELD_AZ};
const int NSEG = ${FIELD_SEGS};
uniform vec3 uCenterR;
uniform float uRad;
uniform vec3 uSpin;
uniform float uTilt;
uniform float uSpinPh;   // spin phase of the magnetic axis, wrapped in float64 on the CPU
out float vAcross;
out float vGlow;
out float vDist;
vec3 dipole(float L, float th, float az, vec3 m, vec3 e1, vec3 e2) {
  float r = L * sin(th) * sin(th);
  return r * (sin(th) * (cos(az) * e1 + sin(az) * e2) + cos(th) * m);
}
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float(gl_VertexID >> 1) * 2.0 - 1.0);
  int seg = gl_InstanceID % NSEG;
  int line = gl_InstanceID / NSEG;
  int sh = line / NAZ;
  int az = line - sh * NAZ;
  float L = 0.20 + 0.24 * float(sh);
  float az0 = 6.2831853 * (float(az) + 0.5 * float(sh & 1)) / float(NAZ);
  vec3 S = normalize(uSpin);
  vec3 U = normalize(cross(S, abs(S.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 V = cross(S, U);
  float ph = uSpinPh;
  vec3 Uph = cos(ph) * U + sin(ph) * V;
  vec3 Vph = -sin(ph) * U + cos(ph) * V;
  vec3 m = cos(uTilt) * S + sin(uTilt) * Uph;
  vec3 e1 = -sin(uTilt) * S + cos(uTilt) * Uph;
  vec3 e2 = Vph;
  float thMin = asin(sqrt(0.012 / L));
  float u0 = float(seg) / float(NSEG);
  float u1 = float(seg + 1) / float(NSEG);
  vec3 p0 = dipole(L, thMin + (PI - 2.0 * thMin) * u0, az0, m, e1, e2);
  vec3 p1 = dipole(L, thMin + (PI - 2.0 * thMin) * u1, az0, m, e1, e2);
  vec3 q0 = uCenterR + p0;
  vec3 q1 = uCenterR + p1;
  vec3 c0 = vec3(dot(q0, uCamRight), dot(q0, uCamUp), dot(q0, uCamFwd));
  vec3 c1 = vec3(dot(q1, uCamRight), dot(q1, uCamUp), dot(q1, uCamFwd));
  if (c0.z < 1e-3 || c1.z < 1e-3) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAcross = 0.0;
    vGlow = 0.0;
    vDist = 1.0;
    return;
  }
  vec2 s0 = c0.xy / (c0.z * uTanHalf) * 0.5 * uRes;   // pixels
  vec2 s1 = c1.xy / (c1.z * uTanHalf) * 0.5 * uRes;
  vec2 dv = s1 - s0;
  float dl = length(dv);
  vec2 tdir = dl > 1e-4 ? dv / dl : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tdir.y, tdir.x);
  bool end1 = corner.x > 0.0;
  vec2 e = end1 ? s1 : s0;
  float halfW = 2.5;
  vec2 pos = e + nrm * corner.y * halfW;
  gl_Position = vec4(pos / (0.5 * uRes) + uJitter, 0.0, 1.0);
  vAcross = corner.y * halfW;
  vGlow = exp(-1.4 * length(end1 ? p1 : p0));
  vDist = safeLen(end1 ? q1 : q0) * uRad;
}
`;

export const FIELD_FRAG =
  PRELUDE +
  `
in float vAcross;
in float vGlow;
in float vDist;
uniform vec3 uColor;
uniform float uField;
layout(location = 0) out vec4 oColor;
void main() {
  float a = exp(-vAcross * vAcross / (2.0 * 0.75 * 0.75));   // ~1.8 px wide core, soft edge
  gl_FragDepth = ldepth(vDist);
  oColor = outc(uColor * (0.35 * uField * vGlow * a) * expo(), 0.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Post: luminance metering, GPU auto-exposure, dual-filter bloom, ACES tone map + sRGB + dither.
// ---------------------------------------------------------------------------------------------
export const FSQ_VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FSQ_HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 o;
`;

export const LUM_FRAG =
  FSQ_HEAD +
  `
uniform sampler2D uHdr;
void main() {
  vec3 c = textureLod(uHdr, vUv, 4.0).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float m = smoothstep(0.0005, 0.004, l);   // meter lit pixels only, so black space does not skew exposure
  o = vec4(log2(max(l, 1e-6)) * m, m, 0.0, 1.0);
}
`;

export const ADAPT_FRAG =
  FSQ_HEAD +
  `
uniform sampler2D uLum;
uniform sampler2D uPrev;
uniform float uKey;
uniform float uBias;
uniform float uMin;
uniform float uMax;
uniform float uK;
uniform float uTop;
uniform float uDark;   // 0..1: camera is over the night side of a planet or moon (uMax is already lowered to that ceiling)
void main() {
  vec4 m = textureLod(uLum, vec2(0.5), uTop);
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  // Something lit: normal metering, untouched. Nothing lit: dark-adapt towards uMax, except over a night side, where the
  // exposure is held instead, so the unlit ground, night lights and faint residue are never pulled up out of the black.
  float want = m.y > 2e-4 ? prev * uKey / exp2(m.x / m.y) * uBias : mix(uMax * uBias, prev, uDark);
  want = clamp(want, uMin, uMax);
  // uMax is a hard ceiling, applied after the smoothing too: over a night side it drops with the camera, and the
  // exposure must not lag above it (a slow fall would show the faintest lit specks at the old, higher exposure).
  o = vec4(min(exp2(mix(log2(prev), log2(want), uK)), uMax), 0.0, 0.0, 1.0);
}
`;

export const DOWN_FRAG =
  FSQ_HEAD +
  `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uClamp;
void main() {
  vec3 s = textureLod(uTex, vUv, 0.0).rgb * 4.0;
  s += textureLod(uTex, vUv + uTexel * vec2(-1.0, -1.0), 0.0).rgb;
  s += textureLod(uTex, vUv + uTexel * vec2(1.0, -1.0), 0.0).rgb;
  s += textureLod(uTex, vUv + uTexel * vec2(-1.0, 1.0), 0.0).rgb;
  s += textureLod(uTex, vUv + uTexel * vec2(1.0, 1.0), 0.0).rgb;
  s /= 8.0;
  if (uClamp > 0.5) s = min(s, vec3(256.0));
  o = vec4(s, 1.0);
}
`;

export const UP_FRAG =
  FSQ_HEAD +
  `
uniform sampler2D uTex;
uniform vec2 uHalf;
void main() {
  vec3 s = textureLod(uTex, vUv + vec2(-uHalf.x * 2.0, 0.0), 0.0).rgb;
  s += textureLod(uTex, vUv + vec2(-uHalf.x, uHalf.y), 0.0).rgb * 2.0;
  s += textureLod(uTex, vUv + vec2(0.0, uHalf.y * 2.0), 0.0).rgb;
  s += textureLod(uTex, vUv + vec2(uHalf.x, uHalf.y), 0.0).rgb * 2.0;
  s += textureLod(uTex, vUv + vec2(uHalf.x * 2.0, 0.0), 0.0).rgb;
  s += textureLod(uTex, vUv + vec2(uHalf.x, -uHalf.y), 0.0).rgb * 2.0;
  s += textureLod(uTex, vUv + vec2(0.0, -uHalf.y * 2.0), 0.0).rgb;
  s += textureLod(uTex, vUv + vec2(-uHalf.x, -uHalf.y), 0.0).rgb * 2.0;
  o = vec4(s / 12.0, 1.0);
}
`;

export const TONE_FRAG =
  FSQ_HEAD +
  `
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform sampler2D uFlare;
uniform float uBloomK;
uniform float uFlareK;
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 oetf(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main() {
  vec3 c = textureLod(uHdr, vUv, 0.0).rgb + uBloomK * textureLod(uBloom, vUv, 0.0).rgb + uFlareK * textureLod(uFlare, vUv, 0.0).rgb;
  c = oetf(aces(c));
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  o = vec4(c + n / 255.0, 1.0);
}
`;

// Shared by the temporal and motion blur passes: current + previous camera, depth decode.
const REPROJ = `
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uTanHalf;
${PREV}
// Scene depth is log2(1 + d/0.1) / log2(1 + 1e27/0.1) of the true radial distance d. Cleared depth (1.0) is "infinitely far".
float distOf(float z) { return 0.1 * (exp2(z * log2(1.0 + 1e28)) - 1.0); }
`;

// ---------------------------------------------------------------------------------------------
// Temporal upscaling (TAAU). The scene is rendered at internal resolution with a Halton sub-pixel
// jitter; each output pixel reconstructs the current frame from the 3x3 jittered samples around it
// (gaussian weights from the true sample distance), reprojects last frame's output through the depth
// buffer and the camera delta (Catmull-Rom), clips it to the local colour box (variance clipping, in a
// luminance-compressed space so HDR highlights do not dominate), and blends. History is re-exposed by
// the auto-exposure change between the two frames, so adaptation never causes brightness ghosts.
// ---------------------------------------------------------------------------------------------
export const TAAU_FRAG =
  FSQ_HEAD +
  REPROJ +
  `
uniform sampler2D uCur;
uniform sampler2D uDepth;
uniform sampler2D uBodyMotion;
uniform sampler2D uBodyMotionDepth;
uniform sampler2D uHist;
uniform sampler2D uExpCur;
uniform sampler2D uExpPrev;
uniform vec2 uInRes;
uniform vec2 uOutRes;
uniform vec2 uJitterPx;
uniform float uAlpha;
uniform float uReset;
uniform float uFastSimulation;
float lum3(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 cs(vec3 c) { return c / (1.0 + lum3(c)); }
vec3 ics(vec3 c) { return c / max(1.0 - lum3(c), 1e-4); }
vec3 histCR(vec2 uv) {
  vec2 pos = uv * uOutRes;
  vec2 c = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (c - 1.0) / uOutRes;
  vec2 p3 = (c + 2.0) / uOutRes;
  vec2 p12 = (c + w2 / w12) / uOutRes;
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  vec3 r = textureLod(uHist, vec2(p12.x, p0.y), 0.0).rgb * (w12.x * w0.y)
         + textureLod(uHist, vec2(p0.x, p12.y), 0.0).rgb * (w0.x * w12.y)
         + textureLod(uHist, p12, 0.0).rgb * (w12.x * w12.y)
         + textureLod(uHist, vec2(p3.x, p12.y), 0.0).rgb * (w3.x * w12.y)
         + textureLod(uHist, vec2(p12.x, p3.y), 0.0).rgb * (w12.x * w3.y);
  return max(r / ws, 0.0);
}
void main() {
  vec2 pIn = vUv * uInRes;                    // this output pixel's centre, in input-pixel coordinates
  ivec2 ip = ivec2(floor(pIn));
  ivec2 maxT = ivec2(uInRes) - 1;
  vec3 sum = vec3(0.0);
  vec3 m1 = vec3(0.0);
  vec3 m2 = vec3(0.0);
  vec3 mn = vec3(1e9);
  vec3 mx = vec3(-1e9);
  float wsum = 0.0;
  float zMin = 1.0;
  ivec2 nearestT = clamp(ip, ivec2(0), maxT);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 t = clamp(ip + ivec2(i, j), ivec2(0), maxT);
      vec3 s = cs(texelFetch(uCur, t, 0).rgb);
      vec2 d = (vec2(t) + 0.5 - uJitterPx) - pIn;   // sample position is the texel centre minus this frame's jitter
      float w = exp(-2.29 * dot(d, d));
      sum += s * w;
      wsum += w;
      m1 += s;
      m2 += s * s;
      mn = min(mn, s);
      mx = max(mx, s);
      float z = texelFetch(uDepth, t, 0).r;
      if (z < zMin) {
        zMin = z;
        nearestT = t;
      }
    }
  }
  vec3 cur = sum / wsum;
  m1 /= 9.0;
  m2 /= 9.0;
  vec3 sd = sqrt(max(m2 - m1 * m1, 0.0));
  vec3 lo = max(mn, m1 - 1.25 * sd);
  vec3 hi = min(mx, m1 + 1.25 * sd);
  vec3 res = cur;
  vec2 hp;
  bool ok = false;
  float bodyCurrentWeight = 0.0;
  vec2 ndc = vUv * 2.0 - 1.0;
  if (uReset < 0.5) {
    vec4 bodyMotion = texelFetch(uBodyMotion, nearestT, 0);
    float bodyMotionDepth = texelFetch(uBodyMotionDepth, nearestT, 0).r;
    bool bodyPixel = bodyMotionDepth < 0.99999
                  && abs(bodyMotionDepth - zMin) < 2e-6;

    if (bodyPixel) {
      // A body pixel with no valid motion (new body, atmosphere, or animated map effects)
      // must reject history rather than fall back to camera-only reprojection.
      if (bodyMotion.a > 0.5) {
        hp = bodyMotion.xy;
        bodyCurrentWeight = bodyMotion.z;
        ok = all(greaterThanEqual(hp, vec2(0.0)))
          && all(lessThanEqual(hp, vec2(1.0)));
      }
    } else if (uFastSimulation < 0.5) {
      vec3 rd = normalize(uCamFwd + ndc.x * uTanHalf.x * uCamRight + ndc.y * uTanHalf.y * uCamUp);
      ok = prevNdc(rd, distOf(zMin), hp);
      hp = hp * 0.5 + 0.5;
      ok = ok && all(greaterThanEqual(hp, vec2(0.0))) && all(lessThanEqual(hp, vec2(1.0)));
    }
  }
  if (ok) {
    float rE = texelFetch(uExpCur, ivec2(0), 0).r / max(texelFetch(uExpPrev, ivec2(0), 0).r, 1e-30);
    vec3 h = cs(histCR(hp) * rE);
    // clip the history toward the box centre along the line to the neighbourhood mean
    vec3 dir = h - m1;
    vec3 ext = max(max(abs(hi - m1), abs(m1 - lo)), vec3(1e-5));
    float k = max(max(abs(dir.x) / ext.x, abs(dir.y) / ext.y), max(abs(dir.z) / ext.z, 1.0));
    h = m1 + dir / k;
    float vpx = length((hp - vUv) * uOutRes);
    float a = max(
      mix(uAlpha, max(uAlpha, 0.3), clamp(vpx / 8.0, 0.0, 1.0)),
      bodyCurrentWeight
    );
    res = mix(h, cur, a);
  }
  o = vec4(ics(res), 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Camera motion blur. Velocity comes from depth reprojection (current view vs previous view), so no
// velocity buffer is needed for a static world. 12 jittered taps along the pixel's motion; a tap that
// is a nearer object only contributes if its own blur reaches this pixel, so foreground does not leak.
// Nearer moving bodies also smear outward over the background behind them (second loop in main).
// Pixels with no depth (sky, stars, galaxies) are skipped: the sky and star shaders blur themselves.
// ---------------------------------------------------------------------------------------------
export const MB_FRAG =
  FSQ_HEAD +
  REPROJ +
  `
uniform sampler2D uImg;
uniform sampler2D uDepth;
uniform vec2 uRes;
uniform vec2 uMBp;      // x shutter, y max blur (px)
uniform vec4 uSmA[8];   // smear objects: centre uv, velocity uv/frame
uniform vec4 uSmB[8];   // radius (fraction of height), nearest depth, farthest depth
uniform float uFrameN;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 velUv(vec2 uv, float z) {
  if (z >= 0.99999) return vec2(0.0);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 rd = normalize(uCamFwd + ndc.x * uTanHalf.x * uCamRight + ndc.y * uTanHalf.y * uCamUp);
  vec2 pn;
  if (!prevNdc(rd, distOf(z), pn)) return vec2(0.0);
  return (ndc - pn) * 0.5;
}
void main() {
  vec2 uv = vUv;
  vec4 c0 = textureLod(uImg, uv, 0.0);
  float z = textureLod(uDepth, uv, 0.0).r;
  float j = ign(gl_FragCoord.xy + 5.588238 * uFrameN);
  vec3 col = c0.rgb;
  // 1. the pixel's own motion
  vec2 v = velUv(uv, z) * uMBp.x;
  float lp = length(v * uRes);
  if (lp >= 0.75) {
    v *= min(1.0, uMBp.y / lp);
    lp = min(lp, uMBp.y);
    vec3 acc = c0.rgb;
    float ws = 1.0;
    for (int i = 0; i < 12; i++) {
      float t = (float(i) + j) / 12.0 - 0.5;
      vec2 su = uv + v * t;
      float zs = textureLod(uDepth, su, 0.0).r;
      float w = 1.0;
      if (zs < z - 0.003) {
        float reach = 0.5 * length(velUv(su, zs) * uMBp.x * uRes);
        w = clamp(reach / (abs(t) * lp + 0.5), 0.0, 1.0);
      }
      acc += textureLod(uImg, su, 0.0).rgb * w;
      ws += w;
    }
    col = acc / ws;
  }
  // 2. outward smear: a nearer, moving object (planet, star) sweeps over the background behind it.
  //    The renderer passes the 8 biggest ones: screen centre, velocity, radius and depth range.
  for (int k = 0; k < 8; k++) {
    vec4 A = uSmA[k];
    vec4 B = uSmB[k];
    if (B.x <= 0.0) continue;
    if (z <= B.z + 0.002) continue;   // this pixel is the object itself, or nearer than it
    vec2 vo = A.zw * uMBp.x;
    float lo = length(vo * uRes);
    if (lo < 1.5) continue;
    vo *= min(1.0, uMBp.y / lo);
    lo = min(lo, uMBp.y);
    vec2 pp = (uv - A.xy) * uRes;
    vec2 dir = vo * uRes / lo;
    float along = dot(pp, dir);
    float perp = length(pp - dir * along);
    float rad = B.x * uRes.y;
    if (perp > rad + 2.0 || abs(along) > rad + 0.5 * lo + 2.0) continue;
    float n = 0.0;
    vec3 s = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      vec2 su = uv + vo * ((float(i) + j) / 12.0 - 0.5);
      float zs = textureLod(uDepth, su, 0.0).r;
      if (zs >= B.y - 0.002 && zs <= B.z + 0.002) {
        s += textureLod(uImg, su, 0.0).rgb;
        n += 1.0;
      }
    }
    if (n > 0.0) col = mix(col, s / n, n / 12.0);
  }
  o = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------------------------
// Lens-flare ghosts (pseudo-flare): bright pixels of the quarter-res bloom level are re-imaged through
// the lens centre at several scales, mirrored and magnified, tinted per element, with chromatic
// dispersion, and faded toward the frame edge. Needs no occlusion query: whatever is bright and visible
// makes ghosts, so a planet crossing the Sun kills them automatically.
// ---------------------------------------------------------------------------------------------
export const FLARE_FRAG =
  FSQ_HEAD +
  `
uniform sampler2D uSrc;
uniform float uStrength;
const float GS[6] = float[6](-1.6, -0.9, 0.55, 1.35, 2.2, 3.4);
const vec3 GT[6] = vec3[6](
  vec3(0.55, 0.75, 1.0), vec3(1.0, 0.65, 0.45), vec3(0.6, 1.0, 0.7),
  vec3(0.8, 0.55, 1.0), vec3(1.0, 0.85, 0.5), vec3(0.5, 0.9, 1.0));
vec3 feat(vec2 p) {
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return vec3(0.0);
  vec3 c = textureLod(uSrc, p, 0.0).rgb;
  float l = max(c.r, max(c.g, c.b));
  return c * (max(l - 6.0, 0.0) / max(l, 1e-4));
}
void main() {
  vec2 toC = vec2(0.5) - vUv;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float k = GS[i];
    float d = 0.012 * (1.0 + 0.4 * float(i));
    vec3 s = vec3(feat(vUv + toC * (k + d)).r, feat(vUv + toC * k).g, feat(vUv + toC * (k - d)).b);
    float w = pow(clamp(1.0 - length(vUv + toC * k - 0.5) / 0.7071, 0.0, 1.0), 2.0);
    acc += s * GT[i] * w;
  }
  o = vec4(acc * uStrength, 1.0);
}
`;
