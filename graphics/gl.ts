/**
 * graphics/gl.ts
 * Thin WebGL2 helpers: shader programs, render targets, texture loading.
 * Knows nothing about the scene; renderer.ts builds on it.
 */

export function compile(gl: WebGL2RenderingContext, type: number, src: string, name: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error('createShader failed');
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s) ?? '';
    gl.deleteShader(s);
    throw new Error(`Shader "${name}" failed to compile:\n${log}`);
  }
  return s;
}

/** A linked program with cached uniform lookups. Unknown/optimised-out uniforms are silently skipped. */
export class Prog {
  readonly gl: WebGL2RenderingContext;
  readonly name: string;
  readonly program: WebGLProgram;
  /** Frame id the per-frame uniforms were last uploaded for (managed by the renderer). */
  frame = -1;
  private locs = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, name: string, vs: string, fs: string) {
    this.gl = gl;
    this.name = name;
    const p = gl.createProgram();
    if (!p) throw new Error('createProgram failed');
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name + '.vert'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name + '.frag'));
    // Fixed attribute slots shared by every program (see renderer VAOs).
    gl.bindAttribLocation(p, 0, 'aCorner');
    gl.bindAttribLocation(p, 1, 'aPos');
    gl.bindAttribLocation(p, 2, 'aLum');
    gl.bindAttribLocation(p, 3, 'aTemp');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`Program "${name}" failed to link:\n${gl.getProgramInfoLog(p) ?? ''}`);
    }
    this.program = p;
  }

  loc(n: string): WebGLUniformLocation | null {
    let l = this.locs.get(n);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, n);
      this.locs.set(n, l);
    }
    return l;
  }

  /** float / vec2 / vec3 / vec4 from scalar arguments. */
  f(n: string, a: number, b?: number, c?: number, d?: number): void {
    const l = this.loc(n);
    if (!l) return;
    const g = this.gl;
    if (b === undefined) g.uniform1f(l, a);
    else if (c === undefined) g.uniform2f(l, a, b);
    else if (d === undefined) g.uniform3f(l, a, b, c);
    else g.uniform4f(l, a, b, c, d);
  }

  /** vec2 / vec3 / vec4 from an array-like. */
  v(n: string, a: ArrayLike<number>): void {
    const l = this.loc(n);
    if (!l) return;
    const g = this.gl;
    const x = a[0] as number;
    const y = a[1] as number;
    if (a.length === 2) g.uniform2f(l, x, y);
    else if (a.length === 3) g.uniform3f(l, x, y, a[2] as number);
    else g.uniform4f(l, x, y, a[2] as number, a[3] as number);
  }

  i(n: string, x: number): void {
    const l = this.loc(n);
    if (l) this.gl.uniform1i(l, x);
  }

  /** vec4 array uniform. */
  v4(n: string, a: Float32Array): void {
    const l = this.loc(n);
    if (l) this.gl.uniform4fv(l, a);
  }
}

export interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  /** 32-bit float depth as a renderbuffer (not sampleable). Null when absent or when depthTex is used. */
  depth: WebGLRenderbuffer | null;
  /** 32-bit float depth as a texture (NEAREST, sampleable by post passes). Null unless requested. */
  depthTex: WebGLTexture | null;
  w: number;
  h: number;
}

/**
 * Colour render target with immutable storage; optional 32-bit float depth and full mip chain.
 * `depth` attaches a renderbuffer. `depthTexture` attaches a sampleable depth texture instead
 * (motion blur and temporal upscaling read it); it implies a depth attachment.
 */
export function createTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  fmt: number,
  o: { depth?: boolean; depthTexture?: boolean; mips?: boolean } = {},
): Target {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) throw new Error('createTarget: allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const levels = o.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
  gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
  const nearest = fmt === gl.R32F;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : o.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let depth: WebGLRenderbuffer | null = null;
  let depthTex: WebGLTexture | null = null;
  if (o.depthTexture) {
    depthTex = gl.createTexture();
    if (!depthTex) throw new Error('createTarget: depth texture allocation failed');
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

export function destroyTarget(gl: WebGL2RenderingContext, t: Target): void {
  gl.deleteFramebuffer(t.fbo);
  gl.deleteTexture(t.tex);
  if (t.depth) gl.deleteRenderbuffer(t.depth);
  if (t.depthTex) gl.deleteTexture(t.depthTex);
}

export function solidTexture(gl: WebGL2RenderingContext, r: number, g: number, b: number, a: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}

export interface TexOptions {
  /** True for colour images (albedo, night lights, sky maps): sampled values come back linear. False for data (height, masks). */
  srgb?: boolean;
  /** Clamp horizontally instead of wrapping (use for 1-D ring profiles). Equirect maps want the default wrap. */
  clamp?: boolean;
}

/** Fetch an image (any browser-decodable format) into a mip-mapped, anisotropically filtered texture. */
export async function loadTexture(gl: WebGL2RenderingContext, url: string, o: TexOptions = {}): Promise<WebGLTexture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Texture ${url}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
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
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic') as
    | { TEXTURE_MAX_ANISOTROPY_EXT: number; MAX_TEXTURE_MAX_ANISOTROPY_EXT: number }
    | null;
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
    gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, max));
  }
  return tex;
}
