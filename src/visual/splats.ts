import p5 from 'p5';
import type { AudioFeatures, Quality, VisualSettings } from '../types';

/**
 * SPLAT — the music as a cloud of anisotropic 3D Gaussians. A luminous head
 * wanders through space; every 1/24 s of audio it sheds splats around itself:
 * broad ember clouds for bass, ribbon petals and twin helix strands for the
 * mids, needle sparks for treble, a luminous spine along its path, and a
 * Fibonacci-sphere shell on each onset. Chunks are drawn back-to-front with
 * alpha blending, so the cloud reads as one soft, volumetric object.
 *
 * Rendering borrows from 3D Gaussian splatting: view-dependent colour (petals
 * shimmer like thin film as their axis turns to the eye), and a thin-lens
 * depth of field that widens each splat by its circle of confusion and turns
 * far-from-focus sparks into bokeh discs.
 */

const ROW_RATE = 24;
const MAX_SECONDS = 60;
const MIN_SECONDS = 8;
const CHUNK_ROWS = 12;
const PER_ROW: Record<Quality, number> = { low: 10, medium: 24, high: 40 };
const CAPACITY = CHUNK_ROWS * PER_ROW.high * 3;
const F = 18; // cx cy cz | ux uy uz | vx vy vz | velx vely velz | r g b a | birth | kind
const FOV = Math.PI / 5;

/** Splat kinds: drive per-kind shading in the shader. */
const KIND = { bass: 0, petal: 1, spark: 2, burst: 3, strand: 4, spine: 5 } as const;

type V3 = [number, number, number];
const EMBER: V3 = [1.0, 0.36, 0.12];
const GOLD: V3 = [1.0, 0.78, 0.4];
const ROSE: V3 = [0.98, 0.42, 0.62];
const IVORY: V3 = [1.0, 0.93, 0.84];
const TEAL: V3 = [0.2, 0.85, 0.9];
const ICE: V3 = [0.78, 0.9, 1.0];
const HOT: V3 = [1.0, 0.55, 0.35];
const VIOLET: V3 = [0.62, 0.48, 1.0];

const vert = /* glsl */ `#version 300 es
precision highp float;
in vec3 aPosition;
in vec4 aVertexColor;
in vec2 aCorner;
in vec3 aAxisU;
in vec3 aAxisV;
in vec3 aVel;
in float aBirth;
in float aKind;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform float uNow, uWindow, uDrift, uPulse, uBass, uTreble;
uniform float uFocus, uAperture, uFlow, uSheen;
out vec2 vC;
out vec4 vCol;
out float vFade;
out float vBokeh;

float h1(float n) { return fract(sin(n) * 43758.5453); }
// A slow, smoke-like flow field; the cloud never quite holds still.
vec3 flow(vec3 p, float t) {
  return vec3(sin(p.y * 3.1 + t * 0.21) + sin(p.z * 1.7 - t * 0.13),
              sin(p.z * 2.7 + t * 0.17) + sin(p.x * 1.9 + t * 0.11),
              sin(p.x * 2.3 - t * 0.19) + sin(p.y * 1.3 + t * 0.15));
}

void main() {
  float age = max(0.0, uNow - aBirth);
  int kind = int(aKind + 0.5);
  vec3 c = aPosition + aVel * (1.0 - exp(-age * 1.6)) * uDrift;
  c += flow(c * 1.3, uNow) * uFlow * (1.0 - exp(-age * 0.12)) * 0.05;

  float young = exp(-age * 0.6);
  float grow = 1.0 + uPulse * exp(-age * 3.0) + uBass * 0.35 * young;
  vec4 mc = uModelViewMatrix * vec4(c, 1.0);
  vec3 vu = (uModelViewMatrix * vec4(aAxisU * grow, 0.0)).xyz;
  vec3 vv = (uModelViewMatrix * vec4(aAxisV * grow, 0.0)).xyz;

  // Depth of field: circle of confusion grows with distance from the focal plane.
  float coc = min(abs(-mc.z - uFocus) / uFocus * uAperture, uAperture * 0.8);
  float sz = 0.5 * (length(vu.xy) + length(vv.xy));
  float spread = (sz * sz + 1.0) / (sz * sz + coc * coc + 1.0);
  vBokeh = smoothstep(0.35, 0.9, 1.0 - spread);

  mc.xyz += (vu * aCorner.x + vv * aCorner.y) * 3.0;
  mc.xy += aCorner * 3.0 * coc;
  vC = aCorner * 3.0;

  vec3 col = aVertexColor.rgb;
  float a = aVertexColor.a * mix(1.0, spread, 0.85);
  // View-dependent radiance: petals and strands shimmer like thin film as
  // their long axis turns toward or away from the eye.
  float facing = abs(normalize(vu + 1e-6).z);
  if (kind == 1 || kind == 4) {
    vec3 film = 0.5 + 0.5 * cos(6.2831 * (facing * 1.3 + vec3(0.0, 0.33, 0.67)));
    col = mix(col, col * 0.35 + film * 0.75, uSheen * smoothstep(0.15, 0.95, facing));
    a *= 0.75 + 0.5 * facing;
  }
  // Treble needles twinkle.
  if (kind == 2) {
    float h = h1(aBirth * 91.7 + aPosition.x * 413.0 + aPosition.y * 97.0);
    a *= (0.45 + 0.55 * (0.5 + 0.5 * sin(uNow * (8.0 + 9.0 * h) + h * 40.0))) * (0.7 + 0.8 * uTreble);
  }
  if (kind == 5) a *= 0.6 + 0.8 * young;

  vFade = (1.0 - smoothstep(uWindow * 0.55, uWindow, age)) * (0.45 + 0.55 * exp(-age * 0.9));
  vCol = vec4(col, a);
  gl_Position = uProjectionMatrix * mc;
}
`;

const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vC;
in vec4 vCol;
in float vFade;
in float vBokeh;
out vec4 fragColor;
void main() {
  float r2 = dot(vC, vC);
  if (r2 > 9.0) discard;
  float g = exp(-0.5 * r2);
  // Out of focus, a splat becomes a lens disc with a slightly brighter rim.
  float rr = sqrt(r2) / 3.0;
  float disc = smoothstep(1.0, 0.86, rr) * (0.5 + 0.5 * smoothstep(0.5, 0.95, rr)) * 0.45;
  float a = vCol.a * mix(g, disc, vBokeh) * vFade;
  fragColor = vec4(vCol.rgb * a, a);
}
`;

interface Chunk {
  data: Float32Array;
  count: number;
  rows: number;
  lastT: number;
  sum: V3;
  geom: p5.Geometry | null;
  dirty: boolean;
}

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
const mix3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class Splats {
  private readonly shader: p5.Shader;
  private chunks: Chunk[] = [];
  private rng = mulberry(1);
  private seed = 1;
  private head: V3 = [0, 0, 0];
  private dir: V3 = [1, 0, 0];
  private sinceOnset = 9;
  private pulse = 0;
  private orbit = 0;
  private helix = 0;
  private bass = 0;
  private treble = 0;
  private readonly view = { x: 0, y: 0, z: 0, r: 1 };
  private snap = true;
  private quality: Quality = 'medium';

  constructor(private readonly p: p5) {
    this.shader = p.createShader(vert, frag);
  }

  setQuality(q: Quality) { this.quality = q; }

  get count() {
    let n = 0;
    for (const c of this.chunks) n += c.count;
    return n;
  }

  reset(seed: number) {
    for (const c of this.chunks) if (c.geom) this.p.freeGeometry(c.geom);
    this.chunks = [];
    this.seed = seed >>> 0;
    this.rng = mulberry(this.seed ^ 0x5bd1e995);
    this.head = [0, 0, 0];
    const a = this.rng() * Math.PI * 2;
    this.dir = [Math.cos(a), (this.rng() - 0.5) * 0.4, Math.sin(a)];
    this.norm(this.dir);
    this.sinceOnset = 9;
    this.pulse = 0;
    this.helix = 0;
    this.bass = this.treble = 0;
    this.snap = true;
  }

  emit(f: AudioFeatures, t: number, s: VisualSettings) {
    const r = this.rng;
    const dt = 1 / ROW_RATE;
    const d = this.dir, h = this.head;

    // Steer the head: a slowly rotating angular velocity, stronger with bass,
    // spectral change and Tension; a soft pull keeps the cloud near the origin.
    const k = (0.5 + 2.4 * f.change + 1.4 * f.bass) * (0.4 + 1.2 * s.tension);
    const sd = this.seed % 97;
    const w: V3 = [Math.sin(t * 0.37 + sd) * k, Math.sin(t * 0.23 + sd * 1.7) * k, Math.sin(t * 0.31 + sd * 2.3) * k];
    d[0] += (w[1] * d[2] - w[2] * d[1]) * dt;
    d[1] += (w[2] * d[0] - w[0] * d[2]) * dt;
    d[2] += (w[0] * d[1] - w[1] * d[0]) * dt;
    const hr = Math.hypot(h[0], h[1], h[2]);
    if (hr > 0.9) for (let i = 0; i < 3; i++) d[i] -= (h[i] / hr) * (hr - 0.9) * 0.9 * dt;
    this.norm(d);
    const speed = 0.3 + 0.4 * f.rms + 0.3 * f.bass;
    for (let i = 0; i < 3; i++) h[i] += d[i] * speed * dt;

    // Local frame around the travel direction.
    let side: V3 = [d[2], 0, -d[0]];
    if (Math.hypot(side[0], side[2]) < 1e-3) side = [1, 0, 0];
    this.norm(side);
    const up: V3 = [side[1] * d[2] - side[2] * d[1], side[2] * d[0] - side[0] * d[2], side[0] * d[1] - side[1] * d[0]];

    const chunk = this.liveChunk(t);
    const per = PER_ROW[this.quality];
    const energy = f.silent ? 0 : Math.min(1, f.rms * 1.4 + 0.3 * f.bass);
    const n = f.silent ? 1 : Math.round(per * (0.12 + 0.88 * energy));
    const warm = 0.25 + 0.6 * f.centroid;
    const wB = 0.2 + f.bass, wM = 0.15 + f.lowMid + 0.5 * f.highMid, wT = 0.05 + f.treble * (0.8 + 1.4 * s.detail);
    const total = wB + wM + wT;
    const g = () => (r() + r() + r() - 1.5) * 1.15;

    for (let i = 0; i < n; i++) {
      const pick = r() * total;
      if (f.silent) {
        this.push(chunk, [h[0] + g() * 0.05, h[1] + g() * 0.05, h[2] + g() * 0.05], this.randAxes(0.02, 0.02), [0, 0, 0], ICE, 0.05, t, KIND.bass);
      } else if (pick < wB) {
        const sc = 0.03 + 0.05 * f.bass;
        const spread = 0.3 * (0.6 + f.lowMid);
        const col = mix3(mix3(EMBER, GOLD, r() * 0.6), TEAL, warm * 0.35);
        this.push(chunk, [h[0] + g() * spread, h[1] + g() * spread, h[2] + g() * spread],
          this.randAxes(sc, sc * (0.45 + 0.4 * r())), [0, 0, 0], col, 0.025 + 0.05 * f.bass, t, KIND.bass);
      } else if (pick < wB + wM) {
        const a = g() * 0.22 * (0.4 + f.lowMid), b = g() * 0.06;
        const lu = 0.025 + 0.045 * f.highMid, lv = 0.005 + 0.006 * r();
        const ang = g() * 0.6;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const U: V3 = [(d[0] * ca + side[0] * sa) * lu, (d[1] * ca + side[1] * sa) * lu, (d[2] * ca + side[2] * sa) * lu];
        const V: V3 = [up[0] * lv, up[1] * lv, up[2] * lv];
        const col = mix3(mix3(ROSE, IVORY, f.highMid), TEAL, warm * 0.5);
        this.push(chunk, [h[0] + side[0] * a + up[0] * b, h[1] + side[1] * a + up[1] * b, h[2] + side[2] * a + up[2] * b],
          [U, V], [0, 0, 0], col, 0.16 + 0.16 * f.highMid, t, KIND.petal);
      } else {
        const sc = (0.004 + 0.004 * r()) * (1.2 - 0.5 * s.detail);
        const [U, V] = this.randAxes(sc * 3, sc);
        this.push(chunk, [h[0] + g() * 0.28, h[1] + g() * 0.28, h[2] + g() * 0.28], [U, V], [0, 0, 0], mix3(TEAL, ICE, r()), 0.85, t, KIND.spark);
      }
    }

    if (!f.silent) {
      // Spine: one bright filament splat per row, stretched along the path, so
      // the head leaves a continuous luminous thread through the cloud.
      const sl = speed * dt * 0.55;
      this.push(chunk, [h[0], h[1], h[2]], [[d[0] * sl, d[1] * sl, d[2] * sl], [up[0] * 0.0022, up[1] * 0.0022, up[2] * 0.0022]],
        [0, 0, 0], mix3(IVORY, GOLD, 0.3 * (1 - f.centroid)), 0.32 + 0.4 * f.rms, t, KIND.spine);

      // Twin helix strands wound around the path; the mids set radius and twist.
      const mids = Math.min(1, 0.6 * f.lowMid + 0.6 * f.highMid);
      this.helix += dt * (3 + 7 * f.lowMid) * (0.6 + 0.8 * s.tension);
      const radius = 0.035 + 0.09 * f.lowMid;
      const per2 = Math.max(1, Math.round(per * 0.1 * (0.3 + mids)));
      for (let strand = 0; strand < 2; strand++) {
        for (let k = 0; k < per2; k++) {
          const ph = this.helix + strand * Math.PI + (k / per2) * 0.25;
          const cs = Math.cos(ph) * radius, sn = Math.sin(ph) * radius;
          const pos: V3 = [h[0] + side[0] * cs + up[0] * sn, h[1] + side[1] * cs + up[1] * sn, h[2] + side[2] * cs + up[2] * sn];
          // Tangent of the helix: travel direction plus the twist.
          const tw = radius * 4;
          const T: V3 = [d[0] - side[0] * Math.sin(ph) * tw + up[0] * Math.cos(ph) * tw,
            d[1] - side[1] * Math.sin(ph) * tw + up[1] * Math.cos(ph) * tw,
            d[2] - side[2] * Math.sin(ph) * tw + up[2] * Math.cos(ph) * tw];
          this.norm(T);
          const lu = 0.014 + 0.012 * mids;
          const col = strand === 0 ? mix3(IVORY, ROSE, 0.4 + 0.4 * f.highMid) : mix3(TEAL, VIOLET, f.centroid);
          this.push(chunk, pos, [[T[0] * lu, T[1] * lu, T[2] * lu], [up[0] * 0.003, up[1] * 0.003, up[2] * 0.003]],
            [0, 0, 0], col, 0.12 + 0.3 * mids, t, KIND.strand);
        }
      }
    }

    // Onset: a crisp shell of hot splats on a Fibonacci sphere, thrown outward
    // at one speed so it reads as an expanding dandelion; they drift and settle.
    this.sinceOnset += dt;
    if (!f.silent && f.onset > 0.6 && this.sinceOnset > 0.15) {
      this.sinceOnset = 0;
      this.pulse = 1;
      const burst = Math.round(per * (0.9 + 1.1 * f.onset));
      const sp = 0.3 + 0.35 * f.onset;
      const spin = r() * Math.PI * 2;
      const col = mix3(HOT, VIOLET, r() < 0.3 ? 0.6 : 0);
      for (let i = 0; i < burst; i++) {
        const yy = 1 - (2 * (i + 0.5)) / burst;
        const rr = Math.sqrt(1 - yy * yy);
        const th = i * 2.39996323 + spin;
        const v: V3 = [Math.cos(th) * rr, yy, Math.sin(th) * rr];
        const j = sp * (0.96 + 0.08 * r());
        const L = 0.01 + 0.008 * f.onset;
        this.push(chunk, [h[0], h[1], h[2]], [[v[0] * L, v[1] * L, v[2] * L], this.randAxes(0.003, 0.003)[1]],
          [v[0] * j, v[1] * j, v[2] * j], mix3(col, IVORY, r() * 0.5), 0.7, t, KIND.burst);
      }
    }
    chunk.rows++;
    chunk.lastT = t;
    chunk.dirty = true;

    while (this.chunks.length && this.chunks[0].lastT < t - MAX_SECONDS) {
      const old = this.chunks.shift()!;
      if (old.geom) this.p.freeGeometry(old.geom);
    }
  }

  draw(s: VisualSettings, dt: number, w: number, h: number, now: number, playing: boolean, f: AudioFeatures) {
    const p = this.p;
    if (playing) {
      this.bass = approach(this.bass, f.silent ? 0 : f.bass, dt, s.reducedMotion ? 0.5 : 0.08);
      this.treble = approach(this.treble, f.silent ? 0 : f.treble, dt, 0.1);
    }
    const windowS = MIN_SECONDS + s.memory * (MAX_SECONDS - MIN_SECONDS);
    const visible = this.chunks.filter((c) => c.count > 0 && c.lastT >= now - windowS);
    if (!visible.length) return;

    // Frame the visible cloud.
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const c of visible) { cx += c.sum[0]; cy += c.sum[1]; cz += c.sum[2]; n += c.count; }
    cx /= n; cy /= n; cz /= n;
    let rad = 0.3;
    for (const c of visible) {
      const step = Math.max(1, Math.floor(c.count / 24));
      for (let i = 0; i < c.count; i += step) {
        const o = i * F;
        rad = Math.max(rad, Math.hypot(c.data[o] - cx, c.data[o + 1] - cy, c.data[o + 2] - cz));
      }
    }
    const v = this.view;
    if (this.snap) { v.x = cx; v.y = cy; v.z = cz; v.r = rad; this.snap = false; }
    const tc = s.reducedMotion ? 3 : 1.2;
    v.x = approach(v.x, cx, dt, tc); v.y = approach(v.y, cy, dt, tc); v.z = approach(v.z, cz, dt, tc);
    v.r = approach(v.r, rad, dt, rad > v.r ? 0.5 : tc * 2);

    if (playing) this.pulse = Math.max(0, this.pulse - dt * 4);
    if (s.camera === 'drift' && !s.reducedMotion) this.orbit += dt * 0.12;
    const tilt = 0.35 + Math.sin(this.orbit * 0.4) * 0.15;
    const unit = (Math.min(w, h) * 0.5) / Math.max(0.35, v.r);

    // Back-to-front chunk order in eye space (Rx(tilt) * Ry(orbit) applied to the centroid).
    const cosB = Math.cos(this.orbit), sinB = Math.sin(this.orbit), cosA = Math.cos(tilt), sinA = Math.sin(tilt);
    const depth = (c: Chunk) => {
      const x = c.sum[0] / c.count - v.x, y = c.sum[1] / c.count - v.y, z = c.sum[2] / c.count - v.z;
      const z1 = -x * sinB + z * cosB;
      return y * sinA + z1 * cosA;
    };
    visible.sort((a, b) => depth(a) - depth(b));

    p.push();
    p.noStroke();
    p.blendMode(p.BLEND);
    p.rotateX(tilt);
    p.rotateY(this.orbit);
    p.scale(unit);
    p.translate(-v.x, -v.y, -v.z);
    p.shader(this.shader);
    this.shader.setUniform('uNow', now);
    this.shader.setUniform('uWindow', windowS);
    this.shader.setUniform('uDrift', s.reducedMotion ? 0.3 : 1);
    this.shader.setUniform('uPulse', this.pulse * (s.reducedMotion ? 0.2 : 0.8));
    this.shader.setUniform('uBass', this.bass * (0.4 + 1.2 * s.tension) * (s.reducedMotion ? 0.25 : 1));
    this.shader.setUniform('uTreble', this.treble);
    this.shader.setUniform('uFocus', h / 2 / Math.tan(FOV / 2));
    this.shader.setUniform('uAperture', Math.min(w, h) * 0.024);
    this.shader.setUniform('uFlow', s.reducedMotion ? 0.3 : 1);
    this.shader.setUniform('uSheen', 0.85);
    for (const c of visible) {
      if (c.dirty || !c.geom) this.build(c);
      if (c.geom) p.model(c.geom);
    }
    p.pop();
  }

  destroy() { this.reset(0); }

  private liveChunk(t: number): Chunk {
    const last = this.chunks[this.chunks.length - 1];
    if (last && last.rows < CHUNK_ROWS) return last;
    const c: Chunk = { data: new Float32Array(CAPACITY * F), count: 0, rows: 0, lastT: t, sum: [0, 0, 0], geom: null, dirty: true };
    this.chunks.push(c);
    return c;
  }

  private push(c: Chunk, pos: V3, axes: [V3, V3], vel: V3, col: V3, alpha: number, t: number, kind: number) {
    if (c.count >= CAPACITY) return;
    const o = c.count * F, D = c.data;
    D[o] = pos[0]; D[o + 1] = pos[1]; D[o + 2] = pos[2];
    D[o + 3] = axes[0][0]; D[o + 4] = axes[0][1]; D[o + 5] = axes[0][2];
    D[o + 6] = axes[1][0]; D[o + 7] = axes[1][1]; D[o + 8] = axes[1][2];
    D[o + 9] = vel[0]; D[o + 10] = vel[1]; D[o + 11] = vel[2];
    D[o + 12] = col[0]; D[o + 13] = col[1]; D[o + 14] = col[2]; D[o + 15] = alpha;
    D[o + 16] = t;
    D[o + 17] = kind;
    c.sum[0] += pos[0]; c.sum[1] += pos[1]; c.sum[2] += pos[2];
    c.count++;
  }

  private build(c: Chunk) {
    const p = this.p;
    if (c.geom) { p.freeGeometry(c.geom); c.geom = null; }
    c.dirty = false;
    if (!c.count) return;
    const nv = c.count * 4;
    const geom = new p5.Geometry(1, 1);
    const verts: p5.Vector[] = new Array(nv);
    const norms: p5.Vector[] = new Array(nv);
    const colors: number[] = new Array(nv * 4);
    const corner: number[] = new Array(nv * 2);
    const au: number[] = new Array(nv * 3), av: number[] = new Array(nv * 3), vel: number[] = new Array(nv * 3);
    const birth: number[] = new Array(nv);
    const kind: number[] = new Array(nv);
    const faces: [number, number, number][] = new Array(c.count * 2);
    const zn = p.createVector(0, 0, 1);
    const C = [-1, -1, 1, -1, 1, 1, -1, 1];
    const D = c.data;
    for (let i = 0; i < c.count; i++) {
      const o = i * F;
      const center = p.createVector(D[o], D[o + 1], D[o + 2]);
      for (let k = 0; k < 4; k++) {
        const vi = i * 4 + k;
        verts[vi] = center;
        norms[vi] = zn;
        corner[vi * 2] = C[k * 2]; corner[vi * 2 + 1] = C[k * 2 + 1];
        for (let j = 0; j < 3; j++) {
          au[vi * 3 + j] = D[o + 3 + j];
          av[vi * 3 + j] = D[o + 6 + j];
          vel[vi * 3 + j] = D[o + 9 + j];
        }
        colors[vi * 4] = D[o + 12]; colors[vi * 4 + 1] = D[o + 13]; colors[vi * 4 + 2] = D[o + 14]; colors[vi * 4 + 3] = D[o + 15];
        birth[vi] = D[o + 16];
        kind[vi] = D[o + 17];
      }
      faces[i * 2] = [i * 4, i * 4 + 1, i * 4 + 2];
      faces[i * 2 + 1] = [i * 4, i * 4 + 2, i * 4 + 3];
    }
    geom.vertices = verts;
    geom.vertexNormals = norms;
    geom.faces = faces;
    (geom as unknown as { vertexColors: number[] }).vertexColors = colors;
    geom.vertexProperty('aCorner', corner, 2);
    geom.vertexProperty('aAxisU', au, 3);
    geom.vertexProperty('aAxisV', av, 3);
    geom.vertexProperty('aVel', vel, 3);
    geom.vertexProperty('aBirth', birth, 1);
    geom.vertexProperty('aKind', kind, 1);
    c.geom = geom;
  }

  private randAxes(su: number, sv: number): [V3, V3] {
    const r = this.rng;
    const a: V3 = [r() - 0.5, r() - 0.5, r() - 0.5];
    this.norm(a);
    const t: V3 = [r() - 0.5, r() - 0.5, r() - 0.5];
    const b: V3 = [a[1] * t[2] - a[2] * t[1], a[2] * t[0] - a[0] * t[2], a[0] * t[1] - a[1] * t[0]];
    this.norm(b);
    return [[a[0] * su, a[1] * su, a[2] * su], [b[0] * sv, b[1] * sv, b[2] * sv]];
  }

  private norm(v: V3) {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    v[0] /= l; v[1] /= l; v[2] /= l;
  }
}
