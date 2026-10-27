import type { AudioFeatures, FeatureSource, TrackInfo } from '../types';
import { renderDemo } from './demo';

type EngineEvents = {
  trackchange: TrackInfo;
  play: void;
  pause: void;
  seek: number;
  restart: void;
  ended: void;
  error: string;
  timeupdate: number;
};

type EngineEvent = keyof EngineEvents;
type EventCallback<K extends EngineEvent> = (value: EngineEvents[K]) => void;

const FFT_SIZE = 2048;
const CHANGE_TAU = 4;
const PEAK_HALF_LIFE = 10;
const LOG_CENTROID_MIN = Math.log2(100);
const LOG_CENTROID_RANGE = Math.log2(8000) - LOG_CENTROID_MIN;
const DEMO_SEED = 0x50414c49;

// Floors keep the adaptive peak normaliser from lifting room tone into visible energy.
const FEATURE_LIMITS = {
  rms: { floor: 0.002, minPeak: 0.06, attack: 0.04, release: 0.4 },
  bass: { floor: 0.0008, minPeak: 0.025, attack: 0.03, release: 0.25 },
  lowMid: { floor: 0.00055, minPeak: 0.018, attack: 0.03, release: 0.25 },
  highMid: { floor: 0.00028, minPeak: 0.012, attack: 0.03, release: 0.25 },
  treble: { floor: 0.00008, minPeak: 0.001, attack: 0.03, release: 0.25 },
  onset: { floor: 0.008, minPeak: 0.16, attack: 0.01, release: 0.18 },
} as const;

const FEATURE_SETTINGS = [
  FEATURE_LIMITS.rms,
  FEATURE_LIMITS.bass,
  FEATURE_LIMITS.lowMid,
  FEATURE_LIMITS.highMid,
  FEATURE_LIMITS.treble,
  FEATURE_LIMITS.onset,
] as const;

const SMOOTH_CENTROID_SECONDS = 0.6;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function smooth(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
  return current + (target - current) * alpha;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export class AudioEngine implements FeatureSource {
  readonly element: HTMLAudioElement;

  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private objectUrl: string | null = null;
  private currentTrack: TrackInfo | null = null;
  private volume = 0.8;
  private loading = false;
  private seeking = false;
  private active = false;
  private loadGeneration = 0;
  private readonly listeners = new Map<EngineEvent, Set<(value: never) => void>>();
  private readonly frequencyData = new Float32Array(FFT_SIZE / 2);
  private readonly timeData = new Float32Array(FFT_SIZE);
  private readonly magnitudes = new Float32Array(FFT_SIZE / 2);
  private readonly previousMagnitudes = new Float32Array(FFT_SIZE / 2);
  private readonly emaSpectrum = new Float32Array(FFT_SIZE / 2);
  private readonly featureValues = new Float32Array(6);
  private readonly featurePeaks = new Float32Array([
    FEATURE_LIMITS.rms.minPeak,
    FEATURE_LIMITS.bass.minPeak,
    FEATURE_LIMITS.lowMid.minPeak,
    FEATURE_LIMITS.highMid.minPeak,
    FEATURE_LIMITS.treble.minPeak,
    FEATURE_LIMITS.onset.minPeak,
  ]);
  private centroidValue = 0.5;
  private changeValue = 0;
  private warmupElapsed = 0;
  private firstSpectrum = true;

  constructor() {
    this.element = new Audio();
    this.element.preload = 'metadata';
    this.element.addEventListener('playing', () => {
      this.active = true;
      this.emit('play', undefined);
    });
    this.element.addEventListener('pause', () => {
      this.active = false;
      this.emit('pause', undefined);
    });
    this.element.addEventListener('waiting', () => {
      this.active = false;
    });
    this.element.addEventListener('seeking', () => {
      this.seeking = true;
      this.active = false;
    });
    this.element.addEventListener('seeked', () => {
      this.seeking = false;
      this.active = !this.loading && !this.element.paused && !this.element.ended;
    });
    this.element.addEventListener('ended', () => {
      this.active = false;
      this.emit('ended', undefined);
    });
    this.element.addEventListener('timeupdate', () => {
      this.emit('timeupdate', this.currentTime);
    });
    this.element.addEventListener('error', () => {
      this.active = false;
      this.loading = false;
      this.emit('error', "This file couldn't be decoded by your browser.");
    });
  }

  get playing(): boolean {
    return this.active && !this.loading && !this.seeking && !this.element.paused && !this.element.ended;
  }

  get currentTime(): number {
    return Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0;
  }

  get duration(): number {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0;
  }

  get ended(): boolean {
    return this.element.ended;
  }

  get track(): TrackInfo | null {
    return this.currentTrack;
  }

  on<K extends EngineEvent>(event: K, callback: EventCallback<K>): () => void {
    let callbacks = this.listeners.get(event);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(event, callbacks);
    }
    callbacks.add(callback as (value: never) => void);
    return () => callbacks?.delete(callback as (value: never) => void);
  }

  async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      const context = new AudioContext();
      const source = context.createMediaElementSource(this.element);
      const analyser = context.createAnalyser();
      const gain = context.createGain();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      analyser.minDecibels = -100;
      analyser.maxDecibels = -10;
      gain.gain.value = this.volume;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(context.destination);
      this.context = context;
      this.analyser = analyser;
      this.gain = gain;
    }
    return this.context;
  }

  async loadFile(file: File): Promise<TrackInfo> {
    const generation = this.beginReplacement();
    const url = URL.createObjectURL(file);
    const title = file.name.replace(/\.[^.]+$/, '') || file.name;
    return this.loadUrl(url, title, fnv1a(`${file.name}|${file.size}|${file.lastModified}`), generation);
  }

  async loadDemo(): Promise<TrackInfo> {
    const generation = this.beginReplacement();
    try {
      const context = await this.ensureContext();
      if (context.state !== 'running') {
        await context.resume();
      }
    } catch (error) {
      if (generation === this.loadGeneration) {
        this.loading = false;
      }
      throw error;
    }
    let blob: Blob;
    try {
      blob = await renderDemo();
    } catch {
      if (generation !== this.loadGeneration) {
        throw new Error('Track load was superseded.');
      }
      this.loading = false;
      const message = 'The demo could not be generated by your browser.';
      this.emit('error', message);
      throw new Error(message);
    }
    const url = URL.createObjectURL(blob);
    if (generation !== this.loadGeneration) {
      URL.revokeObjectURL(url);
      throw new Error('Track load was superseded.');
    }
    return this.loadUrl(url, 'Demo — Palimpsest Study', DEMO_SEED, generation);
  }

  async play(): Promise<void> {
    if (!this.currentTrack || this.loading) {
      return;
    }
    const context = await this.ensureContext();
    if (context.state !== 'running') {
      await context.resume();
    }
    await this.element.play();
  }

  pause(): void {
    this.element.pause();
  }

  async togglePlay(): Promise<void> {
    if (this.playing) {
      this.pause();
    } else {
      await this.play();
    }
  }

  seek(seconds: number): void {
    if (!this.currentTrack) {
      return;
    }
    const end = this.duration || Number.MAX_SAFE_INTEGER;
    this.element.currentTime = Math.max(0, Math.min(end, seconds));
    this.resetAnalysis();
    this.emit('seek', this.currentTime);
  }

  restart(): void {
    if (!this.currentTrack) {
      return;
    }
    if (this.currentTime > 0) {
      this.element.currentTime = 0;
    }
    this.emit('restart', undefined);
    this.resetAnalysis();
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) {
      this.gain.gain.setTargetAtTime(this.volume, this.gain.context.currentTime, 0.015);
    }
  }

  resetAnalysis(): void {
    this.frequencyData.fill(-100);
    this.timeData.fill(0);
    this.magnitudes.fill(0);
    this.previousMagnitudes.fill(0);
    this.emaSpectrum.fill(0);
    this.featureValues.fill(0);
    this.featurePeaks[0] = FEATURE_LIMITS.rms.minPeak;
    this.featurePeaks[1] = FEATURE_LIMITS.bass.minPeak;
    this.featurePeaks[2] = FEATURE_LIMITS.lowMid.minPeak;
    this.featurePeaks[3] = FEATURE_LIMITS.highMid.minPeak;
    this.featurePeaks[4] = FEATURE_LIMITS.treble.minPeak;
    this.featurePeaks[5] = FEATURE_LIMITS.onset.minPeak;
    this.centroidValue = 0.5;
    this.changeValue = 0;
    this.warmupElapsed = 0;
    this.firstSpectrum = true;
  }

  analyse(out: AudioFeatures, dt: number): void {
    const frameDt = Math.max(0, Math.min(0.1, dt));
    const decayFactor = Math.exp((-Math.LN2 * frameDt) / PEAK_HALF_LIFE);
    for (let index = 0; index < this.featurePeaks.length; index += 1) {
      this.featurePeaks[index] = Math.max(this.minimumPeak(index), this.featurePeaks[index]! * decayFactor);
    }
    if (!this.playing || !this.analyser || !this.context) {
      this.decayFeatures(out, frameDt);
      return;
    }

    this.analyser.getFloatFrequencyData(this.frequencyData);
    this.analyser.getFloatTimeDomainData(this.timeData);
    let squared = 0;
    for (let index = 0; index < this.timeData.length; index += 1) {
      const sample = this.timeData[index]!;
      squared += sample * sample;
    }
    const rms = Math.sqrt(squared / this.timeData.length);

    let magnitudeSum = 0;
    let weightedFrequency = 0;
    let positiveFlux = 0;
    for (let index = 0; index < this.magnitudes.length; index += 1) {
      const db = this.frequencyData[index]!;
      const magnitude = Number.isFinite(db) ? 10 ** (db / 20) : 0;
      this.magnitudes[index] = magnitude;
      magnitudeSum += magnitude;
      weightedFrequency += magnitude * index * (this.context.sampleRate / FFT_SIZE);
      if (!this.firstSpectrum) {
        const difference = magnitude - this.previousMagnitudes[index]!;
        if (difference > 0) {
          positiveFlux += difference;
        }
      }
    }

    const nyquist = this.context.sampleRate / 2;
    const binHz = this.context.sampleRate / FFT_SIZE;
    const bass = this.bandMean(20, 150, binHz, nyquist);
    const lowMid = this.bandMean(150, 600, binHz, nyquist);
    const highMid = this.bandMean(600, 4000, binHz, nyquist);
    const treble = this.bandMean(4000, Math.min(16_000, nyquist), binHz, nyquist);
    const silent = rms < 0.003;
    const centroidHz = magnitudeSum > 0 ? weightedFrequency / magnitudeSum : 0;
    const centroidTarget = centroidHz > 0
      ? clamp01((Math.log2(centroidHz) - LOG_CENTROID_MIN) / LOG_CENTROID_RANGE)
      : this.centroidValue;
    const onset = this.firstSpectrum || magnitudeSum === 0 ? 0 : positiveFlux / Math.max(magnitudeSum, 0.02);

    const tauAlpha = 1 - Math.exp(-frameDt / CHANGE_TAU);
    let spectrumDot = 0;
    let currentNorm = 0;
    let emaNorm = 0;
    for (let index = 0; index < this.magnitudes.length; index += 1) {
      const magnitude = this.magnitudes[index]!;
      const previous = this.emaSpectrum[index]!;
      spectrumDot += magnitude * previous;
      currentNorm += magnitude * magnitude;
      emaNorm += previous * previous;
      this.emaSpectrum[index] = previous + (magnitude - previous) * tauAlpha;
    }
    const similarity = currentNorm > 0 && emaNorm > 0
      ? spectrumDot / Math.sqrt(currentNorm * emaNorm)
      : 1;
    const changeTarget = silent ? 0 : clamp01(1 - similarity);
    this.changeValue = smooth(this.changeValue, changeTarget, frameDt, 1.5, 3);

    this.updateFeature(0, silent ? 0 : rms, frameDt);
    this.updateFeature(1, silent ? 0 : bass, frameDt);
    this.updateFeature(2, silent ? 0 : lowMid, frameDt);
    this.updateFeature(3, silent ? 0 : highMid, frameDt);
    this.updateFeature(4, silent ? 0 : treble, frameDt);
    this.updateFeature(5, silent ? 0 : onset, frameDt);
    if (!silent) {
      this.centroidValue = smooth(
        this.centroidValue,
        centroidTarget,
        frameDt,
        SMOOTH_CENTROID_SECONDS,
        SMOOTH_CENTROID_SECONDS,
      );
    }
    this.warmupElapsed = Math.min(0.4, this.warmupElapsed + frameDt);
    const warmup = this.warmupElapsed / 0.4;
    out.rms = this.featureValues[0]! * warmup;
    out.bass = this.featureValues[1]! * warmup;
    out.lowMid = this.featureValues[2]! * warmup;
    out.highMid = this.featureValues[3]! * warmup;
    out.treble = this.featureValues[4]! * warmup;
    out.onset = this.featureValues[5]! * warmup;
    out.centroid = this.centroidValue;
    out.change = this.changeValue * warmup;
    out.silent = silent;

    this.previousMagnitudes.set(this.magnitudes);
    this.firstSpectrum = false;
  }

  private async loadUrl(url: string, title: string, seed: number, generation: number): Promise<TrackInfo> {
    this.objectUrl = url;
    try {
      const context = await this.ensureContext();
      if (context.state !== 'running') {
        await context.resume();
      }
    } catch (error) {
      if (generation === this.loadGeneration) {
        this.loading = false;
        URL.revokeObjectURL(url);
        this.objectUrl = null;
      }
      throw error;
    }
    if (generation !== this.loadGeneration) {
      URL.revokeObjectURL(url);
      throw new Error('Track load was superseded.');
    }
    return new Promise<TrackInfo>((resolve, reject) => {
      const cleanup = (): void => {
        this.element.removeEventListener('loadedmetadata', onMetadata);
        this.element.removeEventListener('error', onError);
      };
      const onMetadata = (): void => {
        cleanup();
        if (generation !== this.loadGeneration) {
          reject(new Error('Track load was superseded.'));
          return;
        }
        this.loading = false;
        const track = { title, duration: this.duration, seed };
        this.currentTrack = track;
        this.resetAnalysis();
        this.emit('trackchange', track);
        resolve(track);
      };
      const onError = (): void => {
        cleanup();
        if (generation !== this.loadGeneration) {
          reject(new Error('Track load was superseded.'));
          return;
        }
        this.loading = false;
        this.currentTrack = null;
        const message = "This file couldn't be decoded by your browser.";
        this.emit('error', message);
        reject(new Error(message));
      };
      this.element.addEventListener('loadedmetadata', onMetadata, { once: true });
      this.element.addEventListener('error', onError, { once: true });
      this.element.src = url;
      this.element.load();
    });
  }

  private beginReplacement(): number {
    const generation = ++this.loadGeneration;
    this.element.pause();
    this.active = false;
    this.loading = true;
    this.seeking = false;
    this.element.removeAttribute('src');
    this.element.load();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = null;
    this.currentTrack = null;
    this.resetAnalysis();
    return generation;
  }

  private bandMean(lowHz: number, highHz: number, binHz: number, nyquist: number): number {
    if (lowHz >= nyquist || highHz <= lowHz) {
      return 0;
    }
    const first = Math.max(0, Math.ceil(lowHz / binHz));
    const last = Math.min(this.magnitudes.length - 1, Math.floor(Math.min(highHz, nyquist) / binHz));
    if (last < first) {
      return 0;
    }
    let total = 0;
    for (let index = first; index <= last; index += 1) {
      total += this.magnitudes[index]!;
    }
    return total / (last - first + 1);
  }

  private minimumPeak(index: number): number {
    switch (index) {
      case 0: return FEATURE_LIMITS.rms.minPeak;
      case 1: return FEATURE_LIMITS.bass.minPeak;
      case 2: return FEATURE_LIMITS.lowMid.minPeak;
      case 3: return FEATURE_LIMITS.highMid.minPeak;
      case 4: return FEATURE_LIMITS.treble.minPeak;
      default: return FEATURE_LIMITS.onset.minPeak;
    }
  }

  private updateFeature(index: number, value: number, dt: number): void {
    const limit = FEATURE_SETTINGS[index]!;
    if (value > this.featurePeaks[index]!) {
      this.featurePeaks[index] = value;
    }
    const denominator = Math.max(this.featurePeaks[index]! - limit.floor, 0.000001);
    const target = clamp01((value - limit.floor) / denominator);
    this.featureValues[index] = smooth(
      this.featureValues[index]!,
      target,
      dt,
      limit.attack,
      limit.release,
    );
  }

  private decayFeatures(out: AudioFeatures, dt: number): void {
    this.featureValues[0] = smooth(this.featureValues[0]!, 0, dt, 0.04, FEATURE_LIMITS.rms.release);
    this.featureValues[1] = smooth(this.featureValues[1]!, 0, dt, 0.03, FEATURE_LIMITS.bass.release);
    this.featureValues[2] = smooth(this.featureValues[2]!, 0, dt, 0.03, FEATURE_LIMITS.lowMid.release);
    this.featureValues[3] = smooth(this.featureValues[3]!, 0, dt, 0.03, FEATURE_LIMITS.highMid.release);
    this.featureValues[4] = smooth(this.featureValues[4]!, 0, dt, 0.03, FEATURE_LIMITS.treble.release);
    this.featureValues[5] = smooth(this.featureValues[5]!, 0, dt, 0.01, FEATURE_LIMITS.onset.release);
    this.changeValue = smooth(this.changeValue, 0, dt, 1.5, 3);
    out.rms = this.featureValues[0]!;
    out.bass = this.featureValues[1]!;
    out.lowMid = this.featureValues[2]!;
    out.highMid = this.featureValues[3]!;
    out.treble = this.featureValues[4]!;
    out.centroid = this.centroidValue;
    out.onset = this.featureValues[5]!;
    out.change = this.changeValue;
    out.silent = true;
  }

  private emit<K extends EngineEvent>(event: K, value: EngineEvents[K]): void {
    const callbacks = this.listeners.get(event);
    if (!callbacks) {
      return;
    }
    for (const callback of callbacks) {
      (callback as EventCallback<K>)(value);
    }
  }
}
