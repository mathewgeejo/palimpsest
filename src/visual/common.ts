import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';

/**
 * A full-screen "room": owns its own buffers and draws straight to the canvas.
 * Rupture, Suminagashi, Morphogen, Phosphor and Chladni all implement this.
 */
export interface Room {
  configure(quality: Quality, density: number): void;
  resize(w: number, h: number): void;
  reset(seed: number): void;
  frame(f: AudioFeatures, dt: number, playing: boolean, s: VisualSettings, glowTaps: number, wave: Float32Array): void;
  readonly bufferSize: [number, number];
  destroy(): void;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const approach = (cur: number, target: number, dt: number, tau: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Draw a full-screen quad (expects a vertex shader like `postVert`). */
export function fullscreen(p: p5, shader: p5.Shader, set: (sh: p5.Shader) => void) {
  p.push();
  p.noStroke();
  p.shader(shader);
  set(shader);
  p.plane(1, 1);
  p.pop();
}

/**
 * Two framebuffers for feedback simulations. Allocated lazily (a room that is
 * never visited costs no GPU memory) and carried across quality changes.
 */
export class PingPong {
  read: p5.Framebuffer | null = null;
  private write: p5.Framebuffer | null = null;
  /** True when the contents are undefined and the owner must initialise them. */
  fresh = true;
  private quality: Quality = 'medium';
  private density = 1;

  constructor(private readonly p: p5, private readonly scale: Record<Quality, number>) {}

  configure(quality: Quality, density: number) {
    this.quality = quality;
    this.density = density;
    if (this.read) this.allocate(true);
  }

  ensure() {
    if (!this.read) this.allocate(false);
  }

  resize(w: number, h: number) {
    this.read?.resize(w, h);
    this.write?.resize(w, h);
    this.fresh = true;
  }

  get size(): [number, number] {
    if (!this.read) return [0, 0];
    const d = (this.read as unknown as { pixelDensity(): number }).pixelDensity();
    return [Math.max(1, Math.round(this.read.width * d)), Math.max(1, Math.round(this.read.height * d))];
  }

  /** Render `shader` into the back buffer reading the front one (`uPrev`), then swap. */
  pass(shader: p5.Shader, set: (sh: p5.Shader) => void, after?: () => void) {
    const p = this.p;
    const src = this.read!, dst = this.write!;
    dst.begin();
    p.clear();
    fullscreen(p, shader, (sh) => {
      sh.setUniform('uPrev', src);
      set(sh);
    });
    after?.();
    dst.end();
    this.read = dst;
    this.write = src;
  }

  destroy() {
    this.read?.remove();
    this.write?.remove();
    this.read = this.write = null;
    this.fresh = true;
  }

  private make() {
    const opts = { depth: false, antialias: false, density: this.density * this.scale[this.quality], textureFiltering: this.p.LINEAR };
    let fb: p5.Framebuffer;
    try {
      fb = this.p.createFramebuffer({ ...opts, format: this.p.HALF_FLOAT });
    } catch {
      fb = this.p.createFramebuffer(opts);
    }
    fb.pixelDensity(this.density * this.scale[this.quality]);
    return fb;
  }

  private allocate(carry: boolean) {
    const p = this.p;
    const previous = this.read;
    this.write?.remove();
    this.read = this.make();
    this.write = this.make();
    if (!carry || !previous) {
      previous?.remove();
      this.fresh = true;
      return;
    }
    for (const fb of [this.read, this.write]) {
      fb.begin();
      p.background(0);
      p.push();
      p.resetShader();
      p.noStroke();
      p.image(previous, -p.width / 2, -p.height / 2, p.width, p.height);
      p.pop();
      fb.end();
    }
    previous.remove();
    this.fresh = false;
  }
}

/** Shared GLSL: hash, value noise, rotation. */
export const GLSL_LIB = /* glsl */ `
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
`;

/** Detects rising edges of the onset feature with a cooldown. */
export class OnsetGate {
  private prev = 0;
  private since = 9;
  constructor(private readonly threshold = 0.5) {}
  reset() { this.prev = 0; this.since = 9; }
  /** Returns the onset strength on a rising edge, otherwise 0. */
  step(f: AudioFeatures, dt: number, cooldown: number): number {
    this.since += dt;
    const hit = !f.silent && f.onset > this.threshold && this.prev <= this.threshold && this.since > cooldown;
    this.prev = f.onset;
    if (!hit) return 0;
    this.since = 0;
    return f.onset;
  }
}
