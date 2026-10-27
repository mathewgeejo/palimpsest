import p5 from 'p5';
import type { AudioFeatures, FeatureSource, Quality, VisualSettings } from '../types';
import { createEmptyFeatures } from '../types';
import { Membrane, MAX_ROWS, MIN_VISIBLE_ROWS, ROW_RATE } from './membrane';
import { membraneFrag, membraneVert, postFrag, postVert } from './shaders';

export interface Visualiser {
  /** Clear all history and start a new sculpture with this seed (restart / seek / track change). */
  reset(seed: number): void;
  setSettings(settings: Partial<VisualSettings>): void;
  /** Capture the current rendered frame as a PNG blob. */
  exportPNG(): Promise<Blob>;
  destroy(): void;
}

export interface VisualiserOptions {
  container: HTMLElement;
  source: FeatureSource;
  settings: VisualSettings;
  /** Called with a human-readable message if WebGL / shaders fail. */
  onError(message: string): void;
  /** Called ~8 times per second from the render loop (use for DOM updates like the seek bar). */
  onTick?(): void;
}

interface QualityProfile {
  maxDensity: number;
  /** Scene render resolution relative to the canvas. */
  sceneScale: number;
  glowTaps: number;
  rebuildBudget: number;
}

const QUALITY: Record<Quality, QualityProfile> = {
  low: { maxDensity: 1, sceneScale: 0.7, glowTaps: 0, rebuildBudget: 3 },
  medium: { maxDensity: 1.5, sceneScale: 1, glowTaps: 6, rebuildBudget: 4 },
  high: { maxDensity: 2, sceneScale: 1, glowTaps: 12, rebuildBudget: 6 },
};

/** A gap in audio time larger than this (e.g. a background tab) is skipped, not back-filled. */
const MAX_FRAME_GAP = 0.35;
const FOV = Math.PI / 5;

function approach(cur: number, target: number, dt: number, tau: number) {
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

export interface VisualStats {
  fps: number;
  visibleRows: number;
  frameRadius: number;
  frameMs: number;
  rows: number;
  chunks: number;
  vertices: number;
  quality: Quality;
  canvas: [number, number];
  scene: [number, number];
}

export async function createVisualiser(opts: VisualiserOptions): Promise<Visualiser> {
  const { container, source } = opts;
  const settings: VisualSettings = { ...opts.settings };

  return new Promise<Visualiser>((resolve, reject) => {
    let membrane: Membrane;
    let memShader: p5.Shader;
    let postShader: p5.Shader;
    let scene: p5.Framebuffer;
    let failed = false;

    const features: AudioFeatures = createEmptyFeatures();
    let seed = 1;
    let lastWall = 0;
    let lastAudioT = -1;
    let nextRowT = 0;
    let lastRowT = 0;
    let headFrac = 0;
    let viewTheta = 0;
    const fit = new Float32Array(4);
    const view = { x: 0, y: 0, z: 0, r: 1.5 };
    let snapView = true;
    let quiet = 0;
    let slowRms = 0;
    let liveBass = 0;
    let driftT = 0;
    let tickAcc = 0;
    let invalidateAt = 0;
    let exportResolvers: { resolve: (b: Blob) => void; reject: (e: Error) => void }[] = [];
    const stats: VisualStats = {
      fps: 0, frameMs: 0, rows: 0, chunks: 0, vertices: 0, quality: settings.quality, canvas: [0, 0], scene: [0, 0],
      visibleRows: 0, frameRadius: 0,
    };

    const fail = (msg: string, err?: unknown) => {
      if (failed) return;
      failed = true;
      console.error(msg, err);
      opts.onError(msg);
    };

    const sizeOf = () => {
      const r = container.getBoundingClientRect();
      return [Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height))] as const;
    };

    const buildParams = () => ({
      tension: settings.tension,
      detail: settings.detail,
      onsetGain: settings.reducedMotion ? 0.4 : 1,
      quality: settings.quality,
    });

    const sketch = (p: p5) => {
      const configureQuality = () => {
        const q = QUALITY[settings.quality];
        const density = Math.min(window.devicePixelRatio || 1, q.maxDensity);
        p.pixelDensity(density);
        if (scene) scene.remove();
        scene = p.createFramebuffer({ depth: false, antialias: false, density: density * q.sceneScale });
        // An explicit density opts the buffer out of p5's auto-sizing, so resizes are handled below.
        scene.pixelDensity(density * q.sceneScale);
        stats.quality = settings.quality;
        membrane?.invalidate();
      };

      p.setup = () => {
        try {
          const [w, h] = sizeOf();
          p.createCanvas(w, h, p.WEBGL);
          if (!p.drawingContext) throw new Error('no context');
          if ((p as unknown as { webglVersion: string }).webglVersion !== 'webgl2') {
            throw new Error('WebGL2 unavailable');
          }
        } catch (e) {
          fail('WebGL 2 is not available in this browser, so the sculpture cannot be drawn.', e);
          p.noLoop();
          reject(e);
          return;
        }
        p.setAttributes?.('alpha', false);
        try {
          memShader = p.createShader(membraneVert, membraneFrag);
          postShader = p.createShader(postVert, postFrag);
        } catch (e) {
          fail('The visualiser shaders failed to compile on this device.', e);
          p.noLoop();
          reject(e);
          return;
        }
        const canvas = (p as unknown as { canvas: HTMLCanvasElement }).canvas;
        canvas.addEventListener('webglcontextlost', (ev) => {
          ev.preventDefault();
          fail('The graphics context was lost. Reload the page to continue.');
        });
        canvas.setAttribute('aria-label', 'PALIMPSEST sculpture');
        canvas.setAttribute('role', 'img');
        membrane = new Membrane(p, seed);
        configureQuality();
        lastWall = performance.now();
        resolve(api);
      };

      p.windowResized = () => {
        const [w, h] = sizeOf();
        if (w !== p.width || h !== p.height) {
          p.resizeCanvas(w, h);
          scene?.resize(w, h);
        }
      };

      p.draw = () => {
        if (failed) return;
        const now = performance.now();
        const dt = Math.min(0.1, Math.max(0.0005, (now - lastWall) / 1000));
        lastWall = now;
        stats.frameMs = stats.frameMs * 0.95 + dt * 1000 * 0.05;
        stats.fps = 1000 / stats.frameMs;

        try {
          frame(p, dt);
        } catch (e) {
          fail('The visualiser hit an unexpected error.', e);
          return;
        }

        if (exportResolvers.length) {
          const pending = exportResolvers;
          exportResolvers = [];
          const canvas = (p as unknown as { canvas: HTMLCanvasElement }).canvas;
          canvas.toBlob((b) => {
            for (const r of pending) b ? r.resolve(b) : r.reject(new Error('Export failed'));
          }, 'image/png');
        }

        tickAcc += dt;
        if (tickAcc >= 0.125) {
          tickAcc = 0;
          opts.onTick?.();
        }
      };

      const frame = (p: p5, dt: number) => {
        // --- audio → history (driven by playback time, not frame count) ---
        source.analyse(features, dt);
        const playing = source.playing;
        const t = source.currentTime;
        if (playing) {
          if (lastAudioT < 0 || t < lastAudioT || t - lastAudioT > MAX_FRAME_GAP) {
            // Start, seek-without-reset or a resumed background tab: continue from here
            // rather than inventing samples for audio we never analysed.
            nextRowT = t;
            lastRowT = t;
          }
          lastAudioT = t;
          let emitted = 0;
          while (t >= nextRowT && emitted < 4) {
            membrane.emit(features, 1 / ROW_RATE, nextRowT);
            lastRowT = nextRowT;
            nextRowT += 1 / ROW_RATE;
            emitted++;
          }
          if (t - nextRowT > 1 / ROW_RATE) nextRowT = t;
          headFrac = Math.min(1, Math.max(0, (t - lastRowT) * ROW_RATE));
          slowRms = approach(slowRms, features.silent ? 0 : features.rms, dt, 1.2);
          const quietTarget = membrane.total > ROW_RATE * 4 ? 1 - smooth(0.04, 0.3, slowRms) : 0;
          quiet = approach(quiet, quietTarget, dt, quietTarget > quiet ? 1.8 : 0.9);
          liveBass = approach(liveBass, features.bass, dt, settings.reducedMotion ? 0.5 : 0.09);
        } else {
          // Paused / ended: the sculpture holds still; live flex relaxes.
          lastAudioT = -1;
          liveBass = approach(liveBass, 0, dt, 0.6);
          if (source.currentTime > 0 && membrane.total > ROW_RATE * 4) {
            quiet = approach(quiet, Math.max(quiet, 0.55), dt, 2.5);
          }
        }

        if (invalidateAt && performance.now() >= invalidateAt) {
          invalidateAt = 0;
          membrane.invalidate();
        }
        membrane.update(buildParams(), QUALITY[settings.quality].rebuildBudget);

        const visible = MIN_VISIBLE_ROWS + settings.memory * (MAX_ROWS - MIN_VISIBLE_ROWS);
        const head = membrane.total > 0 ? membrane.total - 1 + headFrac : 0;
        const tailRow = Math.max(membrane.oldest, Math.floor(head - visible));

        // Keep the leading edge at a fixed place in the frame; history trails away from it.
        if (membrane.total > 0) {
          const headN = membrane.total - 1;
          const targetTheta = membrane.rowTheta(headN);
          if (snapView) {
            viewTheta = targetTheta;
          } else {
            viewTheta = approach(viewTheta, targetTheta, dt, settings.reducedMotion ? 1.6 : 0.7);
          }
          // Frame the visible history: centre its bounding sphere and fit its radius.
          if (membrane.bounds(tailRow, fit)) {
            const r = Math.max(1.2, fit[3]);
            if (snapView) {
              view.x = fit[0]; view.y = fit[1]; view.z = fit[2]; view.r = r;
            } else {
              const tc = settings.reducedMotion ? 3 : 1.4;
              view.x = approach(view.x, fit[0], dt, tc);
              view.y = approach(view.y, fit[1], dt, tc);
              view.z = approach(view.z, fit[2], dt, tc);
              view.r = approach(view.r, r, dt, r > view.r ? 0.35 : tc * 1.5);
            }
          }
          snapView = false;
        }
        if (settings.camera === 'drift' && !settings.reducedMotion) driftT += dt;

        // --- render scene into a depth-less framebuffer with additive light ---
        const w = p.width, h = p.height;
        const unit = Math.min(Math.min(w * 0.44, h * 0.47) / view.r, Math.min(w, h * 1.4) * 0.3);
        const camZ = h / 2 / Math.tan(FOV / 2);
        scene.begin();
        p.clear();
        p.perspective(FOV, w / h, camZ * 0.1, camZ * 10);
        p.camera(0, 0, camZ, 0, 0, 0, 0, 1, 0);
        if (membrane.total > 1) {
          p.push();
          p.noStroke();
          p.blendMode(p.ADD);
          if (settings.camera === 'drift' && !settings.reducedMotion) {
            p.rotateY(Math.sin(driftT * 0.045) * 0.2);
            p.rotateX(Math.sin(driftT * 0.031 + 1.3) * 0.07);
          }
          p.translate(w * 0.03, h * 0.02, 0);
          p.rotateZ(-0.52);
          p.rotateY(0.35);
          p.scale(unit);
          p.rotateX(-viewTheta + 2.2);
          p.translate(-view.x, -view.y, -view.z);
          p.shader(memShader);
          memShader.setUniform('uHead', head);
          memShader.setUniform('uVisible', visible);
          memShader.setUniform('uFlex', liveBass * settings.tension * (settings.reducedMotion ? 0.015 : 0.055));
          memShader.setUniform('uDetail', settings.detail);
          memShader.setUniform('uQuiet', quiet);
          memShader.setUniform('uOnsetGain', settings.reducedMotion ? 0.4 : 1);
          memShader.setUniform('uGain', 0.55);
          memShader.setUniform('uFog', [camZ - unit * 0.6, camZ + unit * 1.8]);
          membrane.draw(tailRow);
          p.blendMode(p.BLEND);
          p.pop();
        }
        scene.end();

        // --- composite: tone map, restrained glow, ground, grain ---
        p.clear();
        p.push();
        p.noStroke();
        p.shader(postShader);
        const q = QUALITY[settings.quality];
        postShader.setUniform('uScene', scene);
        postShader.setUniform('uRes', [w, h]);
        postShader.setUniform('uGlow', q.glowTaps > 0 ? 0.55 : 0);
        postShader.setUniform('uGlowTaps', q.glowTaps);
        postShader.setUniform('uExposure', 1.35);
        postShader.setUniform('uGrain', 0.018);
        postShader.setUniform('uSeed', settings.reducedMotion ? 0 : (p.frameCount % 61) * 7.31);
        postShader.setUniform('uFlipY', 0);
        p.plane(1, 1);
        p.pop();

        stats.rows = membrane.total;
        stats.visibleRows = Math.max(0, Math.round(head - tailRow));
        stats.frameRadius = +view.r.toFixed(3);
        stats.chunks = membrane.chunkCount;
        stats.canvas = [w * p.pixelDensity(), h * p.pixelDensity()];
        const sd = (scene as unknown as { pixelDensity(): number }).pixelDensity();
        stats.scene = [Math.round(scene.width * sd), Math.round(scene.height * sd)];
      };

      const smooth = (a: number, b: number, x: number) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };

      (api as { _configureQuality?: () => void })._configureQuality = configureQuality;
    };

    const resizeObserver = new ResizeObserver(() => instance?.windowResized?.(undefined as never));

    const api: Visualiser & { _configureQuality?: () => void } = {
      reset(newSeed: number) {
        seed = newSeed >>> 0;
        membrane?.reset(seed);
        lastAudioT = -1;
        headFrac = 0;
        quiet = 0;
        slowRms = 0;
        liveBass = 0;
        snapView = true;
      },
      setSettings(next: Partial<VisualSettings>) {
        const prev = { ...settings };
        Object.assign(settings, next);
        if (next.quality && next.quality !== prev.quality) api._configureQuality?.();
        if (
          (next.tension !== undefined && next.tension !== prev.tension) ||
          (next.detail !== undefined && next.detail !== prev.detail) ||
          (next.reducedMotion !== undefined && next.reducedMotion !== prev.reducedMotion)
        ) {
          invalidateAt = performance.now() + 120;
        }
      },
      exportPNG() {
        return new Promise<Blob>((resolve, reject) => exportResolvers.push({ resolve, reject }));
      },
      destroy() {
        resizeObserver.disconnect();
        membrane?.reset(0);
        instance.remove();
      },
    };

    const instance = new p5(sketch, container);
    resizeObserver.observe(container);
    (window as unknown as { __palimpsest?: { stats: VisualStats } }).__palimpsest = {
      get stats() {
        stats.vertices = membrane ? membrane.vertexCount() : 0;
        return stats;
      },
    } as { stats: VisualStats };
  });
}
