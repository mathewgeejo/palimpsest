import type { AudioFeatures } from '../types';

const SAMPLE_RATE = 48000;
const WINDOW = 2048;
/** Chord voicings as frequency ratios over the root; cycled every few bars. */
const CHORDS = [
  [1, 5 / 4, 3 / 2, 2],
  [1, 6 / 5, 3 / 2, 9 / 4],
  [1, 4 / 3, 5 / 3, 2],
  [1, 3 / 2, 2, 5 / 2],
];
const ROOTS = [110, 98, 82.4, 92.5];

/**
 * Imaginary music for the gallery when nothing is playing: a slow pulse with
 * swelling phrases, drifting timbre and a chord progression. It feeds the same
 * features (and a synthetic waveform) as the real analyser so every room can
 * be previewed live behind the landing page. It makes no sound.
 */
export class IdleMusic {
  t = 0;
  readonly wave = new Float32Array(WINDOW);
  private readonly phase = new Float64Array(4);

  reset() {
    this.t = 0;
    this.phase.fill(0);
  }

  step(out: AudioFeatures, dt: number) {
    const t = (this.t += dt);
    const beat = t * 1.75;
    const b = beat % 1;
    const bar = Math.floor(beat) % 4;
    const phrase = 0.5 + 0.5 * Math.sin(t * 0.11);
    const kick = Math.exp(-b * 6);
    const gate = bar === 0 || bar === 2 || phrase > 0.6;

    out.rms = 0.32 + 0.33 * phrase + 0.15 * kick;
    out.bass = 0.2 + 0.65 * kick * (bar === 3 ? 0.4 : 1);
    out.lowMid = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(t * 0.37));
    out.highMid = 0.22 + 0.45 * phrase * (0.5 + 0.5 * Math.sin(t * 0.9 + 1));
    out.treble = 0.08 + 0.55 * Math.max(0, Math.sin(t * 0.23)) ** 2 * (0.5 + 0.5 * Math.sin(beat * Math.PI * 4));
    out.onset = gate ? Math.exp(-b * 4) : 0;
    out.centroid = 0.45 + 0.3 * Math.sin(t * 0.043) + 0.1 * Math.sin(t * 0.13);
    out.change = 0.25 + 0.2 * Math.sin(t * 0.07);
    out.silent = false;

    const section = Math.floor(t / 9.1) % CHORDS.length;
    const chord = CHORDS[section]!;
    const root = ROOTS[section]!;
    const amps = [0.5, 0.3 + 0.2 * phrase, 0.22, 0.1 + 0.15 * out.highMid];
    const level = 0.25 + 0.2 * out.rms;
    for (let k = 0; k < 4; k++) {
      const w = (2 * Math.PI * root * chord[k]!) / SAMPLE_RATE;
      let ph = this.phase[k]!;
      for (let i = 0; i < WINDOW; i++) {
        this.wave[i] = (k === 0 ? 0 : this.wave[i]!) + Math.sin(ph + w * i) * amps[k]! * level;
      }
      ph += 2 * Math.PI * root * chord[k]! * dt;
      this.phase[k] = ph % (2 * Math.PI);
    }
  }
}
