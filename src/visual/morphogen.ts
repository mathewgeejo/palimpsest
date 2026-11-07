import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';
import { GLSL_LIB, OnsetGate, PingPong, approach, fullscreen, mulberry, type Room } from './common';
import { postVert } from './shaders';

/**
 * MORPHOGEN — Gray–Scott reaction–diffusion, the chemistry Turing proposed for
 * leopard spots and coral. Two chemicals U and V diffuse at different rates;
 * V feeds on U (U + 2V -> 3V), U is replenished at feed rate F, V is removed at
 * kill rate k. Different (F, k) give different "species" of pattern.
 *
 * Here the spectral centroid walks (F, k) between coral, maze, holes and
 * mitosis; bass feeds the reaction; each onset wounds the tissue and seeds a
 * ring of new growth at the wound's edge; treble nucleates spores. The relief
 * is lit as wet enamel, and the growing front glows with the timbre's colour.
 */

const SCALE: Record<Quality, number> = { low: 0.35, medium: 0.5, high: 0.6 };
const ITER: Record<Quality, number> = { low: 6, medium: 10, high: 14 };

/** (F, k) species along the centroid axis — values for Du = 1, Dv = 0.5, dt = 1. */
const SPECIES: [number, number][] = [
  [0.0545, 0.062], // coral
  [0.029, 0.057], // maze
  [0.039, 0.058], // holes
  [0.0367, 0.0649], // mitosis
];

type RGB = [number, number, number];
const FRONT: RGB[] = [[0.1, 0.75, 0.95], [0.95, 0.3, 0.62], [1.0, 0.68, 0.2]];

const stepFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uAspect, uTime, uF, uK, uFlow, uVary, uNucleate, uInit, uGlowDecay, uSeedRand;
uniform vec4 uWound; // x, y, radius, active
out vec4 fragColor;
${GLSL_LIB}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  if (uInit > 0.5) {
    float v = step(0.8, noise(p * 6.0 + uSeedRand * 31.0)) * step(0.5, noise(p * 23.0 - uSeedRand * 7.0));
    fragColor = vec4(1.0 - 0.5 * v, 0.25 * v, 0.0, 1.0);
    return;
  }
  // A slow current carries the tissue, so even a settled pattern drifts and shears.
  vec2 fl = vec2(sin(p.y * 4.0 + uTime * 0.23) + 0.5 * sin(p.x * 7.0 - uTime * 0.31),
                 cos(p.x * 3.5 - uTime * 0.19) + 0.5 * cos(p.y * 6.0 + uTime * 0.27)) * uFlow;
  vec2 uv = vUv - fl * uTexel;
  vec3 c = texture(uPrev, uv).rgb;
  vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);
  vec2 lap = -c.rg
    + 0.2 * (texture(uPrev, uv + dx).rg + texture(uPrev, uv - dx).rg + texture(uPrev, uv + dy).rg + texture(uPrev, uv - dy).rg)
    + 0.05 * (texture(uPrev, uv + dx + dy).rg + texture(uPrev, uv - dx + dy).rg + texture(uPrev, uv + dx - dy).rg + texture(uPrev, uv - dx - dy).rg);
  float u = c.r, v = c.g;
  // Neighbouring regions differ slightly in chemistry, so several species coexist.
  float F = uF + uVary * (noise(p * 2.2 + 3.1) - 0.5) * 0.012;
  float k = uK + uVary * (noise(p * 1.7 - 5.0) - 0.5) * 0.004;
  float uvv = u * v * v;
  float du = lap.x - uvv + F * (1.0 - u);
  float dv = 0.5 * lap.y + uvv - (F + k) * v;
  u += du;
  v += dv;

  if (uWound.w > 0.0) {
    float d = length(p - uWound.xy);
    float inside = smoothstep(uWound.z, uWound.z - 0.006, d);
    u = mix(u, 1.0, inside);
    v = mix(v, 0.0, inside);
    float rim = smoothstep(0.006, 0.0, abs(d - uWound.z)) + smoothstep(0.012, 0.0, d);
    v = max(v, 0.5 * rim);
    u = min(u, 1.0 - 0.5 * rim);
  }
  // Treble: spores nucleate in 3x3 texel blocks.
  float h = hash(floor(vUv / uTexel / 3.0) + fract(uTime * 13.17) * 91.0);
  if (h > 1.0 - uNucleate) { v = max(v, 0.5); u = min(u, 0.5); }

  float glow = max(c.b * uGlowDecay, clamp(abs(dv) * 70.0, 0.0, 1.0));
  fragColor = vec4(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0), glow, 1.0);
}
`;

const showFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform vec3 uHue;
uniform float uAspect, uSeed, uGrain, uLight;
out vec4 fragColor;
${GLSL_LIB}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec3 c = texture(uState, vUv).rgb;
  float v = c.g;
  float vx = texture(uState, vUv + vec2(uTexel.x, 0.0)).g - texture(uState, vUv - vec2(uTexel.x, 0.0)).g;
  float vy = texture(uState, vUv + vec2(0.0, uTexel.y)).g - texture(uState, vUv - vec2(0.0, uTexel.y)).g;
  vec3 N = normalize(vec3(-vx * 7.0, -vy * 7.0, 1.0));
  vec3 L = normalize(vec3(cos(uLight) * 0.6, sin(uLight) * 0.6, 0.7));
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);

  float tissue = smoothstep(0.07, 0.3, v);
  vec3 ground = vec3(0.022, 0.025, 0.032) * (0.8 + 0.4 * fbm(p * 3.0));
  vec3 bone = mix(vec3(0.40, 0.33, 0.30), vec3(0.94, 0.89, 0.80), smoothstep(0.22, 0.42, v));
  vec3 col = mix(ground, bone * (0.28 + 0.8 * diff), tissue) + spec * tissue * 0.4;
  // Thin tissue at the margins transmits warm light, like a backlit leaf.
  col += vec3(0.85, 0.38, 0.22) * tissue * (1.0 - smoothstep(0.18, 0.36, v)) * 0.18;
  // The living front glows in the colour of the timbre.
  float g = c.b;
  col += uHue * g * 0.55 + mix(uHue, vec3(1.0), 0.5) * g * g * 0.35;

  vec2 q = vUv - 0.5;
  col *= 1.0 - 0.55 * dot(q, q);
  col = col / (1.0 + col * 0.25);
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
  fragColor = vec4(col, 1.0);
}
`;

export class Morphogen implements Room {
  private readonly state: PingPong;
  private readonly step: p5.Shader;
  private readonly show: p5.Shader;
  private quality: Quality = 'medium';
  private rng = mulberry(1);
  private seedRand = 0;
  private t = 0;
  private centroid = 0.4;
  private bass = 0;
  private lowMid = 0;
  private treble = 0;
  private light = 2.3;
  private readonly hue: RGB = [...FRONT[0]!];
  private readonly onset = new OnsetGate(0.5);
  private wound: [number, number, number, number] = [0, 0, 0, 0];

  constructor(private readonly p: p5) {
    this.state = new PingPong(p, SCALE);
    this.step = p.createShader(postVert, stepFrag);
    this.show = p.createShader(postVert, showFrag);
  }

  get bufferSize() { return this.state.size; }

  configure(quality: Quality, density: number) {
    this.quality = quality;
    this.state.configure(quality, density);
  }

  resize(w: number, h: number) { this.state.resize(w, h); }

  reset(seed: number) {
    this.rng = mulberry(seed ^ 0x68e31da4);
    this.seedRand = this.rng();
    this.t = 0;
    this.centroid = 0.3 + 0.4 * this.rng();
    this.bass = this.lowMid = this.treble = 0;
    this.onset.reset();
    this.state.fresh = true;
  }

  frame(f: AudioFeatures, dt: number, playing: boolean, s: VisualSettings) {
    const p = this.p;
    this.state.ensure();
    if (!this.state.read) return;
    const aspect = p.width / p.height;
    const [bw, bh] = this.state.size;
    const texel = [1 / bw, 1 / bh];

    if (this.state.fresh) {
      this.state.pass(this.step, (sh) => {
        sh.setUniform('uInit', 1);
        sh.setUniform('uAspect', aspect);
        sh.setUniform('uSeedRand', this.seedRand);
      });
      this.state.fresh = false;
    }

    if (playing) {
      this.t += dt;
      const silent = f.silent;
      this.centroid = approach(this.centroid, silent ? this.centroid : f.centroid, dt, 3);
      this.bass = approach(this.bass, silent ? 0 : f.bass, dt, 0.15);
      this.lowMid = approach(this.lowMid, silent ? 0 : f.lowMid, dt, 0.4);
      this.treble = approach(this.treble, silent ? 0 : f.treble, dt, 0.2);
      if (s.camera === 'drift' && !s.reducedMotion) this.light += dt * 0.05;

      // Walk the species path with the centroid.
      const x = Math.min(0.999, Math.max(0, (this.centroid - 0.15) / 0.7)) * (SPECIES.length - 1);
      const i = Math.floor(x), fr = x - i;
      const e = fr * fr * (3 - 2 * fr);
      const a = SPECIES[i]!, b = SPECIES[Math.min(SPECIES.length - 1, i + 1)]!;
      const F = a[0] + (b[0] - a[0]) * e + this.bass * 0.006 * (0.3 + s.tension);
      const K = a[1] + (b[1] - a[1]) * e;

      const hx = Math.min(0.999, this.centroid) * (FRONT.length - 1);
      const hi = Math.floor(hx), hf = hx - hi;
      for (let j = 0; j < 3; j++) {
        const target = FRONT[hi]![j]! + (FRONT[Math.min(FRONT.length - 1, hi + 1)]![j]! - FRONT[hi]![j]!) * hf;
        this.hue[j] = approach(this.hue[j]!, target, dt, 0.8);
      }

      const hit = this.onset.step(f, dt, s.reducedMotion ? 2 : 0.9);
      if (hit) {
        const r = this.rng;
        this.wound = [(r() - 0.5) * aspect * 0.85, (r() - 0.5) * 0.85, (0.03 + 0.1 * hit) * (s.reducedMotion ? 0.6 : 1), 1];
      }

      const iterations = ITER[this.quality];
      const flow = (0.02 + 0.1 * this.lowMid) * (0.4 + s.tension) * (s.camera === 'drift' ? 1 : 0.4);
      const nucleate = 3e-6 * this.treble * this.treble * (0.3 + s.detail);
      for (let it = 0; it < iterations; it++) {
        this.state.pass(this.step, (sh) => {
          sh.setUniform('uInit', 0);
          sh.setUniform('uTexel', texel);
          sh.setUniform('uAspect', aspect);
          sh.setUniform('uTime', this.t + it * 0.001);
          sh.setUniform('uF', F);
          sh.setUniform('uK', K);
          sh.setUniform('uFlow', flow);
          sh.setUniform('uVary', 0.4 + 0.6 * s.detail);
          sh.setUniform('uNucleate', nucleate);
          sh.setUniform('uGlowDecay', 0.99 + 0.0085 * s.memory);
          sh.setUniform('uWound', it === 0 ? this.wound : [0, 0, 0, 0]);
        });
      }
      this.wound[3] = 0;
    }

    p.clear();
    fullscreen(p, this.show, (sh) => {
      sh.setUniform('uState', this.state.read!);
      sh.setUniform('uTexel', texel);
      sh.setUniform('uHue', this.hue);
      sh.setUniform('uAspect', aspect);
      sh.setUniform('uLight', this.light);
      sh.setUniform('uSeed', s.reducedMotion ? 0 : (p.frameCount % 61) * 7.31);
      sh.setUniform('uGrain', 0.02);
    });
  }

  destroy() { this.state.destroy(); }
}
