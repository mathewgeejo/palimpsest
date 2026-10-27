import type { AudioEngine } from '../audio/engine';
import type { CameraMode, Quality, VisualMode, VisualSettings } from '../types';

export interface ControlCallbacks {
  onPlayToggle(): void;
  onTryDemo(): void;
  onChooseFile(): void;
  onFile(file: File): void;
  onSeek(seconds: number): void;
  onRestart(): void;
  onVolume(value: number): void;
  onExport(): void;
  onFullscreen(): void;
  onSettingsChange(settings: Partial<VisualSettings>): void;
}

const icons = {
  play: '<path d="m9 6 10 6-10 6z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 6h3v12H8zM15 6h3v12h-3z" fill="currentColor" stroke="none"/>',
  replay: '<path d="M20 11a8 8 0 0 0-14.9-3M5 4v4h4M4 13a8 8 0 0 0 14.9 3M19 20v-4h-4"/>',
  restart: '<path d="M4 11a8 8 0 1 1 2.35 5.65M4 4v7h7"/>',
  export: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  exitFullscreen: '<path d="M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5"/>',
  settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.8 1.8 0 1 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3.1 1.3v.2a1.8 1.8 0 1 1-3.6 0v-.2a1.8 1.8 0 0 0-3.1-1.3l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-1.3-3.1h-.2a1.8 1.8 0 1 1 0-3.6h.2a1.8 1.8 0 0 0 1.3-3.1l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3.1-1.3v-.2a1.8 1.8 0 1 1 3.6 0v.2a1.8 1.8 0 0 0 3.1 1.3l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 1.3 3.1h.2a1.8 1.8 0 1 1 0 3.6h-.2a1.8 1.8 0 0 0-1.3 3.1Z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
};

function svg(markup: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${markup}</svg>`;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainder}`;
}

const SEEK_HINT_TEXT = 'Seeking clears the memory — the shape regrows from here.';

export class Controls {
  readonly settings: VisualSettings;
  private readonly app: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly welcome: HTMLElement;
  private readonly seek: HTMLInputElement;
  private readonly elapsed: HTMLElement;
  private readonly duration: HTMLElement;
  private readonly trackTitle: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly settingsButton: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly seekHint: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly callbacks: ControlCallbacks;
  private fadeTimer: number | null = null;
  private hintTimer: number | null = null;
  private draggingSeek = false;
  private previousPlaying = false;

  constructor(private readonly engine: AudioEngine, callbacks: ControlCallbacks) {
    this.callbacks = callbacks;
    this.settings = {
      mode: 'membrane',
      memory: 0.6,
      tension: 0.5,
      detail: 0.6,
      camera: 'drift',
      quality: 'medium',
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };

    const root = document.querySelector<HTMLElement>('#app');
    if (!root) {
      throw new Error('The application root is missing.');
    }
    this.app = root;
    this.app.innerHTML = `
      <button class="wordmark" id="wordmark" type="button" aria-label="Open PALIMPSEST choices">PALIMPSEST</button>
      <section class="welcome" id="welcome" aria-labelledby="welcome-title">
        <div class="welcome-content">
          <p class="eyebrow">An instrument for attentive listening</p>
          <h1 id="welcome-title">PALIMPSEST</h1>
          <p class="welcome-line">Your music leaves a shape.</p>
          <div class="welcome-actions">
            <button class="button button-primary" id="try-demo" type="button">Try with sound</button>
            <button class="button button-quiet" id="choose-audio" type="button">Choose audio file</button>
          </div>
          <input class="file-input" id="audio-file" type="file" accept="audio/*" aria-label="Choose an audio file" />
          <p class="welcome-hint">or drop an audio file anywhere <span aria-hidden="true">·</span> audio stays on your device</p>
        </div>
      </section>
      <aside class="settings-drawer" id="settings-drawer" aria-label="Visual settings" aria-hidden="true">
        <div class="drawer-heading">
          <h2>Settings</h2>
          <button class="icon-button drawer-close" id="close-settings" type="button" aria-label="Close settings" title="Close settings">${svg(icons.close)}</button>
        </div>
        <div class="setting-row select-row">
          <label for="setting-mode">Mode</label>
          <select id="setting-mode">
            <option value="membrane" selected>Membrane — calm</option>
            <option value="rupture">Rupture — loud</option>
            <option value="splat">Splat — Gaussian cloud</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-memory">Memory <output id="memory-value">0.60</output></label>
          <input id="setting-memory" type="range" min="0" max="1" step="0.01" value="0.6" />
        </div>
        <div class="setting-row">
          <label for="setting-tension">Tension <output id="tension-value">0.50</output></label>
          <input id="setting-tension" type="range" min="0" max="1" step="0.01" value="0.5" />
        </div>
        <div class="setting-row">
          <label for="setting-detail">Detail <output id="detail-value">0.60</output></label>
          <input id="setting-detail" type="range" min="0" max="1" step="0.01" value="0.6" />
        </div>
        <div class="setting-row select-row">
          <label for="setting-camera">Camera</label>
          <select id="setting-camera">
            <option value="still">Still</option>
            <option value="drift" selected>Gentle drift</option>
          </select>
        </div>
        <div class="setting-row select-row">
          <label for="setting-quality">Quality</label>
          <select id="setting-quality">
            <option value="low">Low</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <label class="motion-row" for="setting-reduced-motion">
          <span>Reduced motion</span>
          <input id="setting-reduced-motion" type="checkbox" ${this.settings.reducedMotion ? 'checked' : ''} />
        </label>
      </aside>
      <div class="toast-area" id="toast-area" aria-live="polite" aria-atomic="true">
        <div class="toast" id="toast" role="alert" hidden>
          <span id="toast-message"></span>
          <button class="toast-dismiss" id="dismiss-toast" type="button" aria-label="Dismiss message">${svg(icons.close)}</button>
        </div>
      </div>
      <footer class="control-bar" id="control-bar" aria-label="Playback controls">
        <p class="seek-hint" id="seek-hint" aria-live="polite">Seeking clears the memory — the shape regrows from here.</p>
        <div class="playback-row">
          <div class="transport">
            <button class="icon-button play-button" id="play-toggle" type="button" aria-label="Play" title="Play">${svg(icons.play)}</button>
            <button class="icon-button restart-button" id="restart" type="button" aria-label="Restart from beginning" title="Restart from beginning">${svg(icons.restart)}</button>
          </div>
          <div class="timeline">
            <div class="seek-line">
              <span class="time-readout" id="elapsed">0:00</span>
              <input class="seek-range" id="seek-range" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek through track" />
              <span class="time-readout" id="duration">0:00</span>
            </div>
            <div class="track-title" id="track-title" title="No track loaded">No track loaded</div>
          </div>
          <div class="utility-controls">
            <label class="volume-control" for="volume-range">
              <span class="sr-only">Volume</span>
              <span class="volume-icon" aria-hidden="true">${svg('<path d="M4 10v4h3l4 3V7l-4 3H4Z"/><path d="M15 9a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"/>')}</span>
              <input id="volume-range" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Volume" />
            </label>
            <button class="icon-button" id="export-png" type="button" aria-label="Export PNG" title="Export PNG">${svg(icons.export)}</button>
            <button class="icon-button" id="fullscreen" type="button" aria-label="Enter fullscreen" title="Enter fullscreen">${svg(icons.fullscreen)}</button>
            <button class="icon-button settings-button" id="toggle-settings" type="button" aria-label="Open settings" title="Settings" aria-expanded="false">${svg(icons.settings)}</button>
          </div>
        </div>
      </footer>
      <div class="drop-highlight" id="drop-highlight" aria-hidden="true"><span>Release to listen</span></div>
    `;

    this.bar = this.required('#control-bar');
    this.welcome = this.required('#welcome');
    this.seek = this.required<HTMLInputElement>('#seek-range');
    this.elapsed = this.required('#elapsed');
    this.duration = this.required('#duration');
    this.trackTitle = this.required('#track-title');
    this.playButton = this.required<HTMLButtonElement>('#play-toggle');
    this.settingsButton = this.required<HTMLButtonElement>('#toggle-settings');
    this.drawer = this.required('#settings-drawer');
    this.seekHint = this.required('#seek-hint');
    this.toast = this.required('#toast');

    this.required<HTMLButtonElement>('#try-demo').addEventListener('click', () => callbacks.onTryDemo());
    this.required<HTMLButtonElement>('#choose-audio').addEventListener('click', () => callbacks.onChooseFile());
    this.required<HTMLButtonElement>('#wordmark').addEventListener('click', () => this.setWelcomeVisible(true));
    this.required<HTMLInputElement>('#audio-file').addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) {
        callbacks.onFile(file);
      }
      input.value = '';
    });
    this.required<HTMLButtonElement>('#play-toggle').addEventListener('click', () => callbacks.onPlayToggle());
    this.required<HTMLButtonElement>('#restart').addEventListener('click', () => callbacks.onRestart());
    this.required<HTMLInputElement>('#volume-range').addEventListener('input', (event) => {
      callbacks.onVolume(Number((event.currentTarget as HTMLInputElement).value));
    });
    this.seek.addEventListener('pointerdown', () => {
      this.draggingSeek = true;
    });
    this.seek.addEventListener('pointerup', () => {
      this.draggingSeek = false;
    });
    this.seek.addEventListener('input', () => {
      const previewTime = this.engine.duration * (Number(this.seek.value) / 1000);
      this.elapsed.textContent = formatTime(previewTime);
    });
    this.seek.addEventListener('change', () => {
      callbacks.onSeek(this.engine.duration * (Number(this.seek.value) / 1000));
      this.showSeekHint();
    });
    this.required<HTMLButtonElement>('#export-png').addEventListener('click', () => callbacks.onExport());
    this.required<HTMLButtonElement>('#fullscreen').addEventListener('click', () => callbacks.onFullscreen());
    this.settingsButton.addEventListener('click', () => this.toggleDrawer());
    this.required<HTMLButtonElement>('#close-settings').addEventListener('click', () => this.setDrawerOpen(false));
    this.required<HTMLButtonElement>('#dismiss-toast').addEventListener('click', () => this.toast.setAttribute('hidden', ''));

    this.required<HTMLSelectElement>('#setting-mode').addEventListener('change', (event) => {
      this.setMode((event.currentTarget as HTMLSelectElement).value as VisualMode);
    });
    this.bindSettingRange('memory', '#setting-memory');
    this.bindSettingRange('tension', '#setting-tension');
    this.bindSettingRange('detail', '#setting-detail');
    this.required<HTMLSelectElement>('#setting-camera').addEventListener('change', (event) => {
      this.updateSetting('camera', (event.currentTarget as HTMLSelectElement).value as CameraMode);
    });
    this.required<HTMLSelectElement>('#setting-quality').addEventListener('change', (event) => {
      this.updateSetting('quality', (event.currentTarget as HTMLSelectElement).value as Quality);
    });
    this.required<HTMLInputElement>('#setting-reduced-motion').addEventListener('change', (event) => {
      this.updateSetting('reducedMotion', (event.currentTarget as HTMLInputElement).checked);
    });

    this.bindEngineEvents();
    this.bindActivityAndKeyboard();
    this.bindDropHandling();
    document.addEventListener('fullscreenchange', () => this.updateFullscreenButton());
    this.syncModeClass();
  }

  updatePlaybackState(): void {
    const ended = this.engine.ended;
    const playing = this.engine.playing;
    const state = ended ? 'replay' : playing ? 'pause' : 'play';
    const label = ended ? 'Replay' : playing ? 'Pause' : 'Play';
    this.playButton.innerHTML = svg(icons[state]);
    this.playButton.setAttribute('aria-label', label);
    this.playButton.title = label;
    if (playing) {
      if (!this.previousPlaying) {
        this.scheduleFade();
      }
    } else {
      this.clearFadeTimer();
      this.bar.classList.remove('is-dimmed');
    }
    this.previousPlaying = playing;
  }

  updateTime(): void {
    const duration = this.engine.duration;
    this.duration.textContent = formatTime(duration);
    if (!this.draggingSeek) {
      this.elapsed.textContent = formatTime(this.engine.currentTime);
      this.seek.value = duration > 0 ? String(Math.round((this.engine.currentTime / duration) * 1000)) : '0';
    }
  }

  showToast(message: string): void {
    this.required('#toast-message').textContent = message;
    this.toast.removeAttribute('hidden');
  }

  setTrack(track: { title: string; duration: number } | null): void {
    const title = track?.title ?? 'No track loaded';
    this.trackTitle.textContent = title;
    this.trackTitle.title = title;
    this.duration.textContent = formatTime(track?.duration ?? 0);
    this.updateTime();
  }

  setWelcomeVisible(visible: boolean): void {
    this.welcome.classList.toggle('is-hidden', !visible);
    this.welcome.setAttribute('aria-hidden', String(!visible));
  }

  updateFullscreenButton(): void {
    const active = document.fullscreenElement !== null;
    const button = this.required<HTMLButtonElement>('#fullscreen');
    const label = active ? 'Exit fullscreen' : 'Enter fullscreen';
    button.innerHTML = svg(active ? icons.exitFullscreen : icons.fullscreen);
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  private bindEngineEvents(): void {
    this.engine.on('trackchange', (track) => {
      this.setTrack(track);
      this.updatePlaybackState();
    });
    this.engine.on('timeupdate', () => {
      this.updateTime();
      this.updatePlaybackState();
    });
    this.engine.on('play', () => {
      this.setWelcomeVisible(false);
      this.updatePlaybackState();
    });
    this.engine.on('pause', () => this.updatePlaybackState());
    this.engine.on('ended', () => this.updatePlaybackState());
    this.engine.on('seek', () => {
      this.showSeekHint();
      this.updatePlaybackState();
    });
    this.engine.on('restart', () => {
      this.updateTime();
      this.updatePlaybackState();
    });
    this.engine.on('error', (message) => this.showToast(message));
  }

  private bindSettingRange(key: 'memory' | 'tension' | 'detail', selector: string): void {
    const input = this.required<HTMLInputElement>(selector);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      this.required<HTMLOutputElement>(`#${key}-value`).value = value.toFixed(2);
      this.updateSetting(key, value);
    });
  }

  private updateSetting<K extends keyof VisualSettings>(key: K, value: VisualSettings[K]): void {
    this.settings[key] = value;
    if (key === 'mode') {
      this.required<HTMLSelectElement>('#setting-mode').value = this.settings.mode;
      this.syncModeClass();
    }
    this.callbacks.onSettingsChange({ [key]: value });
  }

  private setMode(mode: VisualMode): void {
    this.updateSetting('mode', mode);
    this.showModeHint(mode);
  }

  private syncModeClass(): void {
    document.body.classList.toggle('mode-rupture', this.settings.mode === 'rupture');
    document.body.classList.toggle('mode-splat', this.settings.mode === 'splat');
  }

  private toggleDrawer(): void {
    this.setDrawerOpen(!this.drawer.classList.contains('is-open'));
  }

  private setDrawerOpen(open: boolean): void {
    this.drawer.classList.toggle('is-open', open);
    this.drawer.setAttribute('aria-hidden', String(!open));
    this.settingsButton.setAttribute('aria-expanded', String(open));
  }

  private showSeekHint(): void {
    this.showHint(SEEK_HINT_TEXT, 3000);
  }

  private showModeHint(mode: VisualMode): void {
    this.showHint({ membrane: 'Membrane', rupture: 'Rupture', splat: 'Splat' }[mode], 1500);
  }

  private showHint(message: string, duration: number): void {
    this.seekHint.textContent = message;
    this.seekHint.classList.add('is-visible');
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
    }
    this.hintTimer = window.setTimeout(() => {
      this.seekHint.classList.remove('is-visible');
      this.seekHint.textContent = SEEK_HINT_TEXT;
      this.hintTimer = null;
    }, duration);
  }

  private bindActivityAndKeyboard(): void {
    const activity = (): void => {
      this.bar.classList.remove('is-dimmed');
      if (this.engine.playing) {
        this.scheduleFade();
      }
    };
    document.addEventListener('pointermove', activity, { passive: true });
    document.addEventListener('keydown', (event) => {
      activity();
      const target = event.target;
      const isInput = target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable);
      if (isInput || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.code === 'Space') {
        if (target instanceof HTMLElement && target.closest('button')) {
          return;
        }
        event.preventDefault();
        this.callbacks.onPlayToggle();
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        this.callbacks.onFullscreen();
      } else if (event.key.toLowerCase() === 'm' && !event.shiftKey) {
        event.preventDefault();
        const order: VisualMode[] = ['membrane', 'rupture', 'splat'];
        this.setMode(order[(order.indexOf(this.settings.mode) + 1) % order.length]);
      } else if (event.key === 'Home') {
        event.preventDefault();
        this.callbacks.onRestart();
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && this.engine.duration > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 15 : 5;
        const delta = event.key === 'ArrowLeft' ? -step : step;
        this.callbacks.onSeek(Math.max(0, Math.min(this.engine.duration, this.engine.currentTime + delta)));
        this.showSeekHint();
      }
    });
    this.bar.addEventListener('pointerenter', () => this.clearFadeTimer());
    this.bar.addEventListener('pointerleave', () => this.scheduleFade());
    this.bar.addEventListener('focusin', () => this.clearFadeTimer());
    this.bar.addEventListener('focusout', () => this.scheduleFade());
  }

  private bindDropHandling(): void {
    let dragDepth = 0;
    const highlight = this.required('#drop-highlight');
    window.addEventListener('dragenter', (event) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
        return;
      }
      event.preventDefault();
      dragDepth += 1;
      highlight.classList.add('is-active');
    });
    window.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
      }
    });
    window.addEventListener('dragleave', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) {
        return;
      }
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        highlight.classList.remove('is-active');
      }
    });
    window.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files.length) {
        return;
      }
      event.preventDefault();
      dragDepth = 0;
      highlight.classList.remove('is-active');
      const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith('audio/'));
      if (file) {
        this.callbacks.onFile(file);
      }
    });
  }

  private scheduleFade(): void {
    this.clearFadeTimer();
    if (!this.engine.playing) {
      return;
    }
    this.fadeTimer = window.setTimeout(() => {
      const protectedByInteraction = this.bar.matches(':hover') || this.bar.contains(document.activeElement);
      if (protectedByInteraction) {
        this.scheduleFade();
      } else {
        this.bar.classList.add('is-dimmed');
      }
    }, 3000);
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer !== null) {
      window.clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
  }

  private required<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.app.querySelector<T>(selector);
    if (!element) {
      throw new Error(`Missing UI element: ${selector}`);
    }
    return element;
  }
}
