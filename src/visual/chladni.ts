import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';
import { GLSL_LIB, OnsetGate, PingPong, approach, fullscreen, mulberry, type Room } from './common';
import { postVert } from './shaders';

/**
 * CHLADNI — a square plate bowed by the spectrum, with three sands on it.
 *
 * A free square plate vibrating in mode (n, m) has displacement close to
 * cos(n pi x) cos(m pi y) +/- cos(m pi x) cos(n pi y). Sand bounces off the
 * moving regions and comes to rest on the nodal lines, where the plate is
 * still. Here each band (bass, mids, treble) drives its own mode and has its
 * own coloured sand: each grain is pushed down the gradient of |f| toward the
 * nearest node and jittered in proportion to the local vibration. Mode numbers
 * glide continuously, so figures melt into each other; onsets re-tune the
 * loudest band. A band that falls silent leaves its sand exactly where it lay.
 */

const SCALE: Record<Quality, number> = { low: 0.5, medium: 0.7, high: 0.9 };
const STEPS: Record<Quality, number> = { low: 2, medium: 3, high: 4 };
const PLATE = 0.4; // half-size in screen-height units
const RANGES: [number, number][] = [[1, 3], [3, 6], [6, 10]];

const stepFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uAspect, uTime, uInit, uWidth, uSprinkle, uStep;
uniform vec3 uN, uM, uSign, uAmp;
out vec4 fragColor;
${GLSL_LIB}
const float PI = 3.14159265;
float field(vec2 x, float n, float m, float s) {
  return cos(n * PI * x.x) * cos(m * PI * x.y) + s * cos(m * PI * x.x) * cos(n * PI * x.y);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec2 x = p / (2.0 * ${PLATE}) + 0.5;
  bool on = x.x >= 0.0 && x.y >= 0.0 && x.x <= 1.0 && x.y <= 1.0;
  if (!on) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  if (uInit > 0.5) {
    fragColor = vec4(vec3(0.05) + 0.12 * vec3(hash(vUv * 311.0), hash(vUv * 173.0 + 4.0), hash(vUv * 97.0 + 9.0)), 1.0);
    return;
  }
  vec3 outv;
  for (int b = 0; b < 3; b++) {
    float n = uN[b], m = uM[b], s = uSign[b], amp = uAmp[b];
    float f = field(x, n, m, s);
    const float e = 0.0015;
    vec2 g = vec2(field(x + vec2(e, 0.0), n, m, s) - field(x - vec2(e, 0.0), n, m, s),
                  field(x + vec2(0.0, e), n, m, s) - field(x - vec2(0.0, e), n, m, s)) / (2.0 * e);
    float gl = max(length(g), 1e-3);
    // Downhill on |f|: toward the nearest nodal line.
    // uStep is this sub-step's share of a 60 Hz frame, so settling is frame-rate independent.
    vec2 vel = -sign(f) * g / (PI * (n + m)) * amp * 0.0045 * uStep;
    // Bouncing: grains on antinodes are thrown about, grains on nodes rest.
    float fb = float(b) * 7.13;
    vec2 jit = (vec2(hash(vUv * 913.0 + uTime + fb), hash(vUv * 577.0 - uTime + fb)) - 0.5) * abs(f) * amp * 0.006 * sqrt(uStep);
    vec2 back = x - vel + jit;
    vec2 suv = ((back - 0.5) * 2.0 * ${PLATE}) / vec2(uAspect, 1.0) + 0.5;
    float d = texture(uPrev, suv)[b];
    // Settle toward the figure: sand gathers within a grain's width of the node
    // and is shaken off everywhere the plate moves.
    float dist = abs(f) / gl;
    float target = 1.7 * exp(-pow(dist / uWidth, 2.0));
    d += (target - d) * min(1.0, amp * 0.032 * uStep * (target > d ? 1.0 : 0.6));
    d += uSprinkle * uStep * (0.5 + hash(vUv * 41.0 + uTime + fb));
    outv[b] = clamp(d, 0.0, 2.0);
  }
  fragColor = vec4(outv, 1.0);
}
`;

const showFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uState;
uniform float uAspect, uAngle, uGrainPx, uSeed, uGrain;
uniform vec2 uTexel;
uniform vec3 uC0, uC1, uC2;
out vec4 fragColor;
${GLSL_LIB}
void main() {
  vec2 p0 = (vUv - 0.5) * vec2(uAspect, 1.0);
  vec2 p = rot(-uAngle) * p0;
  vec2 x = p / (2.0 * ${PLATE}) + 0.5;
  vec2 q = vUv - 0.5;
  // Gallery wall and the plate's soft shadow on it.
  vec2 sh = abs(rot(-uAngle) * (p0 - vec2(0.012, -0.018))) - ${PLATE};
  float shadow = smoothstep(0.05, -0.01, max(sh.x, sh.y));
  vec3 col = vec3(0.034, 0.033, 0.036) * (1.0 - 0.55 * shadow) * (1.0 - 0.6 * dot(q, q));
  vec2 ax = abs(x - 0.5);
  if (max(ax.x, ax.y) <= 0.5) {
    // Brushed, dark metal; a broad raking light from the upper left.
    float brush = noise(vec2(x.x * 3.0, x.y * 420.0)) * 0.5 + noise(vec2(x.x * 9.0, x.y * 1300.0)) * 0.5;
    float light = 0.75 + 0.35 * (1.0 - length(x - vec2(0.2, 0.85)));
    vec3 plate = vec3(0.085, 0.088, 0.095) * light * (0.9 + 0.2 * brush);
    float bevel = smoothstep(0.492, 0.5, max(ax.x, ax.y));
    plate += vec3(0.12) * bevel * step(x.y + x.x * 0.2, 0.9);
    vec2 suv = ((x - 0.5) * 2.0 * ${PLATE}) / vec2(uAspect, 1.0) + 0.5;
    vec3 d = texture(uState, suv).rgb;
    vec3 ds = texture(uState, suv + vec2(uTexel.x, -uTexel.y) * 2.5).rgb;
    plate *= 1.0 - 0.35 * clamp(ds.r + ds.g + ds.b, 0.0, 1.0);
    // Grains are fixed to the screen's pixel lattice so they sparkle, never swim.
    vec2 cell = floor(gl_FragCoord.xy / uGrainPx);
    vec3 cols[3] = vec3[3](uC0, uC1, uC2);
    col = plate;
    for (int b = 0; b < 3; b++) {
      float h = hashCell(cell + float(b) * 1931.0);
      float grain = step(h, d[b] * 0.55);
      float packed = smoothstep(0.9, 1.6, d[b]) * 0.7;
      float sand = max(grain, packed);
      float tone = 0.72 + 0.4 * hashCell(cell * 3.0 + float(b) * 711.0);
      col = mix(col, cols[b] * tone, sand);
    }
    // The clamp at the centre, where the bow drives the plate.
    float r = length(x - 0.5);
    col = mix(col, vec3(0.02), smoothstep(0.017, 0.013, r));
    col += vec3(0.25) * smoothstep(0.004, 0.0, abs(r - 0.016)) * 0.5;
  }
  col += (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
  fragColor = vec4(col, 1.0);
}
`;

export class Chladni implements Room {
  private readonly state: PingPong;
  private readonly step: p5.Shader;
  private readonly show: p5.Shader;
  private quality: Quality = 'medium';
  private density = 1;
  private rng = mulberry(1);
  private t = 0;
  private angle = 0;
  private readonly n = [2, 4, 7];
  private readonly m = [3, 5, 9];
  private readonly sign = [-1, 1, -1];
  private readonly targetN = [2, 4, 7];
  private readonly targetM = [3, 5, 9];
  private readonly targetSign = [-1, 1, -1];
  private readonly amp = [0, 0, 0];
  private sinceRetune = 0;
  private readonly onset = new OnsetGate(0.5);

  constructor(private readonly p: p5) {
    this.state = new PingPong(p, SCALE);
    this.step = p.createShader(postVert, stepFrag);
    this.show = p.createShader(postVert, showFrag);
  }

  get bufferSize() { return this.state.size; }

  configure(quality: Quality, density: number) {
    this.quality = quality;
    this.density = density;
    this.state.configure(quality, density);
  }

  resize(w: number, h: number) { this.state.resize(w, h); }

  reset(seed: number) {
    this.rng = mulberry(seed ^ 0x1b873593);
    for (let b = 0; b < 3; b++) {
      this.retune(b);
      this.n[b] = this.targetN[b]!;
      this.m[b] = this.targetM[b]!;
      this.sign[b] = this.targetSign[b]!;
      this.amp[b] = 0;
    }
    this.t = 0;
    this.sinceRetune = 0;
    this.onset.reset();
    this.state.fresh = true;
  }

  frame(f: AudioFeatures, dt: number, playing: boolean, s: VisualSettings) {
    const p = this.p;
    this.state.ensure();
    if (!this.state.read) return;
    const aspect = p.width / p.height;
    const [bw, bh] = this.state.size;

    if (this.state.fresh) {
      this.state.pass(this.step, (sh) => {
        sh.setUniform('uInit', 1);
        sh.setUniform('uAspect', aspect);
      });
      this.state.fresh = false;
    }

    if (playing) {
      this.t += dt;
      const bands = f.silent ? [0, 0, 0] : [f.bass, 0.5 * (f.lowMid + f.highMid), f.treble];
      const drive = 0.5 + s.tension;
      for (let b = 0; b < 3; b++) this.amp[b] = approach(this.amp[b]!, Math.min(1.5, bands[b]! * drive), dt, 0.12);

      const hit = this.onset.step(f, dt, s.reducedMotion ? 1.5 : 0.5);
      this.sinceRetune += dt;
      if (hit || this.sinceRetune > 14) {
        this.sinceRetune = 0;
        let loud = 0;
        for (let b = 1; b < 3; b++) if (bands[b]! > bands[loud]!) loud = b;
        this.retune(loud);
        if (this.rng() < 0.25) this.retune(Math.floor(this.rng() * 3));
      }
      const glide = s.reducedMotion ? 3 : 1.4;
      for (let b = 0; b < 3; b++) {
        this.n[b] = approach(this.n[b]!, this.targetN[b]!, dt, glide);
        this.m[b] = approach(this.m[b]!, this.targetM[b]!, dt, glide);
        this.sign[b] = approach(this.sign[b]!, this.targetSign[b]!, dt, glide);
      }
      if (s.camera === 'drift' && !s.reducedMotion) this.angle = Math.sin(this.t * 0.05) * 0.14;

      const steps = STEPS[this.quality];
      const share = Math.min(6, dt * 60) / steps;
      for (let i = 0; i < steps; i++) {
        this.state.pass(this.step, (sh) => {
          sh.setUniform('uInit', 0);
          sh.setUniform('uAspect', aspect);
          sh.setUniform('uTime', (this.t * 7.3 + i * 0.37) % 100);
          sh.setUniform('uN', this.n);
          sh.setUniform('uM', this.m);
          sh.setUniform('uSign', this.sign);
          sh.setUniform('uAmp', this.amp);
          sh.setUniform('uWidth', 0.0035 + 0.006 * (1 - s.detail));
          sh.setUniform('uSprinkle', 0.0004 * (1 - s.memory * 0.7));
          sh.setUniform('uStep', share);
        });
      }
    }

    p.clear();
    fullscreen(p, this.show, (sh) => {
      sh.setUniform('uState', this.state.read!);
      sh.setUniform('uAspect', aspect);
      sh.setUniform('uAngle', this.angle);
      sh.setUniform('uTexel', [1 / bw, 1 / bh]);
      sh.setUniform('uGrainPx', Math.max(1, this.density * 1.1));
      sh.setUniform('uC0', [0.95, 0.91, 0.82]);
      sh.setUniform('uC1', [0.86, 0.5, 0.3]);
      sh.setUniform('uC2', [0.55, 0.78, 0.95]);
      sh.setUniform('uSeed', s.reducedMotion ? 0 : (p.frameCount % 61) * 7.31);
      sh.setUniform('uGrain', 0.012);
    });
  }

  destroy() { this.state.destroy(); }

  private retune(b: number) {
    const r = this.rng;
    const [lo, hi] = RANGES[b]!;
    const n = lo + Math.floor(r() * (hi - lo + 1));
    this.targetN[b] = n;
    this.targetM[b] = n + 1 + Math.floor(r() * (2 + b * 1.5));
    this.targetSign[b] = r() < 0.5 ? -1 : 1;
  }
}
