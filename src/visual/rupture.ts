import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';
import { postVert } from './shaders';

/**
 * RUPTURE — the loud mode. A feedback painting: every frame is warped, torn and
 * colour-split into the next, while the current sound paints hot ribbons into a
 * kaleidoscope whose symmetry snaps to a new fold on each onset.
 */

type RGB = [number, number, number];
const PALETTES: RGB[][] = [
  [[1.0, 0.16, 0.05], [1.0, 0.86, 0.1], [0.08, 0.2, 1.0]],
  [[0.95, 0.05, 0.45], [0.1, 1.0, 0.75], [1.0, 0.55, 0.0]],
  [[0.55, 0.1, 1.0], [1.0, 0.3, 0.1], [0.85, 1.0, 0.2]],
  [[0.0, 0.75, 1.0], [1.0, 0.1, 0.2], [1.0, 0.95, 0.85]],
];
const FOLDS = [1, 2, 3, 4, 5, 6, 8];
const SCALE: Record<Quality, number> = { low: 0.5, medium: 0.75, high: 1 };

const feedFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform float uTime;
uniform float uBass, uLowMid, uHighMid, uTreble, uRms, uChange;
uniform vec4 uShock;      // centre xy (aspect space), age s, strength
uniform float uFold, uFoldRot;
uniform vec3 uC0, uC1, uC2;
uniform float uDecay, uWarp, uDetail, uSpin, uGlitch, uSparks;
out vec4 fragColor;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
vec2 curl(vec2 p) {
  const float e = 0.06;
  float a = noise(p + vec2(0, e)), b = noise(p - vec2(0, e));
  float c = noise(p + vec2(e, 0)), d = noise(p - vec2(e, 0));
  return vec2(a - b, d - c) / (2.0 * e);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec2 kale(vec2 p, float n, float r) {
  p = rot(r) * p;
  if (n < 1.5) return vec2(p.x, abs(p.y));
  float seg = 6.2831853 / n;
  float a = mod(atan(p.y, p.x), seg);
  a = abs(a - seg * 0.5);
  return vec2(cos(a), sin(a)) * length(p);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0);

  // Glitch: treble shoves horizontal slices sideways.
  float bands = mix(14.0, 70.0, uDetail);
  float band = floor(vUv.y * bands);
  float tick = floor(uTime * 9.0);
  float g = step(hash(vec2(band, tick)), uTreble * uTreble * 0.45 * uGlitch);
  vec2 q = p;
  q.x += g * (hash(vec2(band + 3.1, tick)) - 0.5) * 0.12;

  // Flow: bass drives a curl-noise smear of everything already painted.
  vec2 fl = curl(q * mix(1.6, 3.2, uDetail) + vec2(uTime * 0.11, -uTime * 0.07));
  q -= fl * uWarp * (0.0015 + 0.011 * uBass) * (1.0 + uLowMid);
  q = rot(uSpin) * q;
  q *= 1.0 - (0.002 + 0.006 * uLowMid) * uWarp;

  // Onset shockwave: an expanding ring that tears the image outward.
  vec2 sd = q - uShock.xy;
  float dist = length(sd);
  float ring = exp(-pow((dist - uShock.z * 1.4) * 30.0, 2.0)) * uShock.w * exp(-uShock.z * 2.5);
  q -= sd / max(dist, 1e-4) * ring * 0.05;

  vec2 suv = q / vec2(aspect, 1.0) + 0.5;
  vec2 ca = normalize(fl + 1e-4) * (0.001 + 0.006 * uTreble) / vec2(aspect, 1.0);
  vec3 prev = vec3(texture(uPrev, suv + ca).r, texture(uPrev, suv).g, texture(uPrev, suv - ca).b);
  // Trails age by hue-rotating (saturation preserved), staying vivid, and
  // a small subtractive floor clears haze so the field never greys out.
  prev = hueRotate(prev, 0.012 + 0.05 * uChange);
  float pl = dot(prev, vec3(0.299, 0.587, 0.114));
  prev = max(mix(vec3(pl), prev, 1.02) * uDecay - 0.004, 0.0);

  // Ink: three ribbons in kaleidoscope space, one per band.
  vec2 k = kale(p, uFold, uFoldRot);
  float energy = 0.2 + 1.3 * uRms;
  vec3 ink = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float drive = i == 0 ? uBass : (i == 1 ? uLowMid : uHighMid);
    float freq = 2.0 + fi * 1.7 + uHighMid * 3.0;
    float amp = (0.05 + 0.35 * uBass) * (1.0 - fi * 0.22);
    float y = sin(k.x * freq + uTime * (0.7 + fi * 0.45) + fi * 2.1) * amp
            + (noise(vec2(k.x * 4.0 + fi * 7.0, uTime * 1.3)) - 0.5) * 0.25 * uLowMid
            + (fi - 1.0) * 0.12;
    float w = 0.003 + 0.022 * drive;
    float d = abs(k.y - y);
    float line = smoothstep(w, 0.0, d) + 0.3 * exp(-d * 40.0);
    vec3 c = i == 0 ? uC0 : (i == 1 ? uC1 : uC2);
    ink += c * line * energy * (0.4 + 1.2 * drive);
  }
  vec3 col = prev + ink * (1.0 - uDecay) * 5.5;

  // One-shot marks: treble sparks, the onset tear and the shock ring itself.
  vec2 ks = k * mix(28.0, 70.0, uDetail);
  vec2 fc = fract(ks) - 0.5;
  float h = hash(floor(ks) + floor(uTime * 24.0));
  float star = smoothstep(0.07, 0.0, min(abs(fc.x), abs(fc.y))) * smoothstep(0.5, 0.05, length(fc));
  col += mix(uC1, vec3(1.0), 0.6) * star * step(1.0 - uTreble * 0.014 * uSparks, h) * 2.2;
  vec2 tp = rot(uFoldRot) * (p - uShock.xy);
  float jag = (noise(vec2(tp.x * 30.0, uShock.x * 10.0)) - 0.5) * 0.05;
  float tear = smoothstep(0.007, 0.0, abs(tp.y + jag)) * exp(-uShock.z * 7.0) * uShock.w
             * step(abs(tp.x), 0.2 + uShock.z * 3.0);
  col += vec3(1.0, 0.95, 0.9) * tear * 1.6 + uC0 * ring * 1.4;

  fragColor = vec4(min(col, vec3(4.0)), 1.0);
}
`;

const showFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBuf;
uniform vec2 uRes;
uniform float uFlash, uSeed, uGrain;
uniform int uTaps;
out vec4 fragColor;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main() {
  vec3 c = texture(uBuf, vUv).rgb;
  if (uTaps > 0) {
    vec3 b = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      if (i >= uTaps) break;
      float a = float(i) * 2.39996;
      float r = 0.004 + 0.003 * float(i);
      b += texture(uBuf, vUv + vec2(cos(a), sin(a)) * r * vec2(uRes.y / uRes.x, 1.0)).rgb;
    }
    c += b / float(uTaps) * 0.5;
  }
  c = c / (1.0 + c * 0.35);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, 1.3);
  c = clamp(c, 0.0, 1.0);
  c = mix(c, vec3(1.0) - c, uFlash);
  vec2 q = vUv - 0.5;
  c *= 1.0 - 0.7 * dot(q, q);
  c += vec3(0.03, 0.026, 0.034) * (1.0 - l);
  c += (hash(vUv * uRes + uSeed) - 0.5) * uGrain;
  fragColor = vec4(c, 1.0);
}
`;

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const approach = (cur: number, target: number, dt: number, tau: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));

export class Rupture {
  private a: p5.Framebuffer | null = null;
  private b: p5.Framebuffer | null = null;
  private readonly feed: p5.Shader;
  private readonly show: p5.Shader;
  private rng = mulberry(1);
  private t = 0;
  private bass = 0; private lowMid = 0; private highMid = 0; private treble = 0; private rms = 0;
  private fold = 3;
  private foldRot = 0;
  private palette = 0;
  private readonly colors: RGB[] = PALETTES[0].map((c) => [...c] as RGB);
  private readonly shock = [0, 0, 9, 0];
  private flash = 0;
  private sinceOnset = 9;
  private sinceFlash = 9;
  private prevOnset = 0;
  private spinSign = 1;
  private needsClear = true;

  constructor(private readonly p: p5) {
    this.feed = p.createShader(postVert, feedFrag);
    this.show = p.createShader(postVert, showFrag);
  }

  configure(quality: Quality, density: number) {
    const previous = this.b;
    this.a?.remove();
    const make = () => {
      const opts = { depth: false, antialias: false, density: density * SCALE[quality], textureFiltering: this.p.LINEAR };
      try {
        return this.p.createFramebuffer({ ...opts, format: this.p.HALF_FLOAT });
      } catch {
        return this.p.createFramebuffer(opts);
      }
    };
    this.a = make();
    this.b = make();
    this.a.pixelDensity(density * SCALE[quality]);
    this.b.pixelDensity(density * SCALE[quality]);
    if (!previous) {
      this.needsClear = true;
      return;
    }
    // Carry the painting across a quality change so a paused frame is not lost.
    const p = this.p;
    for (const fb of [this.a, this.b]) {
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
  }

  resize(w: number, h: number) {
    this.a?.resize(w, h);
    this.b?.resize(w, h);
    this.needsClear = true;
  }

  clear() { this.needsClear = true; }

  reset(seed: number) {
    this.rng = mulberry(seed ^ 0x9e3779b9);
    this.t = 0;
    this.palette = seed % PALETTES.length;
    PALETTES[this.palette].forEach((c, i) => { this.colors[i] = [...c] as RGB; });
    this.fold = 3;
    this.foldRot = this.rng() * Math.PI * 2;
    this.spinSign = this.rng() < 0.5 ? -1 : 1;
    this.shock[2] = 9; this.shock[3] = 0;
    this.flash = 0;
    this.bass = this.lowMid = this.highMid = this.treble = this.rms = 0;
    this.needsClear = true;
  }

  get bufferSize(): [number, number] {
    if (!this.a) return [0, 0];
    const d = (this.a as unknown as { pixelDensity(): number }).pixelDensity();
    return [Math.round(this.a.width * d), Math.round(this.a.height * d)];
  }

  frame(f: AudioFeatures, dt: number, playing: boolean, s: VisualSettings, glowTaps: number) {
    const p = this.p;
    if (!this.a || !this.b) return;
    const w = p.width, h = p.height;
    if (this.needsClear) {
      for (const fb of [this.a, this.b]) { fb.begin(); p.background(0); fb.end(); }
      this.needsClear = false;
    }

    if (playing) {
      this.t += dt;
      const silent = f.silent;
      this.bass = approach(this.bass, silent ? 0 : f.bass, dt, 0.05);
      this.lowMid = approach(this.lowMid, silent ? 0 : f.lowMid, dt, 0.07);
      this.highMid = approach(this.highMid, silent ? 0 : f.highMid, dt, 0.06);
      this.treble = approach(this.treble, silent ? 0 : f.treble, dt, 0.04);
      this.rms = approach(this.rms, silent ? 0 : f.rms, dt, 0.08);
      this.sinceOnset += dt;
      this.sinceFlash += dt;
      const cooldown = s.reducedMotion ? 0.8 : 0.16;
      if (f.onset > 0.5 && this.prevOnset <= 0.5 && this.sinceOnset > cooldown && !silent) {
        this.sinceOnset = 0;
        const r = this.rng;
        this.fold = FOLDS[Math.floor(r() * FOLDS.length)];
        this.foldRot = r() * Math.PI * 2;
        this.shock[0] = (r() - 0.5) * 0.8 * (w / h);
        this.shock[1] = (r() - 0.5) * 0.8;
        this.shock[2] = 0;
        this.shock[3] = (0.5 + 0.5 * f.onset) * (s.reducedMotion ? 0.35 : 1);
        if (r() < 0.3) this.palette = (this.palette + 1 + Math.floor(r() * (PALETTES.length - 1))) % PALETTES.length;
        // Flashes are capped well below 3 per second and disabled for reduced motion.
        if (!s.reducedMotion && this.sinceFlash > 0.45 && f.onset > 0.85) {
          this.flash = 1;
          this.sinceFlash = 0;
        }
      }
      this.prevOnset = f.onset;
      this.shock[2] += dt;
      const target = PALETTES[this.palette];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        this.colors[i][j] = approach(this.colors[i][j], target[i][j], dt, 0.25);
      }
    }
    this.flash = Math.max(0, this.flash - dt * 7);

    if (playing) {
      const [src, dst] = [this.b, this.a];
      dst.begin();
      p.clear();
      p.push();
      p.noStroke();
      p.shader(this.feed);
      const sh = this.feed;
      const calm = s.reducedMotion ? 0.4 : 1;
      sh.setUniform('uPrev', src);
      sh.setUniform('uRes', [w, h]);
      sh.setUniform('uTime', this.t);
      sh.setUniform('uBass', this.bass);
      sh.setUniform('uLowMid', this.lowMid);
      sh.setUniform('uHighMid', this.highMid);
      sh.setUniform('uTreble', this.treble);
      sh.setUniform('uRms', this.rms);
      sh.setUniform('uChange', f.change);
      sh.setUniform('uShock', this.shock);
      sh.setUniform('uFold', this.fold);
      sh.setUniform('uFoldRot', this.foldRot + (s.reducedMotion ? 0 : this.t * 0.05 * this.spinSign));
      sh.setUniform('uC0', this.colors[0]);
      sh.setUniform('uC1', this.colors[1]);
      sh.setUniform('uC2', this.colors[2]);
      sh.setUniform('uDecay', Math.pow(0.86 + 0.125 * s.memory, dt * 60));
      sh.setUniform('uWarp', (0.4 + 1.6 * s.tension) * calm);
      sh.setUniform('uDetail', s.detail);
      const spin = s.camera === 'drift' && !s.reducedMotion ? (0.0015 + 0.006 * f.change) * dt * 60 * this.spinSign : 0;
      sh.setUniform('uSpin', spin);
      sh.setUniform('uGlitch', s.reducedMotion ? 0 : 1);
      sh.setUniform('uSparks', s.reducedMotion ? 0.3 : 1);
      p.plane(1, 1);
      p.pop();
      dst.end();
      this.a = src;
      this.b = dst;
    }

    p.clear();
    p.push();
    p.noStroke();
    p.shader(this.show);
    this.show.setUniform('uBuf', this.b);
    this.show.setUniform('uRes', [w, h]);
    this.show.setUniform('uFlash', this.flash * 0.9);
    this.show.setUniform('uSeed', s.reducedMotion ? 0 : (p.frameCount % 61) * 7.31);
    this.show.setUniform('uGrain', 0.03);
    this.show.setUniform('uTaps', glowTaps);
    p.plane(1, 1);
    p.pop();
  }

  destroy() {
    this.a?.remove();
    this.b?.remove();
    this.a = this.b = null;
  }
}
