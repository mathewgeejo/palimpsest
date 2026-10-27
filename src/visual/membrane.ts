import p5 from 'p5';
import type { AudioFeatures, Quality } from '../types';

/** History rows per second of audio playback time. */
export const ROW_RATE = 24;
/** Upper bound on remembered history (rows). 90 s at 24 rows/s. */
export const MAX_ROWS = ROW_RATE * 90;
/** Minimum visible history (rows) when Memory is at 0. */
export const MIN_VISIBLE_ROWS = ROW_RATE * 10;
/** Rows per retained geometry chunk. */
const CHUNK = 24;
const CAP = MAX_ROWS + CHUNK * 3;

// Row record layout (Float32Array, STRIDE floats per row).
const THETA = 0, SHIFT = 1, PHASE = 2, TILT_A = 3, TILT_B = 4, BASS = 5, LOWMID = 6, HIGHMID = 7,
  TREBLE = 8, ONSET = 9, CENTROID = 10, RMS = 11, SEAM = 12, BEND = 13, FOLDF = 14, TIME = 15;
const STRIDE = 16;

const QUALITY_COLUMNS: Record<Quality, number> = { low: 48, medium: 96, high: 144 };
const QUALITY_ROW_STEP: Record<Quality, number> = { low: 2, medium: 1, high: 1 };

export interface BuildParams {
  tension: number;
  detail: number;
  onsetGain: number;
  quality: Quality;
}

interface Chunk {
  geom: p5.Geometry | null;
  dirty: boolean;
  /** Number of rows (of this chunk) included the last time it was built. */
  builtRows: number;
  version: number;
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

/** Smooth, seeded 1D value noise in [-1, 1]. */
class Noise1 {
  private table = new Float32Array(256);
  constructor(seed: number) { this.reseed(seed); }
  reseed(seed: number) {
    const r = mulberry(seed);
    for (let i = 0; i < 256; i++) this.table[i] = r() * 2 - 1;
  }
  at(x: number): number {
    const i = Math.floor(x);
    const f = x - i;
    const a = this.table[i & 255];
    const b = this.table[(i + 1) & 255];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  }
}

function approach(cur: number, target: number, dt: number, attack: number, release: number) {
  const tau = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/**
 * The membrane is a shell-like sheet. Each history row is one cross-section across the
 * sheet, written once from the audio features at that moment and then kept fixed in
 * space (a "scar"); only its age changes. Rows are grouped into retained p5.Geometry
 * chunks so only the newest chunk is rebuilt while the music plays.
 */
export class Membrane {
  readonly rows = new Float32Array(CAP * STRIDE);
  /** Total rows ever written since reset (absolute index of the next row). */
  total = 0;
  private chunks = new Map<number, Chunk>();
  private version = 0;
  private noise: Noise1;
  private seedRand: () => number;

  // Growth state
  private theta = 0;
  private shift = 0;
  private phase = 0;
  private tiltAccA = 0;
  private tiltAccB = 0;
  private slowBass = 0;
  private slowLowMid = 0;
  private slowCentroid = 0.5;
  private seam = 0.5;
  private prevOnset = 0;
  private growthTime = 0;
  private baseFoldFreq = 2.5;
  private twistSign = 1;

  // Scratch buffers for geometry building (reused).
  private scratchPos = new Float32Array(0);

  constructor(private p: p5, seed: number) {
    this.noise = new Noise1(seed);
    this.seedRand = mulberry(seed);
    this.reset(seed);
  }

  reset(seed: number) {
    for (const c of this.chunks.values()) if (c.geom) this.p.freeGeometry(c.geom);
    this.chunks.clear();
    this.total = 0;
    this.noise.reseed(seed);
    this.seedRand = mulberry(seed ^ 0x9e3779b9);
    const r = this.seedRand;
    this.theta = r() * Math.PI * 2;
    this.shift = 0;
    this.phase = r() * Math.PI * 2;
    this.tiltAccA = r() * 10;
    this.tiltAccB = r() * 10;
    this.slowBass = 0;
    this.slowLowMid = 0;
    this.slowCentroid = 0.5;
    this.seam = 0.3 + r() * 0.4;
    this.prevOnset = 0;
    this.growthTime = 0;
    this.baseFoldFreq = 1.8 + r() * 1.6;
    this.twistSign = r() < 0.5 ? -1 : 1;
  }

  get headTheta() { return this.theta; }
  get headShift() { return this.shift; }

  /** Oldest absolute row index still stored. */
  get oldest() { return Math.max(0, this.total - MAX_ROWS); }

  rowTheta(n: number) { return this.rows[(n % CAP) * STRIDE + THETA]; }
  rowShift(n: number) { return this.rows[(n % CAP) * STRIDE + SHIFT]; }

  private lastParams: BuildParams | null = null;
  private readonly scratch = new Float32Array(3);

  /** Approximate bounding sphere (cx, cy, cz, r) of rows [minRow, total) in model space. */
  bounds(minRow: number, out: Float32Array): boolean {
    const prm = this.lastParams;
    if (!prm || this.total < 2) return false;
    const first = Math.max(this.oldest, Math.floor(minRow));
    const step = Math.max(1, Math.floor((this.total - first) / 90));
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const p = this.scratch;
    for (let n = this.total - 1; n >= first; n -= step) {
      const o = (n % CAP) * STRIDE;
      for (let k = 0; k <= 4; k++) {
        this.shellPoint(o, k / 4, prm, p, 0);
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        if (p[2] < z0) z0 = p[2]; if (p[2] > z1) z1 = p[2];
      }
    }
    out[0] = (x0 + x1) / 2; out[1] = (y0 + y1) / 2; out[2] = (z0 + z1) / 2;
    out[3] = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    return true;
  }

  /** Append one history row from the current features. dt = 1 / ROW_RATE of audio time. */
  emit(f: AudioFeatures, dt: number, audioTime: number) {
    this.growthTime += dt;
    this.slowBass = approach(this.slowBass, f.bass, dt, 0.08, 0.6);
    this.slowLowMid = approach(this.slowLowMid, f.lowMid, dt, 0.25, 1.2);
    this.slowCentroid = approach(this.slowCentroid, f.silent ? this.slowCentroid : f.centroid, dt, 1.6, 1.6);

    const energy = 0.5 * f.rms + 0.25 * f.bass + 0.25 * f.lowMid;
    const omega = (Math.PI * 2) / 38;
    const growth = f.silent ? 0.04 : 0.22 + 1.25 * energy;
    const dTheta = dt * omega * growth;
    this.theta += dTheta;
    this.shift += dTheta * 0.085;
    // Sustained spectral change slowly re-orients the growth axis and evolves the folds.
    this.phase += dt * (0.12 + 1.4 * f.change) * (f.silent ? 0.1 : 1);
    this.tiltAccA += dt * (0.02 + 0.5 * f.change);
    this.tiltAccB += dt * (0.015 + 0.35 * f.change);

    // A new transient picks a new seam position (near the centroid's place on the sheet).
    if (f.onset > 0.35 && this.prevOnset <= 0.35) {
      this.seam = Math.min(0.92, Math.max(0.08, 0.15 + 0.7 * f.centroid + 0.18 * this.noise.at(this.growthTime * 3.1)));
    }
    this.prevOnset = f.onset;

    const n = this.total;
    const o = (n % CAP) * STRIDE;
    const r = this.rows;
    r[o + THETA] = this.theta;
    r[o + SHIFT] = this.shift;
    r[o + PHASE] = this.phase;
    r[o + TILT_A] = 0.32 * Math.sin(this.tiltAccA);
    r[o + TILT_B] = 0.22 * Math.sin(this.tiltAccB * 1.3);
    r[o + BASS] = this.slowBass;
    r[o + LOWMID] = this.slowLowMid;
    r[o + HIGHMID] = f.highMid;
    r[o + TREBLE] = f.treble;
    r[o + ONSET] = f.onset;
    r[o + CENTROID] = this.slowCentroid;
    r[o + RMS] = f.rms;
    r[o + SEAM] = this.seam;
    r[o + BEND] = this.noise.at(this.growthTime * 0.11 + 17) * this.twistSign;
    r[o + FOLDF] = this.baseFoldFreq + 1.2 * this.noise.at(this.growthTime * 0.05 + 3);
    r[o + TIME] = audioTime;
    this.total++;

    const k = Math.floor(n / CHUNK);
    const c = this.chunks.get(k);
    if (c) c.dirty = true;
    else this.chunks.set(k, { geom: null, dirty: true, builtRows: 0, version: -1 });

    // Drop chunks that fell out of the bounded history.
    const minChunk = Math.floor(this.oldest / CHUNK) - 1;
    for (const [ck, ch] of this.chunks) {
      if (ck < minChunk) {
        if (ch.geom) this.p.freeGeometry(ch.geom);
        this.chunks.delete(ck);
      }
    }
  }

  /** Invalidate all built geometry (quality / tension / detail changed). */
  invalidate() {
    this.version++;
  }

  /**
   * Build dirty / outdated chunks. The live (newest) chunk is always rebuilt first;
   * older chunks are rebuilt at most `budget` per call so settings changes don't stall.
   */
  update(params: BuildParams, budget: number) {
    this.lastParams = params;
    if (this.total === 0) return;
    const liveK = Math.floor((this.total - 1) / CHUNK);
    const live = this.chunks.get(liveK);
    if (live && (live.dirty || live.version !== this.version)) this.build(liveK, live, params);
    let spent = 0;
    for (let k = liveK - 1; k >= 0 && spent < budget; k--) {
      const c = this.chunks.get(k);
      if (!c) break;
      if (c.dirty || c.version !== this.version) {
        this.build(k, c, params);
        spent++;
      }
    }
  }

  draw(minRow: number) {
    const p = this.p;
    for (const [k, c] of this.chunks) {
      if (!c.geom) continue;
      if ((k + 1) * CHUNK - 1 < minRow) continue;
      p.model(c.geom);
    }
  }

  get chunkCount() { return this.chunks.size; }
  vertexCount() {
    let v = 0;
    for (const c of this.chunks.values()) if (c.geom) v += c.geom.vertices.length;
    return v;
  }

  private build(k: number, c: Chunk, params: BuildParams) {
    const p = this.p;
    const step = QUALITY_ROW_STEP[params.quality];
    const cols = QUALITY_COLUMNS[params.quality];
    const r0 = k * CHUNK;
    const r1 = Math.min((k + 1) * CHUNK, this.total) - 1;
    const isLive = r1 === this.total - 1 && r1 < (k + 1) * CHUNK - 1;

    // Rows in this chunk, plus the previous chunk's last row so strips connect seamlessly.
    const list: number[] = [];
    const prev = r0 - step;
    if (prev >= this.oldest) list.push(prev);
    for (let n = r0; n <= r1; n++) if (n % step === 0) list.push(n);
    if (isLive && list[list.length - 1] !== r1) list.push(r1);

    if (c.geom) { p.freeGeometry(c.geom); c.geom = null; }
    c.dirty = false;
    c.version = this.version;
    c.builtRows = r1 - r0 + 1;
    if (list.length < 2) return;

    const nr = list.length;
    const need = nr * cols * 3;
    if (this.scratchPos.length < need) this.scratchPos = new Float32Array(need);
    const pos = this.scratchPos;
    for (let i = 0; i < nr; i++) {
      const o = (list[i] % CAP) * STRIDE;
      for (let j = 0; j < cols; j++) {
        this.shellPoint(o, j / (cols - 1), params, pos, (i * cols + j) * 3);
      }
    }

    const geom = new p5.Geometry(1, 1);
    const verts: p5.Vector[] = new Array(nr * cols);
    const norms: p5.Vector[] = new Array(nr * cols);
    const uvs: number[] = new Array(nr * cols * 2);
    const colors: number[] = new Array(nr * cols * 4);
    const loud: number[] = new Array(nr * cols);
    const rows = this.rows;
    for (let i = 0; i < nr; i++) {
      const o = (list[i] % CAP) * STRIDE;
      const iPrev = i > 0 ? i - 1 : i;
      const iNext = i < nr - 1 ? i + 1 : i;
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        const b = idx * 3;
        const jp = Math.max(0, j - 1), jn = Math.min(cols - 1, j + 1);
        const ab = (i * cols + jn) * 3, aa = (i * cols + jp) * 3;
        const sx = pos[ab] - pos[aa], sy = pos[ab + 1] - pos[aa + 1], sz = pos[ab + 2] - pos[aa + 2];
        const tb = (iNext * cols + j) * 3, ta = (iPrev * cols + j) * 3;
        let tx = pos[tb] - pos[ta], ty = pos[tb + 1] - pos[ta + 1], tz = pos[tb + 2] - pos[ta + 2];
        if (tx === 0 && ty === 0 && tz === 0) { tx = 0; ty = 0; tz = 1e-4; }
        let nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        verts[idx] = p.createVector(pos[b], pos[b + 1], pos[b + 2]);
        norms[idx] = p.createVector(nx, ny, nz);
        uvs[idx * 2] = j / (cols - 1);
        uvs[idx * 2 + 1] = list[i];
        colors[idx * 4] = rows[o + TREBLE];
        colors[idx * 4 + 1] = rows[o + ONSET];
        colors[idx * 4 + 2] = rows[o + CENTROID];
        colors[idx * 4 + 3] = rows[o + HIGHMID];
        loud[idx] = rows[o + RMS];
      }
    }
    const faces: number[][] = [];
    for (let i = 0; i < nr - 1; i++) {
      for (let j = 0; j < cols - 1; j++) {
        const a = i * cols + j, b2 = a + 1, c2 = a + cols, d = c2 + 1;
        faces.push([a, b2, c2], [b2, d, c2]);
      }
    }
    geom.vertices = verts;
    geom.vertexNormals = norms;
    geom.uvs = uvs;
    (geom as unknown as { vertexColors: number[] }).vertexColors = colors;
    geom.faces = faces as unknown as typeof geom.faces;
    geom.vertexProperty('aLoud', loud, 1);
    c.geom = geom;
  }

  /** Position of the membrane at row record `o`, across-parameter s in [0,1]. */
  private shellPoint(o: number, s: number, prm: BuildParams, out: Float32Array, oi: number) {
    const r = this.rows;
    const theta = r[o + THETA];
    const bass = r[o + BASS];
    const lowMid = r[o + LOWMID];
    const treble = r[o + TREBLE];
    const onset = r[o + ONSET];
    const phase = r[o + PHASE];
    const tension = prm.tension;

    const u = s * 2 - 1;
    const width = 0.82 + 0.42 * lowMid;
    const bend = tension * (0.25 + 0.75 * bass) * 0.34 * r[o + BEND] * Math.sin(Math.PI * s);
    const along = u * 1.5 * width + r[o + SHIFT] + bend * 0.5;

    // Shell: tight at one end, opening towards the other.
    const grow = 0.2 + 0.95 * Math.pow(s, 1.35);
    let radius = 0.62 * grow * (1 + tension * (0.75 * bass - 0.15));
    radius += (0.03 + 0.17 * lowMid) * Math.sin(s * r[o + FOLDF] * Math.PI + phase) * (0.3 + 0.7 * s);
    const ds = (s - r[o + SEAM]) / 0.05;
    radius += prm.onsetGain * onset * 0.09 * Math.exp(-ds * ds);
    radius += prm.detail * (0.15 + treble) * 0.02 * Math.sin(s * (30 + 26 * prm.detail) + phase * 3 + theta * 9);
    radius = Math.max(0.04, radius);

    const phi = theta + 0.55 * u * this.twistSign;

    // Growth axis, gently re-oriented by sustained spectral change.
    const ta = r[o + TILT_A], tb = r[o + TILT_B];
    const ca = Math.cos(ta), sa = Math.sin(ta), cb = Math.cos(tb), sb = Math.sin(tb);
    const ax = ca * cb, ay = sa, az = ca * sb;
    // N1 = normalize(up - (up·A)A), up = (0,1,0)
    let n1x = -ay * ax, n1y = 1 - ay * ay, n1z = -ay * az;
    const l1 = Math.hypot(n1x, n1y, n1z) || 1;
    n1x /= l1; n1y /= l1; n1z /= l1;
    // N2 = A × N1
    const n2x = ay * n1z - az * n1y, n2y = az * n1x - ax * n1z, n2z = ax * n1y - ay * n1x;

    const cp = Math.cos(phi) * radius, sp = Math.sin(phi) * radius;
    out[oi] = ax * along + cp * n1x + sp * n2x + n2x * bend;
    out[oi + 1] = ay * along + cp * n1y + sp * n2y + n2y * bend;
    out[oi + 2] = az * along + cp * n1z + sp * n2z + n2z * bend;
  }
}
