/**
 * graphics/gl.ts
 *
 * The runtime shell of the engine: WebGL2 context, frame loop, dynamic
 * resolution, FPS HUD, flight controls, simulation clock and the camera.
 *
 *   const handle = createGL((frame) => { ...draw with frame.gl... });
 *
 * Context and loop
 *   Takes the WebGL2 context from <canvas id="universe"> and runs a
 *   requestAnimationFrame loop. If WebGL2 is missing it shows a message over the
 *   page and throws. A lost context idles the loop; onContextRestored lets the
 *   renderer rebuild its GPU resources. If onFrame throws, the loop stops and
 *   the error is reported once.
 *
 * Resolution scaling
 *   The drawing buffer is the canvas size * devicePixelRatio * a scale between
 *   80% and 100% (never lower). The scale steps down when the 95th-percentile
 *   frame time falls below 55 FPS and creeps back up after a sustained run
 *   above 58 FPS, backing off if raising it keeps failing. frame.resized is true
 *   whenever the drawing buffer changed size: set the viewport and rebuild any
 *   size-dependent targets then.
 *
 * Workload
 *   Per frame it measures the main-thread time (cpuMs) against the frame
 *   interval. If the main thread is busy for most of a slow frame the bottleneck
 *   is reported as 'cpu' and resolution is left alone, since fewer pixels would
 *   not help. Otherwise a slow frame is 'gpu' and resolution steps down. The
 *   renderer reads frame.workload to shed work on whichever side is the limit.
 *   A GL call that blocks on a full GPU queue counts as main-thread time.
 *
 * Camera
 *   A WorldPos from coords.ts. Flight moves it with translate(). While moving,
 *   its tier follows the flight speed (the finest tier whose cell is at least
 *   one second of flight wide), so the floating origin keeps precision at every
 *   scale and local offsets never overflow. toTier() may keep it at a coarser
 *   tier far from the origin; that is expected.
 *
 * Controls
 *   Click the canvas      capture the mouse (Esc releases it)
 *   Mouse                 look around (while captured)
 *   W A S D               fly forward / left / back / right along the view
 *   Mouse wheel           flight speed x2 per notch up, /2 per notch down
 *                         (1.4 m/s walking pace to 1e27 m/s)
 *   Shift                 x10 flight speed while held
 *   > or .                simulation speed x10 (up to 1e18 x real time)
 *   < or ,                simulation speed /10 (down to 1e-3 x real time)
 *   P                     pause / resume simulation time
 *   /                     normal simulation speed (1x) and resume
 *
 * Gravity
 *   With options.gravity (physics/physics.ts) the camera is a DynamicBody: every frame the simulation time that
 *   passed (simDt) is run through gravity.step(), which pulls the camera towards every mass and keeps its momentum when
 *   you let go of the keys. Flight (WASD) is still applied on top, as before. Time is the simulation's, so the pull is
 *   as real as the clock: speed time up with > to watch yourself fall, pause with P to hold still. A camera that
 *   crosses a horizon is captured and stops being pulled (reload to start again).
 */

import {
  CELL_SIZE_M,
  Tier,
  makePos,
  toTier,
  translate,
  type Vec3,
  type WorldPos,
} from '../packages/core/src/coords';
import type { DynamicBody, GravityModel } from '../physics/physics';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Bottleneck = 'none' | 'cpu' | 'gpu';

/** Smoothed load over the last second or so, refreshed every half second. */
export interface Workload {
  /** Average time between frames, in ms. */
  readonly frameMs: number;
  /** Average main-thread time spent producing a frame, in ms. */
  readonly cpuMs: number;
  /** 'none' while the 55 FPS floor holds, otherwise which side is the limit. */
  readonly bottleneck: Bottleneck;
}

export interface Camera {
  readonly position: WorldPos;
  /** Radians. 0 looks along -Z; positive turns left. */
  readonly yaw: number;
  /** Radians, clamped just inside +-90 degrees. Positive looks up. */
  readonly pitch: number;
  /** Orthonormal view basis in world axes. */
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** Base flight speed in m/s, before the Shift boost. */
  readonly speed: number;
}

export interface FrameInfo {
  readonly gl: WebGL2RenderingContext;
  /** Real seconds since the previous frame, capped at 0.1. */
  readonly dt: number;
  /** Simulation seconds elapsed this frame (0 while paused). */
  readonly simDt: number;
  /** Simulation seconds elapsed since start. */
  readonly simTime: number;
  /** Simulation seconds per real second. */
  readonly simSpeed: number;
  readonly paused: boolean;
  readonly camera: Camera;
  /** Drawing-buffer size in pixels. */
  readonly width: number;
  readonly height: number;
  /** True on the first frame and whenever width or height changed. */
  readonly resized: boolean;
  /** Current resolution scale, 0.8 to 1. */
  readonly resolutionScale: number;
  readonly workload: Workload;
}

export interface GLOptions {
  /** Where the camera starts. Defaults to the world origin at the Surface tier. */
  readonly camera?: WorldPos;
  /** Starting flight speed in m/s. Defaults to walking pace (1.4 m/s). */
  readonly initialSpeed?: number;
  /** Called after the GPU context is restored so GPU resources can be rebuilt. */
  readonly onContextRestored?: (gl: WebGL2RenderingContext) => void;
  /** Gravity that pulls the camera every frame (physics/physics.ts). Omit for a free camera. */
  readonly gravity?: GravityModel;
}

export interface GLHandle {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** Stops the loop and removes every listener and the HUD. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANVAS_ID = 'universe';

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
};

// Frame pacing and dynamic resolution.
const FLOOR_FRAME_MS = 1000 / 55;
const GOOD_FRAME_MS = 1000 / 58;
const MIN_RESOLUTION_SCALE = 0.8;
const RESOLUTION_STEP = 0.05;
const MAX_RESOLUTION_LEVEL = Math.round((1 - MIN_RESOLUTION_SCALE) / RESOLUTION_STEP);
const HISTORY = 60;
const MIN_SAMPLES = 30;
const ADJUST_S = 0.5;
const WARMUP_S = 2;
const BASE_UP_WAIT_S = 2;
const MAX_UP_WAIT_S = 32;
const PROBE_S = 3;
const CPU_BOUND_FRACTION = 0.75;
const MAX_DT_S = 0.1;
const FPS_WINDOW_S = 0.5;

// Flight.
const MIN_SPEED = 1.4; // m/s, walking pace
const MAX_SPEED = 1e27; // m/s, about 3e18 times the speed of light
const SHIFT_BOOST = 10;
const WHEEL_NOTCH = 100;
const MOUSE_SENSITIVITY = 0.0022; // radians per pixel
const PITCH_LIMIT = Math.PI / 2 - 0.001;
const TWO_PI = Math.PI * 2;

// Simulation time, as powers of ten of real time.
const MIN_SIM_EXP = -3;
const MAX_SIM_EXP = 18;

// HUD.
const HUD_SCALE = 3; // CSS pixels per font pixel
const HUD_MARGIN = 8; // CSS pixels
const GLYPH_HEIGHT = 7;
const SPACE_ADVANCE = 4;

/** Keys held down while flying. */
const HELD_KEYS: ReadonlySet<string> = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ShiftLeft',
  'ShiftRight',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Finest tier whose cell is at least `speed` meters wide (Universe if none is). */
function tierForSpeed(speed: number): Tier {
  for (let t: number = Tier.Surface; t > Tier.Universe; t--) {
    if ((CELL_SIZE_M[t] as number) >= speed) return t as Tier;
  }
  return Tier.Universe;
}

function basisFor(yaw: number, pitch: number): { forward: Vec3; right: Vec3; up: Vec3 } {
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  return {
    forward: [-sy * cp, sp, -cy * cp],
    right: [cy, 0, -sy],
    up: [sy * sp, cp, cy * sp],
  };
}

/** Shows a message over the page and throws it. */
function failWebGL2(): never {
  const message =
    'WebGL2 is not available in this browser, so Universe Engine cannot start. ' +
    'Use a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.';
  const box = document.createElement('div');
  box.textContent = message;
  Object.assign(box.style, {
    position: 'fixed',
    inset: '0',
    display: 'grid',
    placeItems: 'center',
    padding: '24px',
    textAlign: 'center',
    background: '#000',
    color: '#fff',
    font: '16px system-ui, sans-serif',
    zIndex: '100',
  });
  document.body.appendChild(box);
  throw new Error(`gl.ts: ${message}`);
}

// ---------------------------------------------------------------------------
// FPS HUD: Minecraft-style pixel text, white with a dark shadow, no background
// ---------------------------------------------------------------------------

/** 5x7 pixel glyphs ('#' = lit). The colon is 1 pixel wide. Anything else renders as a space. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '0': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['.###.', '#...#', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '..#..', '..#..', '..#..'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  ':': ['.', '.', '#', '.', '.', '#', '.'],
};

const glyphWidth = (rows: readonly string[]): number => (rows[0] as string).length;

/** Width of `text` in font pixels, without a trailing gap. */
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const rows = GLYPHS[ch];
    w += rows ? glyphWidth(rows) + 1 : SPACE_ADVANCE;
  }
  return w - 1;
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  px: number,
  color: string,
  ox: number,
  oy: number,
): void {
  ctx.fillStyle = color;
  let x = 0;
  for (const ch of text) {
    const rows = GLYPHS[ch];
    if (!rows) {
      x += SPACE_ADVANCE;
      continue;
    }
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] as string;
      for (let c = 0; c < row.length; c++) {
        if (row[c] === '#') ctx.fillRect(ox + (x + c) * px, oy + r * px, px, px);
      }
    }
    x += glyphWidth(rows) + 1;
  }
}

interface Hud {
  show(text: string): void;
  dispose(): void;
}

function createHud(): Hud {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('gl.ts: the 2D canvas for the FPS HUD is unavailable');
  Object.assign(canvas.style, {
    position: 'fixed',
    left: `${HUD_MARGIN}px`,
    top: `${HUD_MARGIN}px`,
    imageRendering: 'pixelated',
    pointerEvents: 'none',
    userSelect: 'none',
    zIndex: '10',
  });
  document.body.appendChild(canvas);

  let lastText = '';
  let lastPx = 0;
  return {
    show(text: string): void {
      const dpr = window.devicePixelRatio || 1;
      const px = Math.max(1, Math.round(HUD_SCALE * dpr));
      if (text === lastText && px === lastPx) return;
      lastText = text;
      lastPx = px;
      // Resizing the canvas also clears it.
      canvas.width = (textWidth(text) + 1) * px;
      canvas.height = (GLYPH_HEIGHT + 1) * px;
      canvas.style.width = `${canvas.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;
      drawText(ctx, text, px, '#3f3f3f', px, px);
      drawText(ctx, text, px, '#ffffff', 0, 0);
    },
    dispose(): void {
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// Engine shell
// ---------------------------------------------------------------------------

export function createGL(
  onFrame: (frame: FrameInfo) => void,
  options: GLOptions = {},
): GLHandle {
  const canvas = document.getElementById(CANVAS_ID);
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(`gl.ts: <canvas id="${CANVAS_ID}"> was not found in the page`);
  }
  const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  if (gl === null) failWebGL2();

  const maxDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  const maxW = maxDims[0] as number;
  const maxH = maxDims[1] as number;

  const hud = createHud();
  const abort = new AbortController();
  const { signal } = abort;

  // Camera and input.
  let camera: WorldPos = options.camera ?? makePos(Tier.Surface, [0, 0, 0], [0, 0, 0]);
  // The camera as a body for gravity: its velocity is the momentum gravity has given it.
  const fall: DynamicBody = { position: camera, velocity: [0, 0, 0], captured: false };
  let yaw = 0;
  let pitch = 0;
  let speed = clamp(options.initialSpeed ?? MIN_SPEED, MIN_SPEED, MAX_SPEED);
  let locked = false;
  let wheelAccum = 0;
  const keys = new Set<string>();

  // Simulation clock.
  let simExp = 0;
  let paused = false;
  let simTime = 0;

  // Loop state.
  let rafId = 0;
  let prev: number | null = null;
  let clock = 0;
  let lost = false;
  let needsResize = true;
  let cssW = canvas.clientWidth;
  let cssH = canvas.clientHeight;

  // Performance tracking and dynamic resolution.
  let level = 0;
  let workload: Workload = { frameMs: 0, cpuMs: 0, bottleneck: 'none' };
  const frameRing = new Float32Array(HISTORY);
  const cpuRing = new Float32Array(HISTORY);
  const scratch = new Float32Array(HISTORY);
  let head = 0;
  let count = 0;
  let sinceAdjust = 0;
  let goodTime = 0;
  let upWait = BASE_UP_WAIT_S;
  let lastUpAt = -Infinity;
  let fpsFrames = 0;
  let fpsSeconds = 0;

  const resetTiming = (): void => {
    prev = null;
    head = 0;
    count = 0;
    sinceAdjust = 0;
    goodTime = 0;
    fpsFrames = 0;
    fpsSeconds = 0;
  };

  /** Reads the last second of frames and moves the resolution level if needed. */
  const adjustResolution = (): void => {
    const n = count;
    scratch.set(frameRing.subarray(0, n));
    const sorted = scratch.subarray(0, n);
    sorted.sort();
    const p95 = sorted[Math.floor(0.95 * (n - 1))] as number;
    let frameSum = 0;
    let cpuSum = 0;
    for (let i = 0; i < n; i++) {
      frameSum += frameRing[i] as number;
      cpuSum += cpuRing[i] as number;
    }
    const frameMs = frameSum / n;
    const cpuMs = cpuSum / n;
    const cpuBound = cpuMs > CPU_BOUND_FRACTION * frameMs;

    let bottleneck: Bottleneck = 'none';
    let changed = false;
    if (p95 > FLOOR_FRAME_MS) {
      bottleneck = cpuBound ? 'cpu' : 'gpu';
      goodTime = 0;
      if (!cpuBound && level < MAX_RESOLUTION_LEVEL) {
        level += 1;
        changed = true;
        // A step down soon after a step up means the probe failed: wait longer next time.
        if (clock - lastUpAt < PROBE_S) upWait = Math.min(upWait * 2, MAX_UP_WAIT_S);
      }
    } else if (p95 < GOOD_FRAME_MS) {
      goodTime += ADJUST_S;
      if (level > 0 && goodTime >= upWait) {
        // The previous step up survived, so the wait can go back to the base.
        if (clock - lastUpAt > PROBE_S) upWait = BASE_UP_WAIT_S;
        level -= 1;
        changed = true;
        lastUpAt = clock;
        goodTime = 0;
      }
    } else {
      goodTime = 0;
    }

    workload = { frameMs, cpuMs, bottleneck };
    if (changed) {
      // Old samples were rendered at the old resolution.
      head = 0;
      count = 0;
      sinceAdjust = 0;
    }
  };

  // Context loss and restore.
  canvas.addEventListener(
    'webglcontextlost',
    (e) => {
      e.preventDefault();
      lost = true;
    },
    { signal },
  );
  canvas.addEventListener(
    'webglcontextrestored',
    () => {
      lost = false;
      needsResize = true;
      resetTiming();
      options.onContextRestored?.(gl);
    },
    { signal },
  );

  // Canvas size.
  const observer = new ResizeObserver((entries) => {
    const rect = entries[entries.length - 1]?.contentRect;
    if (rect) {
      cssW = rect.width;
      cssH = rect.height;
    }
  });
  observer.observe(canvas);

  // Mouse.
  document.addEventListener(
    'pointerlockchange',
    () => {
      locked = document.pointerLockElement === canvas;
    },
    { signal },
  );
  canvas.addEventListener(
    'click',
    () => {
      if (document.pointerLockElement !== canvas) {
        Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
      }
    },
    { signal },
  );
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!locked) return;
      yaw = (yaw - e.movementX * MOUSE_SENSITIVITY) % TWO_PI;
      pitch = clamp(pitch - e.movementY * MOUSE_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
    },
    { signal },
  );
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 40
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? 400
            : 1;
      const d = e.deltaY * unit;
      if (d === 0) return;
      if (Math.sign(d) !== Math.sign(wheelAccum)) wheelAccum = 0;
      wheelAccum += d;
      if (Math.abs(wheelAccum) < WHEEL_NOTCH) return;
      // Wheel up (negative delta) speeds up, wheel down slows down.
      speed = clamp(wheelAccum < 0 ? speed * 2 : speed / 2, MIN_SPEED, MAX_SPEED);
      wheelAccum = 0;
    },
    { passive: false, signal },
  );

  // Keyboard.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (HELD_KEYS.has(e.code)) {
        keys.add(e.code);
        e.preventDefault();
        return;
      }
      if (e.repeat) return;
      if (e.code === 'KeyP') {
        paused = !paused;
        e.preventDefault();
        return;
      }
      switch (e.key) {
        case '<':
        case ',':
          simExp = Math.max(MIN_SIM_EXP, simExp - 1);
          break;
        case '>':
        case '.':
          simExp = Math.min(MAX_SIM_EXP, simExp + 1);
          break;
        case '/':
          simExp = 0;
          paused = false;
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    { signal },
  );
  window.addEventListener(
    'keyup',
    (e) => {
      keys.delete(e.code);
    },
    { signal },
  );
  window.addEventListener(
    'blur',
    () => {
      keys.clear();
    },
    { signal },
  );

  // A hidden tab stops requestAnimationFrame; do not count the gap as a slow frame.
  document.addEventListener('visibilitychange', resetTiming, { signal });

  const frame = (now: number): void => {
    rafId = requestAnimationFrame(frame);
    if (lost) {
      prev = null;
      return;
    }
    const start = performance.now();
    const intervalMs = prev === null ? 0 : now - prev;
    prev = now;
    const dt = Math.min(intervalMs / 1000, MAX_DT_S);
    clock += dt;

    // Simulation time.
    const simSpeed = 10 ** simExp;
    const simDt = paused ? 0 : dt * simSpeed;
    simTime += simDt;

    // Camera.
    const basis = basisFor(yaw, pitch);
    const axisX = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    const axisZ = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    if (dt > 0 && (axisX !== 0 || axisZ !== 0)) {
      const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? SHIFT_BOOST : 1;
      const effective = speed * boost;
      const step = (effective * dt) / Math.hypot(axisX, axisZ);
      const target = tierForSpeed(effective);
      if (camera.tier !== target) camera = toTier(camera, target);
      camera = translate(camera, [
        (basis.forward[0] * axisZ + basis.right[0] * axisX) * step,
        (basis.forward[1] * axisZ + basis.right[1] * axisX) * step,
        (basis.forward[2] * axisZ + basis.right[2] * axisX) * step,
      ]);
    }

    // Gravity pulls the camera (and keeps the momentum it gave it) for the simulation time that passed.
    if (options.gravity !== undefined && simDt > 0) {
      fall.position = camera;
      options.gravity.step(fall, simDt);
      camera = fall.position;
    }

    // Drawing-buffer size.
    const dpr = window.devicePixelRatio || 1;
    const scale = 1 - level * RESOLUTION_STEP;
    const w = Math.min(maxW, Math.max(1, Math.round(cssW * dpr * scale)));
    const h = Math.min(maxH, Math.max(1, Math.round(cssH * dpr * scale)));
    const resized = needsResize || canvas.width !== w || canvas.height !== h;
    if (resized) {
      canvas.width = w;
      canvas.height = h;
      needsResize = false;
    }

    try {
      onFrame({
        gl,
        dt,
        simDt,
        simTime,
        simSpeed,
        paused,
        camera: {
          position: camera,
          yaw,
          pitch,
          forward: basis.forward,
          right: basis.right,
          up: basis.up,
          speed,
        },
        width: canvas.width,
        height: canvas.height,
        resized,
        resolutionScale: scale,
        workload,
      });
    } catch (error) {
      cancelAnimationFrame(rafId);
      throw error;
    }

    if (intervalMs > 0) {
      const cpuMs = performance.now() - start;

      fpsFrames += 1;
      fpsSeconds += intervalMs / 1000;
      if (fpsSeconds >= FPS_WINDOW_S) {
        hud.show(`FPS: ${Math.round(fpsFrames / fpsSeconds)}`);
        fpsFrames = 0;
        fpsSeconds = 0;
      }

      // Skip the first seconds: shader compiles and first uploads are not steady state.
      if (clock >= WARMUP_S) {
        frameRing[head] = intervalMs;
        cpuRing[head] = cpuMs;
        head = (head + 1) % HISTORY;
        count = Math.min(count + 1, HISTORY);
        sinceAdjust += dt;
        if (sinceAdjust >= ADJUST_S && count >= MIN_SAMPLES) {
          sinceAdjust = 0;
          adjustResolution();
        }
      }
    }
  };
  rafId = requestAnimationFrame(frame);

  return {
    gl,
    canvas,
    dispose(): void {
      cancelAnimationFrame(rafId);
      abort.abort();
      observer.disconnect();
      hud.dispose();
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    },
  };
}
