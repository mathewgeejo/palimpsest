/** Normalised, smoothed audio features. All values are in [0, 1] unless noted. */
export interface AudioFeatures {
  rms: number;
  bass: number;
  lowMid: number;
  highMid: number;
  treble: number;
  /** Log-scaled spectral centroid, 0 = ~100 Hz, 1 = ~8 kHz. */
  centroid: number;
  /** Onset strength from half-wave rectified spectral flux. */
  onset: number;
  /** Slowly evolving spectral change (distance from long-term spectrum). */
  change: number;
  /** True when the signal is below the silence gate. */
  silent: boolean;
}

/** What the visualiser reads every frame. Implemented by AudioEngine. */
export interface FeatureSource {
  /** True while audio is actually advancing (not paused, not ended, not loading). */
  readonly playing: boolean;
  /** Current playback position in seconds (media time). */
  readonly currentTime: number;
  /** Analyse the current audio and write into `out` (no allocation). dt in seconds of wall time. */
  analyse(out: AudioFeatures, dt: number): void;
}

export type CameraMode = 'still' | 'drift';
export type Quality = 'low' | 'medium' | 'high';

export interface VisualSettings {
  /** 0..1, fraction of the maximum history length that is visible. */
  memory: number;
  /** 0..1, strength of large deformations. */
  tension: number;
  /** 0..1, density of contours and fine structure. */
  detail: number;
  camera: CameraMode;
  quality: Quality;
  reducedMotion: boolean;
}

export interface TrackInfo {
  title: string;
  duration: number;
  /** Stable 32-bit seed derived from the track. */
  seed: number;
}

export function createEmptyFeatures(): AudioFeatures {
  return { rms: 0, bass: 0, lowMid: 0, highMid: 0, treble: 0, centroid: 0.5, onset: 0, change: 0, silent: true };
}

declare module 'p5' {
  namespace p5 {
    interface Geometry {
      vertexColors: number[];
    }
  }
}
