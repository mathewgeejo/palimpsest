import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';
import { GLSL_LIB, OnsetGate, PingPong, approach, fullscreen, mulberry, type Room } from './common';
import { postVert } from './shaders';

/**
 * SUMINAGASHI — floating-ink marbling, computed exactly.
 *
 * Every mark is an invertible map of the water surface (after Jaffer's
 * mathematical marbling): a drop of radius r at c pushes every point outward,
 * p -> c + (p - c) * sqrt(1 + r^2 / |p - c|^2); a tine stroke drags ink along a
 * line with falloff a*l/(d+l); a vortex rotates by an angle that decays with
 * distance; a wave comb shifts along a sinusoid. Each pixel walks the stack of
 * operations backwards to find which drop its ink came from, so rings stay
 * razor-sharp no matter how far they have been pushed. The oldest operations
 * are baked into a base texture in batches so the stack stays bounded.
 *
 * Ink and clear water fall in alternation at the brush; the loudness of each
 * moment sets the area of its drop, so the rings are a record of the dynamics.
 */

const MAX_OPS = 96;
const LIVE: Record<Quality, number> = { low: 40, medium: 72, high: 88 };
const SCALE: Record<Quality, number> = { low: 0.6, medium: 0.85, high: 1 };

const OP_DROP = 0, OP_TINE = 1, OP_VORTEX = 2, OP_WAVE = 3;

type RGB = [number, number, number];
const PAPER: RGB = [0.925, 0.9, 0.84];
const SUMI: RGB = [0.07, 0.07, 0.09];
const INDIGO: RGB = [0.09, 0.15, 0.32];
const ACCENTS: RGB[][] = [
  [[0.80, 0.22, 0.13], [0.80, 0.56, 0.18]],
  [[0.16, 0.42, 0.46], [0.75, 0.30, 0.35]],
  [[0.58, 0.20, 0.30], [0.30, 0.45, 0.30]],
  [[0.85, 0.45, 0.10], [0.15, 0.25, 0.55]],
];

const WALK = /* glsl */ `
uniform vec4 uOpA[${MAX_OPS}];
uniform vec4 uOpB[${MAX_OPS}];
uniform int uHi;
// Undo operations uHi-1 .. 0. Returns true if p lands inside a drop.
bool walk(inout vec2 p, out vec3 ink, out float edge, out float rim) {
  for (int i = uHi - 1; i >= 0; i--) {
    vec4 a = uOpA[i];
    vec4 b = uOpB[i];
    if (a.w < 0.5) {
      vec2 d = p - a.xy;
      float l2 = max(dot(d, d), 1e-9);
      float r2 = a.z * a.z;
      if (l2 < r2) {
        ink = b.rgb; edge = sqrt(l2 / r2); rim = b.w;
        p = d / a.z;
        return true;
      }
      p = a.xy + d * sqrt(1.0 - r2 / l2);
    } else if (a.w < 1.5) {
      vec2 M = vec2(cos(a.z), sin(a.z));
      vec2 N = vec2(-M.y, M.x);
      float dd = abs(dot(p - a.xy, N));
      p -= M * b.x * b.y / (dd + b.y);
    } else if (a.w < 2.5) {
      vec2 d = p - a.xy;
      float th = -b.x * exp(-dot(d, d) / (b.y * b.y));
      p = a.xy + rot(th) * d;
    } else {
      vec2 M = vec2(cos(a.z), sin(a.z));
      vec2 N = vec2(-M.y, M.x);
      p -= M * b.x * sin(b.y * dot(p, N) + b.z);
    }
  }
  return false;
}
// Pigment pools at the drying edge and granulates; the texture travels with the ink.
vec3 shade(vec3 ink, float edge, float rim, vec2 local) {
  float gran = noise(local * 38.0 + ink.rg * 50.0) * 0.6 + noise(local * 140.0) * 0.4;
  vec3 c = ink * (1.0 + 0.24 * (gran - 0.5) * rim);
  c *= 1.0 - rim * 0.45 * smoothstep(0.78, 1.0, edge);
  return c;
}
`;

const bakeFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uAspect;
uniform vec3 uPaper;
uniform float uFade;
out vec4 fragColor;
${GLSL_LIB}
${WALK}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 ink; float edge, rim;
  vec3 col;
  if (walk(p, ink, edge, rim)) {
    col = shade(ink, edge, rim, p);
  } else {
    vec2 uv = p / vec2(uAspect, 1.0) + 0.5;
    col = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? uPaper : texture(uPrev, uv).rgb;
  }
  fragColor = vec4(mix(col, uPaper, uFade), 1.0);
}
`;

const showFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uAspect, uTime, uRipple, uSeed, uGrain;
uniform vec3 uPaper;
out vec4 fragColor;
${GLSL_LIB}
${WALK}
void main() {
  vec2 p0 = (vUv - 0.5) * vec2(uAspect, 1.0);
  // The water is never still: a faint live ripple that is not recorded.
  vec2 p = p0 + uRipple * vec2(sin(p0.y * 21.0 + uTime * 1.9) + sin(p0.x * 7.0 - uTime * 0.7),
                               cos(p0.x * 17.0 - uTime * 1.6) + cos(p0.y * 9.0 + uTime * 0.8));
  vec3 ink; float edge, rim;
  vec3 col;
  if (walk(p, ink, edge, rim)) {
    col = shade(ink, edge, rim, p);
  } else {
    vec2 uv = p / vec2(uAspect, 1.0) + 0.5;
    col = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? uPaper : texture(uPrev, uv).rgb;
  }
  // Washi: long fibres and soft cloudy formation, fixed to the sheet.
  float fib = noise(vec2(p0.x * 9.0, p0.y * 90.0)) * noise(vec2(p0.x * 60.0 + 3.0, p0.y * 14.0));
  float cloud = fbm(p0 * 6.0);
  col *= 0.955 + 0.06 * cloud + 0.05 * fib;
  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.32 * dot(q, q);
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
  fragColor = vec4(col, 1.0);
}
`;

export class Suminagashi implements Room {
  private readonly base: PingPong;
  private readonly bake: p5.Shader;
  private readonly show: p5.Shader;
  private readonly opA = new Float32Array(MAX_OPS * 4);
  private readonly opB = new Float32Array(MAX_OPS * 4);
  private count = 0;
  private quality: Quality = 'medium';
  private rng = mulberry(1);
  private t = 0;
  private brush: [number, number] = [0, 0];
  private brushTarget: [number, number] = [0, 0];
  private dropAcc = 0;
  private inkTurn = true;
  private fleckAcc = 0;
  private tineAcc = 0;
  private sinceComb = 9;
  private sinceWave = 0;
  private sinceVortex = 0;
  private tineAngle = 0;
  private accents: RGB[] = ACCENTS[0]!;
  private ripple = 0;
  private readonly onset = new OnsetGate(0.55);

  constructor(private readonly p: p5) {
    this.base = new PingPong(p, SCALE);
    this.bake = p.createShader(postVert, bakeFrag);
    this.show = p.createShader(postVert, showFrag);
  }

  get bufferSize() { return this.base.size; }

  configure(quality: Quality, density: number) {
    this.quality = quality;
    this.base.configure(quality, density);
  }

  // The base is sampled by uv, so it survives a resize without being cleared.
  resize() {}

  reset(seed: number) {
    this.rng = mulberry(seed ^ 0x2545f491);
    this.count = 0;
    this.t = 0;
    this.accents = ACCENTS[seed % ACCENTS.length]!;
    this.brush = [(this.rng() - 0.5) * 0.5, (this.rng() - 0.5) * 0.3];
    this.brushTarget = [...this.brush];
    this.dropAcc = this.fleckAcc = this.tineAcc = 0;
    this.sinceComb = 9;
    this.sinceWave = this.sinceVortex = 0;
    this.tineAngle = this.rng() * Math.PI;
    this.inkTurn = true;
    this.onset.reset();
    this.base.fresh = true;
  }

  frame(f: AudioFeatures, dt: number, playing: boolean, s: VisualSettings) {
    const p = this.p;
    this.base.ensure();
    if (!this.base.read) return;
    const aspect = p.width / p.height;
    if (this.base.fresh) {
      this.base.pass(this.bake, (sh) => this.setOps(sh, 0, aspect, 1));
      this.base.fresh = false;
    }

    if (playing) this.listen(f, dt, s, aspect);
    this.ripple = approach(this.ripple, playing && !f.silent ? 0.0009 + 0.0035 * f.bass : 0, dt, 0.25);

    const live = LIVE[this.quality];
    if (this.count >= live) this.flatten(this.count - Math.floor(live / 2), s, aspect);

    p.clear();
    fullscreen(p, this.show, (sh) => {
      sh.setUniform('uPrev', this.base.read!);
      this.setOps(sh, this.count, aspect, 0);
      sh.setUniform('uTime', this.t);
      sh.setUniform('uRipple', s.reducedMotion ? this.ripple * 0.3 : this.ripple);
      sh.setUniform('uSeed', s.reducedMotion ? 0 : (p.frameCount % 61) * 7.31);
      sh.setUniform('uGrain', 0.022);
    });
  }

  destroy() { this.base.destroy(); }

  private listen(f: AudioFeatures, dt: number, s: VisualSettings, aspect: number) {
    const r = this.rng;
    this.t += dt;
    const calm = s.reducedMotion ? 0.5 : 1;

    // The brush drifts slowly; onsets sometimes lift it to a new place on the water.
    const hit = this.onset.step(f, dt, 0.22);
    if (hit && r() < 0.32) {
      this.brushTarget = [(r() - 0.5) * aspect * 0.75, (r() - 0.5) * 0.7];
    }
    this.brush[0] = approach(this.brush[0], this.brushTarget[0] + Math.sin(this.t * 0.13) * 0.04, dt, 0.6);
    this.brush[1] = approach(this.brush[1], this.brushTarget[1] + Math.cos(this.t * 0.11) * 0.04, dt, 0.6);
    const [bx, by] = this.brush;

    if (!f.silent) {
      // Alternate ink and water; louder moments fall faster and wider.
      this.dropAcc += dt;
      const interval = 0.1 + 0.26 * (1 - f.rms);
      if (this.dropAcc >= interval) {
        this.dropAcc = 0;
        const rad = 0.008 + 0.034 * f.rms + 0.01 * f.bass;
        if (this.inkTurn) {
          const accent = f.highMid > 0.55 && r() < 0.3;
          const ink = accent ? this.accents[r() < 0.5 ? 0 : 1]! : mix(SUMI, INDIGO, f.centroid);
          this.drop(bx, by, rad, ink, 1);
        } else {
          this.drop(bx, by, rad * 0.9, PAPER, 0);
        }
        this.inkTurn = !this.inkTurn;
      }

      if (hit) {
        // A large accent drop followed by water inside it: a bright ring.
        const R = 0.03 + 0.07 * hit * (0.6 + 0.6 * f.bass);
        this.drop(bx, by, R, this.accents[r() < 0.6 ? 0 : 1]!, 1);
        this.drop(bx, by, R * 0.72, PAPER, 0);
        this.inkTurn = true;
      }

      // Treble: tiny flecks spattered across the sheet.
      this.fleckAcc += dt * f.treble * (1.5 + 7 * s.detail);
      while (this.fleckAcc >= 1) {
        this.fleckAcc -= 1;
        const col = r() < 0.75 ? SUMI : this.accents[0]!;
        this.drop((r() - 0.5) * aspect * 0.95, (r() - 0.5) * 0.95, 0.0018 + 0.0045 * r(), col, 0.6);
      }

      // Bass drags a single tine through the ink; a very heavy bass combs it.
      this.tineAngle += dt * (0.05 + 0.4 * f.change);
      this.tineAcc += dt * f.bass * (0.5 + s.tension);
      if (this.tineAcc > 0.9) {
        this.tineAcc = 0;
        const a = this.tineAngle + (r() - 0.5) * 0.6;
        const px = bx + (r() - 0.5) * 0.4, py = by + (r() - 0.5) * 0.4;
        this.op(px, py, a, OP_TINE, (0.025 + 0.08 * f.bass * (0.4 + s.tension)) * calm, 0.015 + 0.035 * s.detail, 0, 0);
      }
      this.sinceComb += dt;
      if (f.bass > 0.8 && this.sinceComb > 4) {
        this.sinceComb = 0;
        const a = this.tineAngle + Math.PI / 2;
        const nx = -Math.sin(a), ny = Math.cos(a);
        const sign = r() < 0.5 ? -1 : 1;
        for (let k = -2; k <= 2; k++) {
          this.op(nx * k * 0.17, ny * k * 0.17, a, OP_TINE, sign * (0.03 + 0.05 * s.tension) * calm, 0.012, 0, 0);
        }
      }

      // Low mids: an occasional sinusoidal comb, the classic "nonpareil" wave.
      this.sinceWave += dt;
      if (f.lowMid > 0.5 && this.sinceWave > 7) {
        this.sinceWave = 0;
        this.op(0, 0, r() * Math.PI, OP_WAVE, (0.006 + 0.014 * f.lowMid) * (0.5 + s.tension) * calm, 8 + 14 * r(), r() * 6.28, 0);
      }
    }

    // Camera drift becomes a slow whirlpool through the middle of the sheet.
    this.sinceVortex += dt;
    if (s.camera === 'drift' && !s.reducedMotion && this.sinceVortex > 2.2 && !f.silent) {
      this.sinceVortex = 0;
      const sign = Math.sin(this.t * 0.03) >= 0 ? 1 : -1;
      this.op(Math.sin(this.t * 0.05) * 0.2, Math.cos(this.t * 0.04) * 0.12, 0, OP_VORTEX, sign * (0.06 + 0.25 * f.change), 0.35 + 0.15 * f.lowMid, 0, 0);
    }
  }

  private drop(x: number, y: number, r: number, col: RGB, rim: number) {
    this.op(x, y, r, OP_DROP, col[0], col[1], col[2], rim);
  }

  private op(a0: number, a1: number, a2: number, type: number, b0: number, b1: number, b2: number, b3: number) {
    if (this.count >= MAX_OPS) return;
    const o = this.count * 4;
    this.opA[o] = a0; this.opA[o + 1] = a1; this.opA[o + 2] = a2; this.opA[o + 3] = type;
    this.opB[o] = b0; this.opB[o + 1] = b1; this.opB[o + 2] = b2; this.opB[o + 3] = b3;
    this.count++;
  }

  /** Bake the oldest `k` operations into the base texture and drop them from the stack. */
  private flatten(k: number, s: VisualSettings, aspect: number) {
    if (k <= 0) return;
    this.base.pass(this.bake, (sh) => this.setOps(sh, k, aspect, (1 - s.memory) * 0.18));
    this.opA.copyWithin(0, k * 4);
    this.opB.copyWithin(0, k * 4);
    this.count -= k;
  }

  private setOps(sh: p5.Shader, hi: number, aspect: number, fade: number) {
    sh.setUniform('uOpA', this.opA);
    sh.setUniform('uOpB', this.opB);
    sh.setUniform('uHi', hi);
    sh.setUniform('uAspect', aspect);
    sh.setUniform('uPaper', PAPER);
    sh.setUniform('uFade', fade);
  }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
