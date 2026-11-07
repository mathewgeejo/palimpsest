import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';
import { GLSL_LIB, OnsetGate, PingPong, approach, fullscreen, type Room } from './common';
import { postVert } from './shaders';

/**
 * PHOSPHOR — the waveform plotted against its own past.
 *
 * Takens' delay embedding turns a single signal s(t) into a curve in space:
 * (s(t), s(t - tau), s(t - 2 tau)). A pure tone closes into an ellipse, a chord
 * winds a torus knot, noise blooms into a cloud. The curve is drawn as a
 * vector-scope beam: brightness is inversely proportional to beam speed (a
 * slow beam burns, a fast one is faint), and the screen is a two-phosphor
 * mix, so a blue-white flash fades through a long amber afterglow.
 *
 * tau follows the dominant period (from zero crossings) so the figure stays
 * open; onsets kick the rotation.
 */

const SAMPLES = 768; // 2048-sample window, stride 2
const SEGMENTS = 640;
const MAX_TAU = (SAMPLES - SEGMENTS - 2) / 2;
const SCALE: Record<Quality, number> = { low: 0.6, medium: 0.8, high: 1 };

const beamVert = /* glsl */ `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aCorner;
in float aSeg;
uniform vec4 uWave[${SAMPLES / 4}];
uniform float uTau, uScale, uWidth, uGain, uPersp;
uniform mat3 uRot;
uniform vec2 uRes;
out float vSide;
out float vI;
out float vDepth;
float S(float x) {
  x = clamp(x, 0.0, ${SAMPLES - 2}.0);
  int i = int(x);
  int j = i + 1;
  float a = uWave[i >> 2][i & 3];
  float b = uWave[j >> 2][j & 3];
  return mix(a, b, x - float(i));
}
vec3 P(float i) { return vec3(S(i), S(i + uTau), S(i + 2.0 * uTau)); }
vec3 proj(vec3 q) {
  q = uRot * (q * uScale);
  float w = 1.0 / (1.0 + q.z * uPersp);
  return vec3(q.xy * w * uRes.y * 0.5, q.z);
}
void main() {
  vec3 a = proj(P(aSeg));
  vec3 b = proj(P(aSeg + 1.0));
  vec2 d = b.xy - a.xy;
  float len = length(d);
  vec2 t = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  vec2 pos = mix(a.xy, b.xy, aCorner.x) + n * aCorner.y * uWidth + t * (aCorner.x * 2.0 - 1.0) * uWidth * 0.5;
  vSide = aCorner.y;
  // Dwell time: a slow beam deposits more light.
  vI = uGain / max(len, 0.7);
  vDepth = mix(a.z, b.z, aCorner.x);
  gl_Position = vec4(pos / (uRes * 0.5), 0.0, 1.0);
}
`;

const beamFrag = /* glsl */ `#version 300 es
precision highp float;
in float vSide;
in float vI;
in float vDepth;
uniform vec3 uBeam;
out vec4 fragColor;
void main() {
  float prof = exp(-vSide * vSide * 3.0);
  float depth = 0.55 + 0.45 * smoothstep(0.9, -0.9, vDepth);
  vec3 c = uBeam * vI * prof * depth;
  fragColor = vec4(c, 1.0);
}
`;

const decayFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec3 uDecay;
out vec4 fragColor;
void main() {
  fragColor = vec4(texture(uPrev, vUv).rgb * uDecay, 1.0);
}
`;

const showFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBuf;
uniform vec2 uRes;
uniform int uTaps;
uniform float uSeed, uGrain, uGrid;
out vec4 fragColor;
${GLSL_LIB}
float gridLine(float x, float w) {
  float fw = max(fwidth(x), 1e-5);
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + fw * 1.2, abs(fract(x + 0.5) - 0.5));
}
void main() {
  vec3 c = texture(uBuf, vUv).rgb;
  if (uTaps > 0) {
    vec3 b = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      if (i >= uTaps) break;
      float a = float(i) * 2.39996;
      float r = 0.003 + 0.0035 * float(i);
      b += texture(uBuf, vUv + vec2(cos(a), sin(a)) * r * vec2(uRes.y / uRes.x, 1.0)).rgb;
    }
    c += b / float(uTaps) * 0.7;
  }
  c = 1.0 - exp(-c * 1.1);

  // Graticule: a faint 10 x 8 grid with a ticked centre cross, behind the glass.
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  vec2 g = p * 8.0;
  float grid = max(gridLine(g.x, 0.02), gridLine(g.y, 0.02)) * step(abs(p.x), 0.625) * step(abs(p.y), 0.5);
  float ticks = (gridLine(g.x * 5.0, 0.06) * step(abs(p.y), 0.012) + gridLine(g.y * 5.0, 0.06) * step(abs(p.x), 0.012)) * step(abs(p.x), 0.625);
  vec3 glass = vec3(0.012, 0.016, 0.018) + vec3(0.06, 0.09, 0.085) * (grid * 0.5 + ticks * 0.7) * uGrid;
  vec2 q = vUv - 0.5;
  glass += vec3(0.02, 0.03, 0.035) * smoothstep(0.7, 0.0, length(q - vec2(-0.2, 0.25)));
  vec3 col = glass + c * (1.0 - glass);
  col *= 1.0 - 0.6 * dot(q, q);
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
  fragColor = vec4(col, 1.0);
}
`;

export class Phosphor implements Room {
  private readonly screen: PingPong;
  private readonly beam: p5.Shader;
  private readonly decay: p5.Shader;
  private readonly show: p5.Shader;
  private geom: p5.Geometry | null = null;
  private readonly buf = new Float32Array(SAMPLES);
  private gain = 0;
  private tau = 12;
  private yaw = 0;
  private pitch = 0;
  private spin = 0;
  private t = 0;
  private bass = 0;
  private treble = 0;
  private silentFor = 0;
  private density = 1;
  private readonly onset = new OnsetGate(0.5);

  constructor(private readonly p: p5) {
    this.screen = new PingPong(p, SCALE);
    this.beam = p.createShader(beamVert, beamFrag);
    this.decay = p.createShader(postVert, decayFrag);
    this.show = p.createShader(postVert, showFrag);
  }

  get bufferSize() { return this.screen.size; }

  configure(quality: Quality, density: number) {
    this.density = density * SCALE[quality];
    this.screen.configure(quality, density);
  }

  resize(w: number, h: number) { this.screen.resize(w, h); }

  reset(seed: number) {
    this.yaw = (seed % 628) / 100;
    this.pitch = 0;
    this.spin = 0;
    this.gain = 0;
    this.t = 0;
    this.onset.reset();
    this.screen.fresh = true;
  }

  frame(f: AudioFeatures, dt: number, playing: boolean, s: VisualSettings, glowTaps: number, wave: Float32Array) {
    const p = this.p;
    this.screen.ensure();
    if (!this.screen.read) return;
    if (!this.geom) this.geom = this.buildGeometry();
    if (this.screen.fresh) {
      this.screen.pass(this.decay, (sh) => sh.setUniform('uDecay', [0, 0, 0]));
      this.screen.fresh = false;
    }
    const size = this.screen.size;

    if (playing) {
      this.t += dt;
      // Downsample the window and measure it.
      let sq = 0, zc = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const v = wave[k * 2] ?? 0;
        this.buf[k] = v;
        sq += v * v;
        if (k > 0 && (v >= 0) !== (this.buf[k - 1]! >= 0)) zc++;
      }
      const rms = Math.sqrt(sq / SAMPLES);
      this.silentFor = f.silent ? this.silentFor + dt : 0;
      const target = this.silentFor > 0.25 ? 0 : 0.34 / Math.max(rms, 0.004);
      this.gain = approach(this.gain, Math.min(target, 40), dt, target < this.gain ? 0.25 : 0.12);
      const period = zc > 1 ? (2 * SAMPLES) / zc : 40;
      const tauTarget = Math.min(MAX_TAU, Math.max(2, (period / 4) * (0.6 + 0.8 * s.detail)));
      this.tau = approach(this.tau, tauTarget, dt, 0.35);

      this.bass = approach(this.bass, f.silent ? 0 : f.bass, dt, 0.08);
      this.treble = approach(this.treble, f.silent ? 0 : f.treble, dt, 0.1);
      const hit = this.onset.step(f, dt, 0.2);
      if (hit && !s.reducedMotion) this.spin += (0.8 + 1.6 * hit) * (Math.sin(this.t * 0.7) >= 0 ? 1 : -1);
      this.spin *= Math.exp(-dt * 1.5);
      const drift = s.camera === 'drift' && !s.reducedMotion ? 1 : 0.15;
      this.yaw += dt * ((0.12 + 0.5 * f.change) * drift + this.spin);
      this.pitch = 0.45 * Math.sin(this.t * 0.07 * drift) + 0.25;

      const mem = 0.25 + 0.75 * s.memory;
      const k = dt * 60;
      const decay: [number, number, number] = [
        Math.pow(0.9 + 0.075 * mem, k),
        Math.pow(0.86 + 0.1 * mem, k),
        Math.pow(0.7 + 0.15 * mem, k),
      ];
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      // Column-major Rx(pitch) * Ry(yaw).
      const rotm = [cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy];
      const scale = this.gain * (1 + 0.18 * this.bass * (0.5 + s.tension)) * 0.62;
      // When the figure collapses (fading to silence) every segment piles onto
      // one spot; dim with the figure's size so it rests as a faint dot.
      const size2 = Math.min(1, (this.gain * rms) / 0.34) ** 2;
      // Light deposited is proportional to the beam time each frame covers.
      const beamGain = 0.8 * this.density * Math.max(size2, 0.004) * Math.min(4, k);

      this.screen.pass(this.decay, (sh) => sh.setUniform('uDecay', decay), () => {
        p.push();
        p.noStroke();
        p.blendMode(p.ADD);
        p.shader(this.beam);
        this.beam.setUniform('uWave', this.buf);
        this.beam.setUniform('uTau', this.tau);
        this.beam.setUniform('uScale', scale);
        this.beam.setUniform('uWidth', (1.1 + 1.6 * this.treble) * this.density);
        this.beam.setUniform('uGain', beamGain);
        this.beam.setUniform('uPersp', 0.35);
        this.beam.setUniform('uRot', rotm);
        this.beam.setUniform('uRes', size);
        this.beam.setUniform('uBeam', [0.55 + 0.3 * f.centroid, 0.8, 1.0]);
        p.model(this.geom!);
        p.blendMode(p.BLEND);
        p.pop();
      });
    }

    p.clear();
    fullscreen(p, this.show, (sh) => {
      sh.setUniform('uBuf', this.screen.read!);
      sh.setUniform('uRes', [p.width, p.height]);
      sh.setUniform('uTaps', glowTaps);
      sh.setUniform('uSeed', s.reducedMotion ? 0 : (p.frameCount % 61) * 7.31);
      sh.setUniform('uGrain', 0.02);
      sh.setUniform('uGrid', 0.35 + 0.65 * s.detail);
    });
  }

  destroy() {
    if (this.geom) this.p.freeGeometry(this.geom);
    this.geom = null;
    this.screen.destroy();
  }

  private buildGeometry() {
    const p = this.p;
    const nv = SEGMENTS * 4;
    const geom = new p5.Geometry(1, 1);
    const zero = p.createVector(0, 0, 0);
    const zn = p.createVector(0, 0, 1);
    const verts: p5.Vector[] = new Array(nv).fill(zero);
    const norms: p5.Vector[] = new Array(nv).fill(zn);
    const corner: number[] = new Array(nv * 2);
    const seg: number[] = new Array(nv);
    const faces: [number, number, number][] = new Array(SEGMENTS * 2);
    const C = [0, -1, 1, -1, 1, 1, 0, 1];
    for (let i = 0; i < SEGMENTS; i++) {
      for (let k = 0; k < 4; k++) {
        const vi = i * 4 + k;
        corner[vi * 2] = C[k * 2]!;
        corner[vi * 2 + 1] = C[k * 2 + 1]!;
        seg[vi] = i;
      }
      faces[i * 2] = [i * 4, i * 4 + 1, i * 4 + 2];
      faces[i * 2 + 1] = [i * 4, i * 4 + 2, i * 4 + 3];
    }
    geom.vertices = verts;
    geom.vertexNormals = norms;
    geom.faces = faces;
    geom.vertexProperty('aCorner', corner, 2);
    geom.vertexProperty('aSeg', seg, 1);
    return geom;
  }
}
