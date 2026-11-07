"use strict";
var Solar = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // graphics/solar/solar.ts
  var solar_exports = {};
  __export(solar_exports, {
    startSolar: () => startSolar
  });

  // packages/core/src/coords.ts
  var Tier = {
    Universe: 0,
    Supercluster: 1,
    Galaxy: 2,
    System: 3,
    Planet: 4,
    Surface: 5
  };
  var SPLIT = [100, 1e3, 1e6, 1e6, 1e5];
  var split = (t) => SPLIT[t];
  var CELL_SIZE_M = (() => {
    const sizes = new Array(Tier.Surface + 1);
    let size = 1e4;
    for (let t = Tier.Surface; t >= Tier.Universe; t--) {
      sizes[t] = size;
      if (t > Tier.Universe) size *= split(t - 1);
    }
    return sizes;
  })();
  var cell = (t) => CELL_SIZE_M[t];
  function wrap(sector, local, c) {
    let k = Math.floor(local / c);
    let l = local - k * c;
    if (l >= c) {
      k += 1;
      l = 0;
    } else if (l < 0) {
      l = 0;
    }
    return [sector + k, l];
  }
  function makePos(tier, sector, local) {
    const c = cell(tier);
    const [sx, lx] = wrap(sector[0], local[0], c);
    const [sy, ly] = wrap(sector[1], local[1], c);
    const [sz, lz] = wrap(sector[2], local[2], c);
    return { tier, sector: [sx, sy, sz], local: [lx, ly, lz] };
  }
  function stepFiner(p) {
    const r = split(p.tier);
    const f = cell(p.tier + 1);
    const kx = Math.floor(p.local[0] / f);
    const ky = Math.floor(p.local[1] / f);
    const kz = Math.floor(p.local[2] / f);
    return makePos(
      p.tier + 1,
      [p.sector[0] * r + kx, p.sector[1] * r + ky, p.sector[2] * r + kz],
      [p.local[0] - kx * f, p.local[1] - ky * f, p.local[2] - kz * f]
    );
  }
  function stepCoarser(p) {
    const r = split(p.tier - 1);
    const f = cell(p.tier);
    const sx = Math.floor(p.sector[0] / r);
    const sy = Math.floor(p.sector[1] / r);
    const sz = Math.floor(p.sector[2] / r);
    return makePos(
      p.tier - 1,
      [sx, sy, sz],
      [
        (p.sector[0] - sx * r) * f + p.local[0],
        (p.sector[1] - sy * r) * f + p.local[1],
        (p.sector[2] - sz * r) * f + p.local[2]
      ]
    );
  }
  function toTier(p, target) {
    let q = p;
    while (q.tier < target) q = stepFiner(q);
    while (q.tier > target) q = stepCoarser(q);
    return q;
  }
  function deltaInto(out, offset, a, b) {
    const tier = Math.max(a.tier, b.tier);
    const pa = a.tier === tier ? a : toTier(a, tier);
    const pb = b.tier === tier ? b : toTier(b, tier);
    const c = cell(tier);
    out[offset] = (pa.sector[0] - pb.sector[0]) * c + (pa.local[0] - pb.local[0]);
    out[offset + 1] = (pa.sector[1] - pb.sector[1]) * c + (pa.local[1] - pb.local[1]);
    out[offset + 2] = (pa.sector[2] - pb.sector[2]) * c + (pa.local[2] - pb.local[2]);
  }

  // graphics/gl.ts
  function compile(gl, type, src, name) {
    const s = gl.createShader(type);
    if (!s) throw new Error("createShader failed");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) ?? "";
      gl.deleteShader(s);
      throw new Error(`Shader "${name}" failed to compile:
${log}`);
    }
    return s;
  }
  var Prog = class {
    gl;
    name;
    program;
    /** Frame id the per-frame uniforms were last uploaded for (managed by the renderer). */
    frame = -1;
    locs = /* @__PURE__ */ new Map();
    constructor(gl, name, vs, fs) {
      this.gl = gl;
      this.name = name;
      const p = gl.createProgram();
      if (!p) throw new Error("createProgram failed");
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name + ".vert"));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name + ".frag"));
      gl.bindAttribLocation(p, 0, "aCorner");
      gl.bindAttribLocation(p, 1, "aPos");
      gl.bindAttribLocation(p, 2, "aLum");
      gl.bindAttribLocation(p, 3, "aTemp");
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`Program "${name}" failed to link:
${gl.getProgramInfoLog(p) ?? ""}`);
      }
      this.program = p;
    }
    loc(n) {
      let l = this.locs.get(n);
      if (l === void 0) {
        l = this.gl.getUniformLocation(this.program, n);
        this.locs.set(n, l);
      }
      return l;
    }
    /** float / vec2 / vec3 / vec4 from scalar arguments. */
    f(n, a, b, c, d) {
      const l = this.loc(n);
      if (!l) return;
      const g = this.gl;
      if (b === void 0) g.uniform1f(l, a);
      else if (c === void 0) g.uniform2f(l, a, b);
      else if (d === void 0) g.uniform3f(l, a, b, c);
      else g.uniform4f(l, a, b, c, d);
    }
    /** vec2 / vec3 / vec4 from an array-like. */
    v(n, a) {
      const l = this.loc(n);
      if (!l) return;
      const g = this.gl;
      const x = a[0];
      const y = a[1];
      if (a.length === 2) g.uniform2f(l, x, y);
      else if (a.length === 3) g.uniform3f(l, x, y, a[2]);
      else g.uniform4f(l, x, y, a[2], a[3]);
    }
    i(n, x) {
      const l = this.loc(n);
      if (l) this.gl.uniform1i(l, x);
    }
    /** vec4 array uniform. */
    v4(n, a) {
      const l = this.loc(n);
      if (l) this.gl.uniform4fv(l, a);
    }
  };
  function createTarget(gl, w, h, fmt, o = {}) {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("createTarget: allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = o.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
    const nearest = fmt === gl.R32F || fmt === gl.RGBA32F;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : o.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    let depth = null;
    let depthTex = null;
    if (o.depthTexture) {
      depthTex = gl.createTexture();
      if (!depthTex) throw new Error("createTarget: depth texture allocation failed");
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    } else if (o.depth) {
      depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer incomplete (0x${status.toString(16)}) ${w}x${h}`);
    return { fbo, tex, depth, depthTex, w, h };
  }
  function destroyTarget(gl, t) {
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
    if (t.depth) gl.deleteRenderbuffer(t.depth);
    if (t.depthTex) gl.deleteTexture(t.depthTex);
  }
  function solidTexture(gl, r, g, b, a) {
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }
  async function loadTexture(gl, url, o = {}) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Texture ${url}: HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, o.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, bmp.width, bmp.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    bmp.close();
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) {
      const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
    }
    return tex;
  }

  // graphics/shaders.ts
  var FIELD_SHELLS = 4;
  var FIELD_AZ = 8;
  var FIELD_SEGS = 40;
  var FIELD_INSTANCES = FIELD_SHELLS * FIELD_AZ * FIELD_SEGS;
  var PROM_LOOPS = 6;
  var PREV = `
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
  var PRELUDE = `#version 300 es
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
  var IMP_VERT = PRELUDE + `
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
  var SKY = `
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
  var IMP_HEAD = `
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
  var SKY_FRAG = PRELUDE + SKY + IMP_HEAD + `
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
  var STAR_VERT = PRELUDE + `
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
  var STAR_FRAG = PRELUDE + `
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
  var GLOW_FRAG = PRELUDE + IMP_HEAD + `
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
  var GALAXY_FRAG = PRELUDE + IMP_HEAD + `
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
  var NEBULA_FRAG = PRELUDE + IMP_HEAD + `
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
  var STAR_SURFACE_FRAG = PRELUDE + IMP_HEAD + `
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
  var BODY_FRAG = PRELUDE + IMP_HEAD + `
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
  var RING_FRAG = PRELUDE + IMP_HEAD + `
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
  var LENS = `
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
  var COMPACT_FRAG = PRELUDE + SKY + IMP_HEAD + LENS + `
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
  var WORMHOLE_FRAG = PRELUDE + SKY + IMP_HEAD + LENS + `
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
  var PULSAR_FRAG = PRELUDE + IMP_HEAD + `
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
  var FIELD_VERT = PRELUDE + `
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
  var FIELD_FRAG = PRELUDE + `
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
  var FSQ_VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;
  var FSQ_HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 o;
`;
  var LUM_FRAG = FSQ_HEAD + `
uniform sampler2D uHdr;
void main() {
  vec3 c = textureLod(uHdr, vUv, 4.0).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float m = smoothstep(0.0005, 0.004, l);   // meter lit pixels only, so black space does not skew exposure
  o = vec4(log2(max(l, 1e-6)) * m, m, 0.0, 1.0);
}
`;
  var ADAPT_FRAG = FSQ_HEAD + `
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
  var DOWN_FRAG = FSQ_HEAD + `
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
  var UP_FRAG = FSQ_HEAD + `
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
  var TONE_FRAG = FSQ_HEAD + `
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
  var REPROJ = `
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uTanHalf;
${PREV}
// Scene depth is log2(1 + d/0.1) / log2(1 + 1e27/0.1) of the true radial distance d. Cleared depth (1.0) is "infinitely far".
float distOf(float z) { return 0.1 * (exp2(z * log2(1.0 + 1e28)) - 1.0); }
`;
  var TAAU_FRAG = FSQ_HEAD + REPROJ + `
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
  var MB_FRAG = FSQ_HEAD + REPROJ + `
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
  var FLARE_FRAG = FSQ_HEAD + `
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

  // graphics/renderer.ts
  var AU = 149597870700;
  var NIGHT_FULL = 8;
  var NIGHT_FADE = 30;
  var EARTH_ATMOSPHERE = {
    height: 12e4,
    betaR: [58e-7, 135e-7, 331e-7],
    betaM: 21e-6,
    hR: 8e3,
    hM: 1200,
    g: 0.76
  };
  var clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  var dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  var cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  var norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  var RECAL_FRAMES = 16;
  var RECAL_FAST_PX = 3;
  var RECAL_SETTLED_PX = 1.5;
  var CLOUD_DRIFT_RATE = 9e-4;
  var FLOW_PERIOD = 50;
  var recalWeight = (age) => age >= RECAL_FRAMES ? 0 : 1 / (age + 1);
  var wrapPi = (a) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  var wrap01 = (x) => x - Math.floor(x);
  var TAU = 2 * Math.PI;
  var wrapBy = (x, m) => x - m * Math.floor(x / m);
  var wrapTau = (x) => wrapBy(x, TAU);
  var NOISE_WRAP = 16384;
  var DUST_CYCLES = 1048576;
  function dustPhase(t) {
    const q = t / 240;
    const n = Math.floor(q);
    return [q - n, wrapBy(n, DUST_CYCLES), wrapBy(t * 0.01, NOISE_WRAP)];
  }
  var spinPhase = (time, period, phase) => TAU * wrap01(time / Math.max(period, 1e-4) + phase / TAU);
  function stepRecal(prev, body, distance, pxPerRad, simReturned) {
    const last = prev?.recal;
    if (!prev || !last) return { age: 0, moving: false };
    const a0 = norm(prev.spin);
    const a1 = norm(body.spin);
    const turn = Math.hypot(
      wrapPi(body.rot - prev.rot),
      Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2])
    );
    const discRad = Math.asin(Math.min(1, body.radius / Math.max(distance, 1e-9)));
    const px = turn * discRad * pxPerRad;
    let age = last.age + 1;
    let moving = last.moving;
    if (!moving) {
      moving = px >= RECAL_FAST_PX;
    } else if (px < RECAL_SETTLED_PX) {
      moving = false;
      age = 0;
    }
    if (simReturned) age = 0;
    return { age: Math.min(age, RECAL_FRAMES), moving };
  }
  function copyWorldPos(pos) {
    return {
      tier: pos.tier,
      sector: [pos.sector[0], pos.sector[1], pos.sector[2]],
      local: [pos.local[0], pos.local[1], pos.local[2]]
    };
  }
  function extentOf(o) {
    switch (o.kind) {
      case "star":
        return 1.8;
      case "body":
        return (1 + (o.atmosphere ? o.atmosphere.height / o.radius : 0)) * 1.02;
      case "ring":
        return o.outer * 1.02;
      case "compact":
        return Math.max(o.extent ?? 24, (o.disk?.outer ?? 0) * 1.1, (o.surface?.radius ?? 0) * 1.1);
      case "wormhole":
        return o.extent ?? 8;
      default:
        return 1;
    }
  }
  var halton = (i, b) => {
    let f = 1;
    let r = 0;
    for (let n = i; n > 0; n = Math.floor(n / b)) {
      f /= b;
      r += f * (n % b);
    }
    return r;
  };
  var smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  function hash01(a, b, c, d) {
    let h = Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 2246822507) ^ Math.imul(c | 0, 3266489909) ^ Math.imul(d | 0, 668265263);
    h ^= h >>> 15;
    h = Math.imul(h, 739982445);
    h ^= h >>> 12;
    h = Math.imul(h, 695872825);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function starLoops(o, time, out) {
    const act = clamp(o.activity ?? 0, 0, 1);
    const seed = Math.floor((o.seed ?? 0) * 1e3);
    const S0 = norm(o.spin ?? [0, 1, 0]);
    const U = norm(cross(S0, Math.abs(S0[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
    const V = cross(S0, U);
    for (let k = 0; k < PROM_LOOPS; k++) {
      const per = 70 + 90 * hash01(k, seed, 0, 1);
      const tt = time / per + hash01(k, seed, 0, 2);
      const cyc = Math.floor(tt);
      const x = tt - cyc;
      const h = (salt) => hash01(k, seed, cyc, salt);
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
      const ex = [U[0] * Math.cos(lon) + V[0] * Math.sin(lon), U[1] * Math.cos(lon) + V[1] * Math.sin(lon), U[2] * Math.cos(lon) + V[2] * Math.sin(lon)];
      const east = [-U[0] * Math.sin(lon) + V[0] * Math.cos(lon), -U[1] * Math.sin(lon) + V[1] * Math.cos(lon), -U[2] * Math.sin(lon) + V[2] * Math.cos(lon)];
      const c = [S0[0] * sl + ex[0] * cl, S0[1] * sl + ex[1] * cl, S0[2] * sl + ex[2] * cl];
      const north = [S0[0] * cl - ex[0] * sl, S0[1] * cl - ex[1] * sl, S0[2] * cl - ex[2] * sl];
      const cp = Math.cos(psi);
      const sp = Math.sin(psi);
      const t = [east[0] * cp + north[0] * sp, east[1] * cp + north[1] * sp, east[2] * cp + north[2] * sp];
      const i = k * 12;
      out[i] = c[0];
      out[i + 1] = c[1];
      out[i + 2] = c[2];
      out[i + 3] = phi;
      out[i + 4] = t[0];
      out[i + 5] = t[1];
      out[i + 6] = t[2];
      out[i + 7] = H;
      out[i + 8] = w;
      out[i + 9] = life;
      out[i + 10] = flare;
      out[i + 11] = (h(14) - 0.5) * 0.12;
    }
  }
  var Renderer = class {
    gl;
    canvas;
    /** Filled every frame, handy for a debug overlay. */
    stats = { objects: 0, impostors: 0, points: 0, tiles: 0, scale: 1 };
    scale;
    dynamic;
    bloomK;
    ex;
    P;
    quadBuf;
    quadVao;
    emptyVao;
    pointVbo;
    pointVao;
    points = new Float32Array(5 * 4096);
    np = 0;
    tiles = /* @__PURE__ */ new Map();
    blank;
    hdr;
    copy;
    bloom = [];
    flare = null;
    mb = null;
    hist = [];
    motion = null;
    histIdx = 0;
    histValid = false;
    bodyHistory = /* @__PURE__ */ new WeakMap();
    recalNow = /* @__PURE__ */ new Map();
    temporal;
    mbShutter;
    flareK;
    cutNext = true;
    prevPos = null;
    prevRight = [1, 0, 0];
    prevUp = [0, 1, 0];
    prevFwd = [0, 0, 1];
    prevTanX = 1;
    prevTanY = 1;
    prevTime = 0;
    alphaTaa = 0.1;
    fastSimulation = false;
    dprev = new Float64Array(3);
    loops = new Float32Array(PROM_LOOPS * 12);
    smearA = new Float32Array(32);
    smearB = new Float32Array(32);
    lum;
    expo;
    expIdx = 0;
    /** Weight 0..1 of 'camera is over a planet/moon night side' and the exposure ceiling that goes with it. */
    nightK = 0;
    nightCap = 5e6;
    sky = { map: null, cmb: null, mapScale: 34e-10, cmbScale: 0 };
    frame = 0;
    fu;
    rel = new Float64Array(3);
    t3 = new Float64Array(3);
    occ = new Float32Array(16);
    ema = 1 / 60;
    dynTick = 0;
    constructor(canvas, opts = {}) {
      const gl = canvas.getContext("webgl2", {
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        powerPreference: "high-performance"
      });
      if (!gl) throw new Error("WebGL2 is not available");
      if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float is required for HDR rendering");
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
        nightMax: opts.exposure?.nightMax ?? 5,
        key: opts.exposure?.key ?? 0.18,
        tau: opts.exposure?.tau ?? 0.6,
        initial: opts.exposure?.initial ?? 1
      };
      const mk = (n, vs, fs) => new Prog(gl, n, vs, fs);
      this.P = {
        sky: mk("sky", IMP_VERT, SKY_FRAG),
        glow: mk("glow", IMP_VERT, GLOW_FRAG),
        galaxy: mk("galaxy", IMP_VERT, GALAXY_FRAG),
        nebula: mk("nebula", IMP_VERT, NEBULA_FRAG),
        surface: mk("surface", IMP_VERT, STAR_SURFACE_FRAG),
        body: mk("body", IMP_VERT, BODY_FRAG),
        ring: mk("ring", IMP_VERT, RING_FRAG),
        compact: mk("compact", IMP_VERT, COMPACT_FRAG),
        wormhole: mk("wormhole", IMP_VERT, WORMHOLE_FRAG),
        pulsar: mk("pulsar", IMP_VERT, PULSAR_FRAG),
        field: mk("field", FIELD_VERT, FIELD_FRAG),
        stars: mk("stars", STAR_VERT, STAR_FRAG),
        lum: mk("lum", FSQ_VERT, LUM_FRAG),
        adapt: mk("adapt", FSQ_VERT, ADAPT_FRAG),
        down: mk("down", FSQ_VERT, DOWN_FRAG),
        up: mk("up", FSQ_VERT, UP_FRAG),
        tone: mk("tone", FSQ_VERT, TONE_FRAG),
        taau: mk("taau", FSQ_VERT, TAAU_FRAG),
        blur: mk("blur", FSQ_VERT, MB_FRAG),
        flare: mk("flare", FSQ_VERT, FLARE_FRAG)
      };
      const qb = gl.createBuffer();
      const qv = gl.createVertexArray();
      const ev = gl.createVertexArray();
      const pb = gl.createBuffer();
      if (!qb || !qv || !ev || !pb) throw new Error("buffer allocation failed");
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
    loadTexture(url, o) {
      return loadTexture(this.gl, url, o);
    }
    /**
     * Real-sky backgrounds. `map`: star map (sRGB). `cmb`: Planck map shown as false colour.
     * Scales are radiance multipliers; the defaults put the Milky Way near 21 mag/arcsec^2.
     */
    setSky(s) {
      if (s.map !== void 0) this.sky.map = s.map;
      if (s.cmb !== void 0) this.sky.cmb = s.cmb;
      if (s.mapScale !== void 0) this.sky.mapScale = s.mapScale;
      if (s.cmbScale !== void 0) this.sky.cmbScale = s.cmbScale;
    }
    /** Upload (or remove, with null) a star catalogue tile. */
    setStarTile(id, t) {
      const gl = this.gl;
      const old = this.tiles.get(id);
      if (old) {
        gl.deleteVertexArray(old.vao);
        gl.deleteBuffer(old.vbo);
        this.tiles.delete(id);
      }
      if (!t || t.count === 0) return;
      const vbo = gl.createBuffer();
      if (!vbo) throw new Error("createBuffer failed");
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, t.data.subarray(0, t.count * 5), gl.STATIC_DRAW);
      this.tiles.set(id, { vao: this.makeStarVao(vbo), vbo, count: t.count, origin: t.origin });
    }
    /** Call on window resize (and once at startup; the constructor already does). */
    resize() {
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
    resetTemporal() {
      this.cutNext = true;
    }
    render(scene, cam, dt) {
      const gl = this.gl;
      const P = this.P;
      this.frame++;
      this.autoScale(dt);
      const W = this.hdr.w;
      const H = this.hdr.h;
      const tanY = Math.tan(cam.fovY / 2);
      const tanX = tanY * (W / H);
      const maxHalf = Math.atan(Math.hypot(tanX, tanY));
      this.np = 0;
      const imps = [];
      let minD = Infinity;
      for (const o of scene.objects) {
        deltaInto(this.rel, 0, o.pos, cam.pos);
        const rx = this.rel[0];
        const ry = this.rel[1];
        const rz = this.rel[2];
        const d = Math.max(Math.hypot(rx, ry, rz), 1e-9);
        minD = Math.min(minD, d);
        const ext = o.radius * extentOf(o);
        const cosA = (rx * cam.forward[0] + ry * cam.forward[1] + rz * cam.forward[2]) / d;
        if (d > ext * 1.05 && Math.acos(clamp(cosA, -1, 1)) - Math.asin(Math.min(1, ext / d)) > maxHalf) continue;
        const px = ext / d / tanY * H * 0.5;
        if (px < 1.5) {
          if ((o.lum ?? 0) > 0) this.pushPoint(rx, ry, rz, o.lum ?? 0, o.temp ?? 5772);
          continue;
        }
        imps.push({ o, rx, ry, rz, d, sortD: o.kind === "ring" ? d - o.radius * 0.01 : d, ext });
      }
      imps.sort((a, b) => b.sortD - a.sortD);
      const bodies = scene.objects.filter((o) => o.kind === "body");
      deltaInto(this.dprev, 0, this.prevPos ?? cam.pos, cam.pos);
      const stepLen = Math.hypot(
        this.dprev[0],
        this.dprev[1],
        this.dprev[2]
      );
      const simRate = Math.abs(scene.time - this.prevTime) / Math.max(dt, 1e-3);
      const fastSimulation = simRate > 1.25;
      const fastSimulationChanged = fastSimulation !== this.fastSimulation;
      const simReturnedToNormal = this.fastSimulation && !fastSimulation;
      const cut = this.cutNext || this.prevPos === null || dot(this.prevFwd, cam.forward) < 0.9 || Math.abs(tanY / this.prevTanY - 1) > 0.15 || stepLen > 0.4 * minD || fastSimulationChanged;
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
      this.fastSimulation = fastSimulation;
      this.alphaTaa = 0.1 + 0.2 * clamp(
        Math.log2(Math.max(simRate, 1)) / 6,
        0,
        1
      );
      this.prevTime = scene.time;
      const hj = this.frame % 16 + 1;
      const useTemporalJitter = this.temporal;
      const jpx = useTemporalJitter ? halton(hj, 2) - 0.5 : 0;
      const jpy = useTemporalJitter ? halton(hj, 3) - 0.5 : 0;
      this.fu = {
        right: cam.right,
        up: cam.up,
        fwd: cam.forward,
        tanX,
        tanY,
        w: W,
        h: H,
        sr: (2 * tanY / H) ** 2,
        time: scene.time,
        jx: 2 * jpx / W,
        jy: 2 * jpy / H,
        jpx,
        jpy,
        pRight: this.prevRight,
        pUp: this.prevUp,
        pFwd: this.prevFwd,
        ptx: this.prevTanX,
        pty: this.prevTanY,
        drx: this.dprev[0],
        dry: this.dprev[1],
        drz: this.dprev[2],
        mbOn: this.mbShutter > 0 && !cut && !fastSimulation,
        maxPx: 0.06 * H
      };
      this.smearA.fill(0);
      this.smearB.fill(0);
      if (this.fu.mbOn) {
        const zOf = (d) => Math.log2(1 + Math.max(d, 0.1) / 0.1) / Math.log2(1 + 1e28);
        const f = this.fu;
        imps.filter((im) => im.o.kind === "body" || im.o.kind === "star").sort((a, b) => b.o.radius / b.d - a.o.radius / a.d).slice(0, 8).forEach((im, k) => {
          const dir = [im.rx / im.d, im.ry / im.d, im.rz / im.d];
          const vz = dot(dir, cam.forward);
          if (vz <= 1e-4) return;
          const nx = dot(dir, cam.right) / (vz * tanX);
          const ny = dot(dir, cam.up) / (vz * tanY);
          const q = [dir[0] - f.drx / im.d, dir[1] - f.dry / im.d, dir[2] - f.drz / im.d];
          const pz = dot(q, f.pFwd);
          let vx = 0;
          let vy = 0;
          if (pz > 1e-4) {
            vx = (nx - dot(q, f.pRight) / (pz * f.ptx)) * 0.5;
            vy = (ny - dot(q, f.pUp) / (pz * f.pty)) * 0.5;
          }
          const R = im.o.radius;
          this.smearA.set([nx * 0.5 + 0.5, ny * 0.5 + 0.5, vx, vy], k * 4);
          this.smearB.set([R / im.d / tanY * 0.5, zOf(im.d - R), zOf(im.d + R), 0], k * 4);
        });
      }
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
        P.sky.f("uFull", 1);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      this.use(P.stars);
      for (const t of this.tiles.values()) {
        deltaInto(this.rel, 0, t.origin, cam.pos);
        P.stars.f("uTileRel", this.rel[0], this.rel[1], this.rel[2]);
        gl.bindVertexArray(t.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, t.count);
      }
      if (this.np > 0) {
        P.stars.f("uTileRel", 0, 0, 0);
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
        if (po.kind === "pulsar" && (po.field ?? 1) > 0) {
          gl.depthMask(false);
          this.drawField(im, po);
          gl.bindVertexArray(this.quadVao);
        }
      }
      this.recalNow.clear();
      if (this.motion) {
        const pxPerRad = 0.5 * this.canvas.height / tanY;
        for (const im of imps) {
          if (im.o.kind !== "body") continue;
          const body = im.o;
          const cached = this.bodyHistory.get(body);
          const previous = cached?.frame === this.frame - 1 ? cached : void 0;
          this.recalNow.set(body, stepRecal(previous, body, im.d, pxPerRad, simReturnedToNormal));
        }
      }
      if (this.motion) {
        this.target(this.motion);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (!cut) {
          gl.bindVertexArray(this.quadVao);
          for (const im of imps) {
            if (im.o.kind !== "body") continue;
            const body = im.o;
            this.setup(im, scene, cam, bodies);
            const cached = this.bodyHistory.get(body);
            const previous = cached?.frame === this.frame - 1 ? cached : void 0;
            let prevX = 0;
            let prevY = 0;
            let prevZ = 0;
            if (previous) {
              deltaInto(this.t3, 0, previous.pos, cam.pos);
              prevX = this.t3[0] / body.radius;
              prevY = this.t3[1] / body.radius;
              prevZ = this.t3[2] / body.radius;
            }
            P.body.f("uPrevBodyCenterR", prevX, prevY, prevZ);
            P.body.v("uPrevSpin", previous?.spin ?? body.spin);
            P.body.f("uPrevRot", previous?.rot ?? body.rot);
            const prevTime = previous?.time ?? scene.time;
            P.body.v("uPrevDustT", dustPhase(prevTime));
            P.body.f("uTimeStep", Math.abs(scene.time - prevTime));
            P.body.f("uPrevCloudDrift", wrap01(prevTime * CLOUD_DRIFT_RATE * (body.flow ?? 0)));
            P.body.f("uPrevFlowPhase", wrap01(prevTime / FLOW_PERIOD));
            P.body.f("uPrevRadiusRatio", previous ? previous.radius / body.radius : 1);
            P.body.f("uPrevBodyValid", previous ? 1 : 0);
            P.body.f("uRecalWeight", recalWeight(this.recalNow.get(body)?.age ?? RECAL_FRAMES));
            P.body.f("uMotionPass", 1);
            gl.depthMask(true);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        }
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
      }
      for (const body of bodies) {
        this.bodyHistory.set(body, {
          pos: copyWorldPos(body.pos),
          spin: [body.spin[0], body.spin[1], body.spin[2]],
          rot: body.rot,
          radius: body.radius,
          time: scene.time,
          frame: this.frame,
          recal: this.recalNow.get(body) ?? null
        });
      }
      this.prevPos = cam.pos;
      this.prevRight = cam.right;
      this.prevUp = cam.up;
      this.prevFwd = cam.forward;
      this.prevTanX = tanX;
      this.prevTanY = tanY;
      this.stats = { objects: scene.objects.length, impostors: imps.length, points: this.np, tiles: this.tiles.size, scale: this.scale };
      this.nightSide(scene, cam, bodies);
      this.post(dt);
    }
    dispose() {
      const gl = this.gl;
      for (const t of this.tiles.values()) {
        gl.deleteVertexArray(t.vao);
        gl.deleteBuffer(t.vbo);
      }
      this.tiles.clear();
      for (const t of [this.hdr, this.copy, this.lum, ...this.expo, ...this.bloom, ...this.hist]) destroyTarget(gl, t);
      if (this.flare) destroyTarget(gl, this.flare);
      if (this.motion) destroyTarget(gl, this.motion);
      if (this.mb) destroyTarget(gl, this.mb);
      for (const p of Object.values(this.P)) gl.deleteProgram(p.program);
      gl.deleteBuffer(this.quadBuf);
      gl.deleteBuffer(this.pointVbo);
      gl.deleteTexture(this.blank);
    }
    // ---------------------------------------------------------------- internals
    makeStarVao(vbo) {
      const gl = this.gl;
      const vao = gl.createVertexArray();
      if (!vao) throw new Error("createVertexArray failed");
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
    buildTargets() {
      const gl = this.gl;
      for (const t of [this.hdr, this.copy, this.flare, this.mb, this.motion, ...this.bloom]) if (t) destroyTarget(gl, t);
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      const W = Math.max(2, Math.round(cw * this.scale));
      const H = Math.max(2, Math.round(ch * this.scale));
      this.hdr = createTarget(gl, W, H, gl.RGBA16F, { depthTexture: true, mips: true });
      this.copy = createTarget(gl, W, H, gl.RGBA16F);
      this.motion = this.temporal ? createTarget(gl, W, H, gl.RGBA32F, { depthTexture: true }) : null;
      const FW = this.temporal ? cw : W;
      const FH = this.temporal ? ch : H;
      if (this.temporal && (this.hist.length !== 2 || this.hist[0].w !== cw || this.hist[0].h !== ch)) {
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
    autoScale(dt) {
      if (!this.dynamic) return;
      this.ema += (dt - this.ema) * 0.05;
      this.dynTick++;
      if (this.dynTick < 45) return;
      let s = this.scale;
      if (this.ema > 1 / 48) s -= 0.1;
      else if (this.ema < 1 / 58 && this.dynTick > 300) s += 0.05;
      s = clamp(s, 0.9, 1);
      if (Math.abs(s - this.scale) > 1e-3) {
        this.scale = s;
        this.buildTargets();
        this.dynTick = 0;
      }
    }
    pushPoint(x, y, z, lum, temp) {
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
    bindTex(unit2, tex) {
      this.gl.activeTexture(this.gl.TEXTURE0 + unit2);
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex ?? this.blank);
    }
    /** Bind a program and upload the per-frame uniforms once per frame. */
    use(p) {
      this.gl.useProgram(p.program);
      if (p.frame === this.frame) return;
      p.frame = this.frame;
      const f = this.fu;
      p.v("uCamRight", f.right);
      p.v("uCamUp", f.up);
      p.v("uCamFwd", f.fwd);
      p.f("uTanHalf", f.tanX, f.tanY);
      p.f("uRes", f.w, f.h);
      p.f("uPixelSr", f.sr);
      p.f("uTime", f.time);
      p.f("uFrame", this.frame % 1024);
      p.f("uJitter", f.jx, f.jy);
      p.v("uPrevRight", f.pRight);
      p.v("uPrevUp", f.pUp);
      p.v("uPrevFwd", f.pFwd);
      p.f("uPrevTan", f.ptx, f.pty);
      p.f("uPrevRel", f.drx, f.dry, f.drz);
      p.f("uMB", this.mbShutter, f.mbOn ? 1 : 0, f.maxPx, 0);
      p.f("uSky", this.sky.mapScale, this.sky.cmbScale, this.sky.map ? 1 : 0, this.sky.cmb ? 1 : 0);
      p.i("uExp", 7);
      p.i("uMapTex", 5);
      p.i("uCmbTex", 6);
      p.i("uScene", 8);
      p.i("uAlbedo", 0);
      p.i("uNight", 1);
      p.i("uClouds", 2);
      p.i("uMask", 3);
      p.i("uHeight", 4);
      p.i("uRingTex", 9);
      p.i("uFlare", 10);
    }
    grabScene() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.hdr.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.copy.fbo);
      gl.blitFramebuffer(0, 0, this.hdr.w, this.hdr.h, 0, 0, this.hdr.w, this.hdr.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo);
      this.bindTex(8, this.copy.tex);
    }
    lightUniforms(p, pos, lights, lightId) {
      const light = lightId === void 0 ? lights[0] : lights.find((l) => l.id === lightId);
      if (!light) {
        p.f("uLight", 0, 1, 0, 0);
        p.f("uLightT", 5772);
        p.f("uLightAng", 46e-4);
        return;
      }
      deltaInto(this.t3, 0, light.pos, pos);
      const dx = this.t3[0];
      const dy = this.t3[1];
      const dz = this.t3[2];
      const d = Math.hypot(dx, dy, dz) || 1;
      const r = AU / d;
      p.f("uLight", dx / d, dy / d, dz / d, light.lum * r * r);
      p.f("uLightT", light.temp);
      p.f("uLightAng", Math.asin(clamp(light.radius / d, 0, 1)));
    }
    /** Bind program + all uniforms for one impostor. */
    setup(im, scene, cam, bodies) {
      const o = im.o;
      const P = this.P;
      const p = { glow: P.glow, galaxy: P.galaxy, nebula: P.nebula, star: P.surface, body: P.body, ring: P.ring, compact: P.compact, wormhole: P.wormhole, pulsar: P.pulsar }[o.kind];
      this.use(p);
      const unit2 = o.radius;
      const d = im.d;
      const dir = [im.rx / d, im.ry / d, im.rz / d];
      const ref = Math.abs(dot(dir, cam.up)) < 0.9 ? cam.up : cam.right;
      const t1 = norm(cross(dir, ref));
      const t2 = cross(dir, t1);
      const inside = d <= im.ext * 1.05;
      const tanR = inside ? 0 : im.ext / Math.sqrt(d * d - im.ext * im.ext);
      p.f("uCenterR", im.rx / unit2, im.ry / unit2, im.rz / unit2);
      p.f("uRad", unit2);
      p.v("uDir", dir);
      p.v("uT1", t1);
      p.v("uT2", t2);
      p.f("uTanR", tanR * 1.05);
      p.f("uFull", inside || tanR > 2.5 ? 1 : 0);
      const ext = extentOf(o);
      switch (o.kind) {
        case "glow": {
          const a = o.axis ?? [0, 0, 0];
          p.f("uAxisR", a[0] / unit2, a[1] / unit2, a[2] / unit2);
          p.v("uColor", o.color);
          p.f("uSeed", o.seed ?? 0);
          return { opaque: false, grab: false };
        }
        case "galaxy": {
          p.v("uNormal", o.normal);
          p.f("uType", o.type === "spiral" ? 0 : o.type === "elliptical" ? 1 : 2);
          p.f("uArms", o.arms ?? 2);
          p.f("uPitch", o.pitch ?? 0.35);
          p.f("uBulge", o.bulge ?? 0.6);
          p.f("uFlat", o.flat ?? (o.type === "elliptical" ? 0.7 : 0.04));
          p.f("uSeed", o.seed ?? 0);
          p.v("uColor", o.color);
          return { opaque: false, grab: false };
        }
        case "nebula": {
          p.v("uColor", o.color);
          p.v("uColor2", o.color2 ?? o.color);
          p.f("uDensity", o.density ?? 1);
          p.f("uNoise", o.noise ?? 1);
          p.f("uSeed", o.seed ?? 0);
          return { opaque: false, grab: false };
        }
        case "star": {
          p.f("uTemp", o.temp);
          p.v("uSpin", o.spin ?? [0, 1, 0]);
          p.f("uSpots", o.spots ?? 0.5);
          p.f("uCell", o.cell ?? 14);
          p.f("uSeed", o.seed ?? 0);
          const ts = scene.time;
          p.f("uStarT0", wrapTau(ts * 0.03), wrap01(ts * 0.04), wrapBy(ts * 0.02, NOISE_WRAP), wrapBy(ts * 0.04, NOISE_WRAP));
          p.f("uStarT1", wrapBy(ts * 0.05, NOISE_WRAP), wrapBy(ts * 0.09, NOISE_WRAP), wrapBy(ts * 0.15, NOISE_WRAP), wrapTau(ts * 0.7));
          p.f("uStarT2", wrapBy(ts * 4e-3, 2), wrap01(ts * 2e-3), wrapBy(ts * 1e-3, 2));
          const st = o.tex ?? {};
          this.bindTex(0, st.albedo);
          this.bindTex(10, st.flare);
          p.f("uHasAlbedo", st.albedo ? 1 : 0);
          p.f("uHasFlare", st.flare ? 1 : 0);
          const act = clamp(o.activity ?? 0, 0, 1);
          p.f("uAct", act);
          if (act > 0) {
            starLoops(o, scene.time, this.loops);
            p.v4("uLoops", this.loops);
          }
          return { opaque: true, grab: false };
        }
        case "body": {
          const R = o.radius;
          const t = o.tex ?? {};
          p.f("uMotionPass", 0);
          p.f("uPrevBodyValid", 0);
          p.f("uCloudDrift", wrap01(scene.time * CLOUD_DRIFT_RATE * (o.flow ?? 0)));
          p.f("uFlowPhase", wrap01(scene.time / FLOW_PERIOD));
          p.f("uVortexSin", Math.sin(scene.time * 0.05), Math.sin(scene.time * 0.021 + 1.3));
          p.v("uDustT", dustPhase(scene.time));
          this.lightUniforms(p, o.pos, scene.lights, o.lightId);
          this.bindTex(0, t.albedo);
          this.bindTex(1, t.night);
          this.bindTex(2, t.clouds);
          this.bindTex(3, t.mask);
          this.bindTex(4, t.height);
          p.f("uHasAlbedo", t.albedo ? 1 : 0);
          p.f("uFlow", o.flow ?? 0);
          p.f("uStorm", o.storm ?? 0);
          const vx = o.vortex;
          p.f("uVortex", vx ? vx[0] : 0, vx ? vx[1] : 0, vx ? vx[2] : 0.1, vx ? vx[3] : 0);
          p.f("uHas", t.night ? 1 : 0, t.clouds ? 1 : 0, t.mask ? 1 : 0, t.height ? 1 : 0);
          p.v("uTint", o.tint ?? [0.5, 0.5, 0.5]);
          p.f("uNightScale", o.nightScale ?? 2e-6);
          p.f("uBump", t.height && o.bump ? o.bump / R : 0);
          p.f("uDetail", o.detail?.albedo ?? 0, o.detail?.relief ?? 0, o.detail?.bands ?? 1, 0);
          p.v("uSpin", o.spin);
          p.f("uRot", o.rot);
          const A = o.atmosphere;
          p.f("uAtmH", A ? A.height / R : 0);
          p.v("uBetaR", A ? [A.betaR[0] * R, A.betaR[1] * R, A.betaR[2] * R] : [0, 0, 0]);
          p.f("uBetaM", A ? A.betaM * R : 0);
          p.f("uHR", A ? A.hR / R : 1);
          p.f("uHM", A ? A.hM / R : 1);
          p.f("uG", A ? A.g : 0);
          this.occ.fill(0);
          const cand = [];
          for (const b of bodies) {
            if (b === o) continue;
            deltaInto(this.t3, 0, b.pos, o.pos);
            const x = this.t3[0];
            const y = this.t3[1];
            const z = this.t3[2];
            cand.push({ x, y, z, r: b.radius, k: Math.hypot(x, y, z) / b.radius });
          }
          cand.sort((a, b) => a.k - b.k);
          for (let i = 0; i < Math.min(4, cand.length); i++) {
            const c = cand[i];
            if (c) this.occ.set([c.x / R, c.y / R, c.z / R, c.r / R], i * 4);
          }
          p.v4("uOcc", this.occ);
          return { opaque: true, grab: false };
        }
        case "ring": {
          this.lightUniforms(p, o.pos, scene.lights, o.lightId);
          this.bindTex(9, o.tex);
          p.f("uHasRing", o.tex ? 1 : 0);
          p.v("uNormal", o.normal);
          p.f("uIn", o.inner);
          p.f("uOut", o.outer);
          const rn = norm(o.normal);
          const re1 = norm(cross(rn, Math.abs(rn[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
          const re2 = cross(rn, re1);
          const cx = -(im.rx * re1[0] + im.ry * re1[1] + im.rz * re1[2]);
          const cy = -(im.rx * re2[0] + im.ry * re2[1] + im.rz * re2[2]);
          const ox = Math.floor(cx / 4096);
          const oy = Math.floor(cy / 4096);
          p.f("uRingH", -(im.rx * rn[0] + im.ry * rn[1] + im.rz * rn[2]));
          p.v("uRingE1", re1);
          p.v("uRingE2", re2);
          p.f("uRingO", ox, oy);
          p.f("uRingF", cx - ox * 4096, cy - oy * 4096);
          return { opaque: true, grab: false };
        }
        case "compact": {
          p.v("uSpin", o.spin ?? [0, 1, 0]);
          p.f("uA", clamp(o.a ?? 0, 0, 0.998));
          p.f("uExtent", ext);
          const dk = o.disk;
          p.f("uDisk", dk?.inner ?? 0, dk?.outer ?? 0, dk?.temp ?? 0, dk ? dk.alpha ?? 0.7 : 0);
          p.f("uSurf", o.surface?.radius ?? 0, o.surface?.temp ?? 0, 0, 0);
          p.v("uGlow", o.glow ?? [0, 0, 0]);
          const j = o.jet;
          p.f("uJet", j?.intensity ?? 0, Math.max(j?.length ?? 1, 1e-3), j?.width ?? 0.1, j ? 1 : 0);
          p.v("uJetColor", j?.color ?? [1, 1, 1]);
          return { opaque: true, grab: true };
        }
        case "wormhole": {
          p.f("uExtent", ext);
          p.v("uOther", o.otherTint ?? [0.6, 0.8, 1.2]);
          return { opaque: true, grab: true };
        }
        case "pulsar": {
          p.v("uSpin", o.spin);
          p.f("uTilt", o.tilt);
          p.v("uColor", o.color);
          p.f("uSharp", o.sharp ?? 250);
          p.f("uSpinPh", spinPhase(scene.time, o.period, o.phase ?? 0));
          return { opaque: false, grab: false };
        }
      }
    }
    /** Dipole field lines of a pulsar: one instanced ribbon per segment, geometry generated in the vertex shader. */
    drawField(im, o) {
      const gl = this.gl;
      const p = this.P.field;
      this.use(p);
      const unit2 = o.radius;
      p.f("uCenterR", im.rx / unit2, im.ry / unit2, im.rz / unit2);
      p.f("uRad", unit2);
      p.v("uSpin", o.spin);
      p.f("uTilt", o.tilt);
      p.f("uSpinPh", spinPhase(this.fu.time, o.period, o.phase ?? 0));
      p.v("uColor", o.color);
      p.f("uField", o.field ?? 1);
      gl.bindVertexArray(this.emptyVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, FIELD_INSTANCES);
    }
    /** Camera + previous camera uniforms for the full-screen reprojection passes. */
    setReproj(p) {
      const f = this.fu;
      p.v("uCamRight", f.right);
      p.v("uCamUp", f.up);
      p.v("uCamFwd", f.fwd);
      p.f("uTanHalf", f.tanX, f.tanY);
      p.v("uPrevRight", f.pRight);
      p.v("uPrevUp", f.pUp);
      p.v("uPrevFwd", f.pFwd);
      p.f("uPrevTan", f.ptx, f.pty);
      p.f("uPrevRel", f.drx, f.dry, f.drz);
    }
    /** Temporal upscale: jittered internal-res frame + reprojected history -> canvas-res frame. */
    resolve() {
      const gl = this.gl;
      const p = this.P.taau;
      const dst = this.hist[this.histIdx];
      const src = this.hist[1 - this.histIdx];
      this.target(dst);
      gl.useProgram(p.program);
      this.bindTex(0, this.hdr.tex);
      this.bindTex(1, this.hdr.depthTex);
      this.bindTex(2, src.tex);
      this.bindTex(3, this.expo[this.expIdx].tex);
      this.bindTex(4, this.expo[1 - this.expIdx].tex);
      this.bindTex(5, this.motion?.tex);
      this.bindTex(6, this.motion?.depthTex);
      p.i("uBodyMotion", 5);
      p.i("uBodyMotionDepth", 6);
      p.i("uCur", 0);
      p.i("uDepth", 1);
      p.i("uHist", 2);
      p.i("uExpCur", 3);
      p.i("uExpPrev", 4);
      p.f("uInRes", this.hdr.w, this.hdr.h);
      p.f("uOutRes", dst.w, dst.h);
      p.f("uJitterPx", this.fu.jpx, this.fu.jpy);
      p.f("uAlpha", this.alphaTaa);
      p.f("uReset", this.histValid ? 0 : 1);
      p.f("uFastSimulation", this.fastSimulation ? 1 : 0);
      this.setReproj(p);
      this.tri();
      this.histIdx = 1 - this.histIdx;
      this.histValid = true;
      return dst;
    }
    /** Camera motion blur from depth reprojection. */
    blur(src, out) {
      const gl = this.gl;
      const p = this.P.blur;
      this.target(out);
      gl.useProgram(p.program);
      this.bindTex(0, src.tex);
      this.bindTex(1, this.hdr.depthTex);
      p.i("uImg", 0);
      p.i("uDepth", 1);
      p.f("uRes", out.w, out.h);
      p.f("uMBp", this.mbShutter, 0.06 * out.h);
      p.f("uFrameN", this.frame % 64);
      p.v4("uSmA", this.smearA);
      p.v4("uSmB", this.smearB);
      this.setReproj(p);
      this.tri();
      return out;
    }
    target(t) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, t.fbo);
      this.gl.viewport(0, 0, t.w, t.h);
    }
    tri() {
      this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    }
    /**
     * Is the camera over the night side of the planet or moon it is nearest to? Sets nightK (0..1) and nightCap (the exposure
     * ceiling for that night side). Only the 'nothing lit' branch of the auto-exposure uses it, so metering of anything that is
     * actually lit (a crescent, a sunlit limb, the star itself) is not touched.
     */
    nightSide(scene, cam, bodies) {
      this.nightK = 0;
      this.nightCap = this.ex.max;
      if (!this.ex.auto || bodies.length === 0 || scene.lights.length === 0) return;
      let best = null;
      let bestR = Infinity;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const b of bodies) {
        deltaInto(this.t3, 0, cam.pos, b.pos);
        const x = this.t3[0];
        const y = this.t3[1];
        const z = this.t3[2];
        const r2 = Math.hypot(x, y, z) / Math.max(b.radius, 1);
        if (r2 < bestR) {
          bestR = r2;
          best = b;
          cx = x;
          cy = y;
          cz = z;
        }
      }
      if (!best || bestR >= NIGHT_FADE) return;
      const body = best;
      const light = body.lightId === void 0 ? scene.lights[0] : scene.lights.find((l) => l.id === body.lightId);
      if (!light || !(light.lum > 0)) return;
      deltaInto(this.t3, 0, light.pos, body.pos);
      const lx = this.t3[0];
      const ly = this.t3[1];
      const lz = this.t3[2];
      const ld = Math.hypot(lx, ly, lz) || 1;
      const cd = Math.hypot(cx, cy, cz) || 1;
      const cosZ = (cx * lx + cy * ly + cz * lz) / (cd * ld);
      const night = smooth(0.04, -0.04, cosZ);
      const near = 1 - smooth(NIGHT_FULL, NIGHT_FADE, bestR);
      this.nightK = night * near;
      const r = AU / ld;
      const flux = Math.max(light.lum * r * r, 1e-30);
      this.nightCap = clamp(this.ex.nightMax / flux, this.ex.min, this.ex.max);
    }
    post(dt) {
      const gl = this.gl;
      const P = this.P;
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.depthMask(false);
      gl.bindVertexArray(this.emptyVao);
      let img = this.hdr;
      if (this.temporal) img = this.resolve();
      if (this.mb && this.fu.mbOn) img = this.blur(img, this.mb);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.bindTex(0, img.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.target(this.lum);
      gl.useProgram(P.lum.program);
      P.lum.i("uHdr", 0);
      this.tri();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.bindTex(0, this.lum.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      const B = this.bloom;
      gl.useProgram(P.down.program);
      P.down.i("uTex", 0);
      for (let i = 0; i < B.length; i++) {
        const src = i === 0 ? img : B[i - 1];
        this.bindTex(0, src.tex);
        this.target(B[i]);
        P.down.f("uTexel", 1 / src.w, 1 / src.h);
        P.down.f("uClamp", i === 0 ? 1 : 0);
        this.tri();
      }
      const flareOn = this.flare !== null && B.length >= 2;
      if (this.flare && flareOn) {
        this.target(this.flare);
        gl.useProgram(P.flare.program);
        this.bindTex(0, B[1].tex);
        P.flare.i("uSrc", 0);
        P.flare.f("uStrength", this.flareK * 14e-4);
        this.tri();
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(P.up.program);
      P.up.i("uTex", 0);
      for (let i = B.length - 1; i > 0; i--) {
        const src = B[i];
        this.bindTex(0, src.tex);
        this.target(B[i - 1]);
        P.up.f("uHalf", 0.5 / src.w, 0.5 / src.h);
        this.tri();
      }
      gl.disable(gl.BLEND);
      const cur = this.expo[this.expIdx];
      const nxt = this.expo[1 - this.expIdx];
      const ex = this.ex;
      this.target(nxt);
      gl.useProgram(P.adapt.program);
      this.bindTex(0, this.lum.tex);
      this.bindTex(1, cur.tex);
      P.adapt.i("uLum", 0);
      P.adapt.i("uPrev", 1);
      P.adapt.f("uKey", ex.key);
      P.adapt.f("uBias", ex.auto ? ex.bias : 1);
      P.adapt.f("uMin", ex.auto ? ex.min : ex.manual);
      const dk = ex.auto ? this.nightK : 0;
      const kc = 1 - (1 - dk) * (1 - dk) * (1 - dk);
      const maxEff = ex.auto ? dk > 0 ? Math.pow(2, Math.log2(ex.max) * (1 - kc) + Math.log2(this.nightCap) * kc) : ex.max : ex.manual;
      P.adapt.f("uMax", maxEff);
      P.adapt.f("uDark", dk);
      P.adapt.f("uK", ex.auto ? 1 - Math.exp(-Math.max(dt, 0) / Math.max(ex.tau, 1e-3)) : 1);
      P.adapt.f("uTop", 6);
      this.tri();
      this.expIdx = 1 - this.expIdx;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(P.tone.program);
      this.bindTex(0, img.tex);
      this.bindTex(1, B[0]?.tex);
      this.bindTex(2, flareOn ? this.flare?.tex : this.blank);
      P.tone.i("uHdr", 0);
      P.tone.i("uBloom", 1);
      P.tone.i("uFlare", 2);
      P.tone.f("uBloomK", this.bloomK);
      P.tone.f("uFlareK", flareOn ? 1 : 0);
      this.tri();
    }
  };

  // graphics/solar/solar.ts
  var AU2 = 149597870700;
  var D2R = Math.PI / 180;
  var OBLIQUITY = 23.4392911 * D2R;
  var add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  var sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  var mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  var dot2 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  var len = (a) => Math.hypot(a[0], a[1], a[2]);
  var cross2 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  var unit = (a) => mul(a, 1 / (len(a) || 1));
  var clamp2 = (x, a, b) => Math.min(b, Math.max(a, x));
  function rotate(v, k, a) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return add(add(mul(v, c), mul(cross2(k, v), s)), mul(k, dot2(k, v) * (1 - c)));
  }
  var eclToWorld = (v) => [v[0], v[2], -v[1]];
  var eqToEcl = (v) => [v[0], v[1] * Math.cos(OBLIQUITY) + v[2] * Math.sin(OBLIQUITY), -v[1] * Math.sin(OBLIQUITY) + v[2] * Math.cos(OBLIQUITY)];
  var eqToWorld = (v) => eclToWorld(eqToEcl(v));
  function poleOf(ra, dec) {
    return unit(eqToWorld([Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)]));
  }
  function nodeOf(ra) {
    return unit(eqToWorld([-Math.sin(ra * D2R), Math.cos(ra * D2R), 0]));
  }
  var el = (a, da, e, de, I, dI, L, dL, w, dw, N, dN) => ({ a, da, e, de, I, dI, L, dL, w, dw, N, dN });
  var ELEMENTS = {
    mercury: el(0.38709927, 37e-8, 0.20563593, 1906e-8, 7.00497902, -594749e-8, 252.2503235, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081),
    venus: el(0.72333566, 39e-7, 677672e-8, -4107e-8, 3.39467605, -7889e-7, 181.9790995, 58517.81538729, 131.60246718, 268329e-8, 76.67984255, -0.27769418),
    emb: el(1.00000261, 562e-8, 0.01671123, -4392e-8, -1531e-8, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0),
    mars: el(1.52371034, 1847e-8, 0.0933941, 7882e-8, 1.84969142, -813131e-8, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343),
    jupiter: el(5.202887, -11607e-8, 0.04838624, -13253e-8, 1.30439695, -183714e-8, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106),
    saturn: el(9.53667594, -12506e-7, 0.05386179, -50991e-8, 2.48599187, 193609e-8, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794),
    uranus: el(19.18916464, -196176e-8, 0.04725744, -4397e-8, 0.77263783, -242939e-8, 313.23810451, 428.48202785, 170.9542763, 0.40805281, 74.01692503, 0.04240589),
    neptune: el(30.06992276, 26291e-8, 859048e-8, 5105e-8, 1.77004347, 35372e-8, -55.12002969, 218.45945325, 44.96476227, -0.32241464, 131.78422574, -508664e-8)
  };
  function keplerPos(k, T) {
    const a = (k.a + k.da * T) * AU2;
    const e = k.e + k.de * T;
    const I = (k.I + k.dI * T) * D2R;
    const L = k.L + k.dL * T;
    const w = k.w + k.dw * T;
    const N = (k.N + k.dN * T) * D2R;
    const M = ((L - w) % 360 + 540) % 360 - 180;
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
      so * sI * xp + co * sI * yp
    ]);
  }
  function moonOffset(T) {
    const Lm = (218.3164477 + 481267.88123421 * T) * D2R;
    const Om = (125.0445479 - 1934.1362891 * T) * D2R;
    const inc = 5.145396 * D2R;
    const u = Lm - Om;
    const r = 384399e3;
    return eclToWorld([
      r * (Math.cos(Om) * Math.cos(u) - Math.sin(Om) * Math.sin(u) * Math.cos(inc)),
      r * (Math.sin(Om) * Math.cos(u) + Math.cos(Om) * Math.sin(u) * Math.cos(inc)),
      r * Math.sin(u) * Math.sin(inc)
    ]);
  }
  var earthMoonMassFrac = 1 / (1 + 81.30057);
  var venusAtm = { height: 6e4, betaR: [12e-6, 1e-5, 6e-6], betaM: 4e-5, hR: 15e3, hM: 15e3, g: 0.8 };
  var marsAtm = { height: 4e4, betaR: [6e-7, 14e-7, 33e-7], betaM: 3e-6, hR: 11e3, hM: 11e3, g: 0.75 };
  var jovianAtm = { height: 4e5, betaR: [4e-6, 8e-6, 16e-6], betaM: 1e-7, hR: 27e3, hM: 1e4, g: 0.7 };
  var uranusAtm = { height: 3e5, betaR: [1e-6, 8e-6, 24e-6], betaM: 1e-7, hR: 27e3, hM: 1e4, g: 0.7 };
  var neptuneAtm = { height: 3e5, betaR: [5e-7, 6e-6, 3e-5], betaM: 1e-7, hR: 2e4, hM: 1e4, g: 0.7 };
  function galilean(l0, n, a) {
    return (_T, d, _p, bodies) => {
      const S = poleOf(268.056595, 64.495303);
      const Q = nodeOf(268.056595);
      const th = (l0 + n * d) * D2R;
      const jup = bodies.get("jupiter") ?? [0, 0, 0];
      return add(jup, add(mul(Q, a * Math.cos(th)), mul(cross2(S, Q), a * Math.sin(th))));
    };
  }
  var DEFS = [
    { name: "sun", radius: 6957e5, tint: [1, 1, 1], ra: 286.13, dec: 63.87, w0: 84.176, wRate: 14.184, at: () => [0, 0, 0] },
    { name: "mercury", radius: 2439700, tint: [0.14, 0.135, 0.13], ra: 281.0103, dec: 61.4155, w0: 329.5988, wRate: 6.1385108, at: (T) => keplerPos(ELEMENTS.mercury, T) },
    { name: "venus", radius: 6051800, tint: [0.78, 0.7, 0.5], atm: venusAtm, ra: 272.76, dec: 67.16, w0: 160.2, wRate: -1.4813688, at: (T) => keplerPos(ELEMENTS.venus, T) },
    { name: "earth", radius: 6371e3, tint: [0.12, 0.25, 0.42], atm: EARTH_ATMOSPHERE, ra: 0, dec: 90, w0: 190.147, wRate: 360.9856235, at: (T) => sub(keplerPos(ELEMENTS.emb, T), mul(moonOffset(T), earthMoonMassFrac)) },
    { name: "moon", radius: 1737400, tint: [0.12, 0.115, 0.11], ra: 269.9949, dec: 66.5392, w0: 38.3213, wRate: 13.17635815, parent: "earth", at: (T, _d, _p, b) => add(b.get("earth") ?? [0, 0, 0], moonOffset(T)) },
    { name: "mars", radius: 3389500, tint: [0.45, 0.22, 0.12], atm: marsAtm, ra: 317.68143, dec: 52.8865, w0: 176.63, wRate: 350.89198226, at: (T) => keplerPos(ELEMENTS.mars, T) },
    { name: "jupiter", radius: 69911e3, tint: [0.62, 0.54, 0.42], atm: jovianAtm, ra: 268.056595, dec: 64.495303, w0: 284.95, wRate: 870.536, at: (T) => keplerPos(ELEMENTS.jupiter, T) },
    { name: "io", radius: 1821600, tint: [0.8, 0.65, 0.3], ra: 268.05, dec: 64.5, w0: 200, wRate: 203.4889538, parent: "jupiter", at: galilean(106.07719, 203.48895579, 4218e5) },
    { name: "europa", radius: 1560800, tint: [0.75, 0.7, 0.62], ra: 268.08, dec: 64.51, w0: 36, wRate: 101.3747235, parent: "jupiter", at: galilean(175.73161, 101.374724735, 6711e5) },
    { name: "ganymede", radius: 2634100, tint: [0.45, 0.42, 0.38], ra: 268.2, dec: 64.57, w0: 44, wRate: 50.3176081, parent: "jupiter", at: galilean(120.55883, 50.317609207, 10704e5) },
    { name: "callisto", radius: 2410300, tint: [0.3, 0.27, 0.24], ra: 268.72, dec: 64.83, w0: 259, wRate: 21.5710715, parent: "jupiter", at: galilean(84.44459, 21.571071177, 18827e5) },
    { name: "saturn", radius: 58232e3, tint: [0.75, 0.65, 0.45], atm: jovianAtm, ra: 40.589, dec: 83.537, w0: 38.9, wRate: 810.7939024, at: (T) => keplerPos(ELEMENTS.saturn, T) },
    { name: "uranus", radius: 25362e3, tint: [0.55, 0.75, 0.8], atm: uranusAtm, ra: 257.311, dec: -15.175, w0: 203.81, wRate: -501.1600928, at: (T) => keplerPos(ELEMENTS.uranus, T) },
    { name: "neptune", radius: 24622e3, tint: [0.25, 0.4, 0.8], atm: neptuneAtm, ra: 299.36, dec: 43.46, w0: 253.18, wRate: 536.3128492, at: (T) => keplerPos(ELEMENTS.neptune, T) }
  ];
  var LIVE = /* @__PURE__ */ new Set(["earth", "venus", "jupiter", "saturn", "uranus", "neptune"]);
  var HI_RES = {
    sun: { albedo: "sun", flare: "sun_flare" },
    mercury: { albedo: "mercury" },
    venus: { albedo: "venus" },
    earth: { albedo: "earth", night: "earth_night", clouds: "earth_clouds", mask: "earth_specular", height: "earth_height" },
    moon: { albedo: "moon" },
    mars: { albedo: "mars" },
    jupiter: { albedo: "jupiter" },
    saturn: { albedo: "saturn" },
    uranus: { albedo: "uranus" },
    neptune: { albedo: "neptune" },
    io: { albedo: "io" },
    europa: { albedo: "europa" },
    ganymede: { albedo: "ganymede" },
    callisto: { albedo: "callisto" }
  };
  var GRS_BASE = [0.2493, 0.645, 0.2, 0.6];
  var GRS_HI = [0.351, 0.62, 0.16, 0.6];
  var HI_ENTER = 8;
  var HI_LEAVE = 14;
  var HI_MAX = 2;
  var DETAIL = {
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
    callisto: { albedo: 0.35, relief: 0.1 }
  };
  var HOTKEYS = ["sun", "mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune", "moon"];
  function makeRingTexture(gl, innerKm, outerKm) {
    const n = 2048;
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const r = innerKm + (outerKm - innerKm) * (i + 0.5) / n;
      const rip = 0.85 + 0.15 * Math.sin(r * 0.011 + Math.sin(r * 31e-4) * 3);
      let a = 0;
      let c = [200, 180, 150];
      if (r < 91975) {
        a = 0.2 * rip;
        c = [150, 135, 120];
      } else if (r < 117507) {
        a = Math.min(0.92, 0.55 + (r - 91975) / 25e3) * rip;
        c = [214, 190, 155];
      } else if (r < 122053) {
        a = 0.06;
        c = [170, 155, 135];
      } else {
        a = 0.62 * rip;
        c = [205, 185, 155];
        if (Math.abs(r - 133589) < 165 || Math.abs(r - 136505) < 18) a = 0.05;
      }
      px.set([c[0], c[1], c[2], Math.round(clamp2(a, 0, 1) * 255)], i * 4);
    }
    const tex = gl.createTexture();
    if (!tex) throw new Error("createTexture failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  async function tryLoad(r, url, srgb, clamp3 = false) {
    try {
      return await r.loadTexture(url, { srgb, clamp: clamp3 });
    } catch {
      return null;
    }
  }
  function startSolar(canvas) {
    const renderer = new Renderer(canvas, { dynamicResolution: true, renderScale: 1, motionBlur: 0.5, temporalUpscale: true, lensFlare: 1 });
    const startMs = Date.now();
    const bodyObjs = /* @__PURE__ */ new Map();
    const sunObj = {
      kind: "star",
      pos: makePos(Tier.Planet, [0, 0, 0], [0, 0, 0]),
      radius: 6957e5,
      lum: 1,
      temp: 5772,
      spin: poleOf(286.13, 63.87),
      spots: 0.5,
      cell: 22,
      seed: 0.37,
      activity: 1
    };
    bodyObjs.set("sun", sunObj);
    const objects = [sunObj];
    for (const d of DEFS) {
      if (d.name === "sun") continue;
      const b = { kind: "body", lightId: "solar:sun", pos: sunObj.pos, radius: d.radius, spin: poleOf(d.ra, d.dec), rot: 0, tint: d.tint, lum: 0 };
      if (d.atm) b.atmosphere = d.atm;
      if (LIVE.has(d.name)) b.flow = 1;
      if (d.name === "mars") b.storm = 1;
      if (d.name === "jupiter") b.vortex = GRS_BASE;
      if (d.name === "earth") b.bump = 9e3;
      const dtl = DETAIL[d.name];
      if (dtl) b.detail = dtl;
      bodyObjs.set(d.name, b);
      objects.push(b);
    }
    const satDef = DEFS.find((d) => d.name === "saturn");
    const saturn = bodyObjs.get("saturn");
    const ring = {
      kind: "ring",
      lightId: "solar:sun",
      pos: sunObj.pos,
      radius: satDef?.radius ?? 58232e3,
      normal: saturn.spin,
      inner: 74658e3 / (satDef?.radius ?? 58232e3),
      outer: 136775e3 / (satDef?.radius ?? 58232e3),
      tex: makeRingTexture(renderer.gl, 74658, 136775)
    };
    objects.push(ring);
    const solarLight = {
      id: "solar:sun",
      pos: sunObj.pos,
      lum: 1,
      temp: 5772,
      radius: 6957e5
    };
    const scene = {
      time: 0,
      lights: [solarLight],
      objects
    };
    void (async () => {
      const t = await tryLoad(renderer, "textures/solar/hi/saturn_rings.png", true, true);
      if (!t) return;
      const old = ring.tex;
      ring.tex = t;
      if (old) renderer.gl.deleteTexture(old);
    })();
    const baseTex = /* @__PURE__ */ new Map();
    const hiTex = /* @__PURE__ */ new Map();
    const hiState = /* @__PURE__ */ new Map();
    const hiWanted = /* @__PURE__ */ new Set();
    const maxTexSize = renderer.gl.getParameter(renderer.gl.MAX_TEXTURE_SIZE);
    const applyTex = (name) => {
      const o = bodyObjs.get(name);
      if (!o || o.kind !== "body" && o.kind !== "star") return;
      const merged = { ...baseTex.get(name), ...hiTex.get(name) };
      if (Object.keys(merged).length > 0) o.tex = merged;
      else delete o.tex;
      if (name === "jupiter" && o.kind === "body") o.vortex = hiTex.get(name)?.albedo ? GRS_HI : GRS_BASE;
    };
    const freeSet = (s) => {
      for (const t of [s.albedo, s.night, s.clouds, s.mask, s.height, s.flare]) if (t) renderer.gl.deleteTexture(t);
    };
    const loadHi = async (name) => {
      const spec = HI_RES[name];
      if (!spec || maxTexSize < 4096) {
        hiState.set(name, "failed");
        return;
      }
      hiState.set(name, "loading");
      const set = {};
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
        hiState.set(name, "failed");
        return;
      }
      if (!hiWanted.has(name)) {
        freeSet(set);
        hiState.delete(name);
        return;
      }
      hiTex.set(name, set);
      hiState.set(name, "ready");
      applyTex(name);
    };
    const freeHi = (name) => {
      const set = hiTex.get(name);
      hiTex.delete(name);
      hiState.delete(name);
      applyTex(name);
      if (set) freeSet(set);
    };
    const updateHiRes = (cam) => {
      const near = [];
      for (const def of DEFS) {
        if (!HI_RES[def.name] || hiState.get(def.name) === "failed") continue;
        const r = len(sub(cam, helio.get(def.name) ?? [0, 0, 0])) / def.radius;
        if (r < HI_ENTER || hiState.has(def.name) && r < HI_LEAVE) near.push({ name: def.name, r });
      }
      near.sort((a, b) => a.r - b.r);
      hiWanted.clear();
      for (const n of near.slice(0, HI_MAX)) hiWanted.add(n.name);
      for (const name of hiWanted) if (!hiState.has(name)) void loadHi(name);
      for (const [name, st] of hiState) if (st === "ready" && !hiWanted.has(name)) freeHi(name);
    };
    void (async () => {
      for (const d of DEFS) {
        const o = bodyObjs.get(d.name);
        if (!o || o.kind !== "body" && o.kind !== "star") continue;
        const t = {};
        const albedo = await tryLoad(renderer, `textures/solar/${d.name}.jpg`, true);
        if (albedo) t.albedo = albedo;
        if (d.name === "sun") {
          const flare = await tryLoad(renderer, "textures/solar/sun_flare.jpg", false);
          if (flare) t.flare = flare;
        }
        if (d.name === "earth") {
          const night = await tryLoad(renderer, "textures/solar/earth_night.jpg", true);
          const clouds = await tryLoad(renderer, "textures/solar/earth_clouds.jpg", false);
          const mask = await tryLoad(renderer, "textures/solar/earth_specular.jpg", false);
          const height = await tryLoad(renderer, "textures/solar/earth_height.jpg", false);
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
    const helio = /* @__PURE__ */ new Map();
    let simSeconds = 0;
    let rate = 1;
    let savedRate = 1;
    const setTimeRate = (next) => {
      if (next === rate) return;
      rate = next;
      renderer.resetTemporal();
    };
    let anchor = "sun";
    let camOff = [0, 3e9, 22e10];
    let fwd = [0, -0.01, -1];
    let up = [0, 1, 0];
    let right = unit(cross2(fwd, up));
    const vel = [0, 0, 0];
    let speedMul = 1;
    const keys = /* @__PURE__ */ new Set();
    let dragging = false;
    let last = performance.now();
    let raf = 0;
    const frameState = () => {
      const jd = 24405875e-1 + (startMs + simSeconds * 1e3) / 864e5;
      return { jd, T: (jd - 2451545) / 36525, d: jd - 2451545 };
    };
    const updateEphemeris = () => {
      const { T, d } = frameState();
      for (const def of DEFS) helio.set(def.name, def.at(T, d, [0, 0, 0], helio));
    };
    const orient = () => {
      const { d } = frameState();
      for (const def of DEFS) {
        const o = bodyObjs.get(def.name);
        if (!o || o.kind !== "body") continue;
        const S = poleOf(def.ra, def.dec);
        const Q = nodeOf(def.ra);
        const U = unit(cross2(S, Math.abs(S[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]));
        const V = cross2(S, U);
        const phiQ = Math.atan2(dot2(Q, V), dot2(Q, U));
        o.rot = ((phiQ + (def.w0 + def.wRate * d) * D2R) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      }
    };
    const camHelio = () => add(helio.get(anchor) ?? [0, 0, 0], camOff);
    const setAnchor = (name, off) => {
      anchor = name;
      camOff = off;
      vel.fill(0);
      renderer.resetTemporal();
    };
    const radiusOf = (name) => DEFS.find((d) => d.name === name)?.radius ?? 1;
    const jump = (name) => {
      const p = helio.get(name) ?? [0, 0, 0];
      const toSun = len(p) > 1 ? unit(mul(p, -1)) : unit([0.3, 0.25, 1]);
      const off = mul(unit(add(toSun, [0, 0.25, 0])), radiusOf(name) * (name === "sun" ? 5 : 4));
      fwd = unit(mul(off, -1));
      right = unit(cross2(fwd, [0, 1, 0]));
      up = cross2(right, fwd);
      setAnchor(name, off);
    };
    const onKeyDown = (e) => {
      if (e.repeat) return;
      keys.add(e.code);
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
      const digit = /^Digit(\d)$/.exec(e.code);
      if (digit) {
        jump(HOTKEYS[Number(digit[1])] ?? "sun");
      } else if (e.code === "Period") {
        setTimeRate(rate === 0 ? savedRate * 4 : rate * 4);
      } else if (e.code === "Comma") {
        setTimeRate(rate === 0 ? savedRate / 4 : rate / 4);
      } else if (e.code === "Slash") {
        savedRate = 1;
        setTimeRate(1);
      } else if (e.code === "KeyP") {
        if (rate === 0) {
          setTimeRate(savedRate);
        } else {
          savedRate = rate;
          setTimeRate(0);
        }
      }
    };
    const onKeyUp = (e) => void keys.delete(e.code);
    const look = (dx, dy) => {
      const yaw = -dx * 22e-4;
      const pitch = -dy * 22e-4;
      fwd = unit(rotate(fwd, up, yaw));
      right = unit(rotate(right, up, yaw));
      fwd = unit(rotate(fwd, right, pitch));
      up = unit(cross2(right, fwd));
      right = unit(cross2(fwd, up));
    };
    const onMove = (e) => {
      if (document.pointerLockElement === canvas || dragging) look(e.movementX, e.movementY);
    };
    const onDown = (e) => {
      if (e.button === 0) dragging = true;
    };
    const onUp = () => {
      dragging = false;
    };
    const onClick = () => {
      Promise.resolve(canvas.requestPointerLock()).catch(() => void 0);
    };
    const onWheel = (e) => {
      e.preventDefault();
      speedMul = clamp2(speedMul * Math.exp(-e.deltaY * 1e-3), 1 / 64, 64);
    };
    const onResize = () => renderer.resize();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    updateEphemeris();
    jump("earth");
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1e3, 0.1);
      last = now;
      simSeconds += dt * rate;
      updateEphemeris();
      orient();
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
      {
        const rel = sub(ch, helio.get("saturn") ?? [0, 0, 0]);
        const h = Math.abs(dot2(rel, [saturn.spin[0], saturn.spin[1], saturn.spin[2]]));
        const rr = Math.sqrt(Math.max(dot2(rel, rel) - h * h, 0));
        if (rr > ring.inner * ring.radius && rr < ring.outer * ring.radius) alt = Math.min(alt, h);
      }
      const dirIn = [0, 0, 0];
      const k = (c) => keys.has(c) ? 1 : 0;
      const f = k("KeyW") - k("KeyS");
      const s = k("KeyD") - k("KeyA");
      const u = k("Space") - k("KeyC");
      const mv = add(add(mul(fwd, f), mul(right, s)), mul(up, u));
      if (len(mv) > 0) dirIn.splice(0, 3, ...unit(mv));
      const speed = Math.max(alt, 1) * 0.9 * speedMul * (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 6 : 1);
      const a = 1 - Math.exp(-dt / 0.15);
      for (let i = 0; i < 3; i++) vel[i] = vel[i] + (dirIn[i] * speed - vel[i]) * a;
      camOff = add(camOff, mul(vel, dt));
      const roll = (k("KeyE") - k("KeyQ")) * 1.2 * dt;
      if (roll !== 0) {
        right = unit(rotate(right, fwd, roll));
        up = unit(cross2(right, fwd));
      }
      const c2 = camHelio();
      for (const def of DEFS) {
        const p = helio.get(def.name) ?? [0, 0, 0];
        const off = sub(c2, p);
        const dist = len(off);
        if (dist < def.radius + 2) camOff = add(camOff, mul(unit(off), def.radius + 2 - dist));
      }
      updateHiRes(camHelio());
      const origin = helio.get(anchor) ?? [0, 0, 0];
      const at = (p) => makePos(Tier.Planet, [0, 0, 0], sub(p, origin));
      for (const def of DEFS) {
        const o = bodyObjs.get(def.name);
        if (o) o.pos = at(helio.get(def.name) ?? [0, 0, 0]);
      }
      ring.pos = saturn.pos;
      solarLight.pos = sunObj.pos;
      scene.time = simSeconds;
      const cam = { pos: makePos(Tier.Planet, [0, 0, 0], camOff), right, up, forward: fwd, fovY: 60 * Math.PI / 180 };
      renderer.render(scene, cam, dt);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      renderer.dispose();
    };
  }
  return __toCommonJS(solar_exports);
})();
