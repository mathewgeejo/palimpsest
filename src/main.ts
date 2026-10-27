import './styles.css';
import { AudioEngine } from './audio/engine';
import { Controls } from './ui/controls';
import { createVisualiser, type Visualiser } from './visual';

const engine = new AudioEngine();
let visualiser: Visualiser | null = null;

function reportError(error: unknown): void {
  controls.showToast(error instanceof Error ? error.message : 'Something went wrong while loading audio.');
}

const controls = new Controls(engine, {
  onPlayToggle: () => {
    if (engine.ended) {
      engine.restart();
      void engine.play().catch(reportError);
      return;
    }
    void engine.togglePlay().catch(reportError);
  },
  onTryDemo: () => {
    void engine.loadDemo()
      .then(() => engine.play())
      .catch(reportError);
  },
  onChooseFile: () => {
    document.querySelector<HTMLInputElement>('#audio-file')?.click();
  },
  onFile: (file) => {
    void engine.loadFile(file)
      .then(() => engine.play())
      .catch(reportError);
  },
  onSeek: (seconds) => engine.seek(seconds),
  onRestart: () => engine.restart(),
  onVolume: (value) => engine.setVolume(value),
  onExport: () => {
    if (!visualiser) {
      controls.showToast('The visualiser is unavailable in this build.');
      return;
    }
    void visualiser.exportPNG()
      .then((blob) => {
        const link = document.createElement('a');
        const title = (engine.track?.title ?? 'study')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'study';
        const minutes = Math.floor(engine.currentTime / 60);
        const seconds = Math.floor(engine.currentTime % 60).toString().padStart(2, '0');
        const downloadUrl = URL.createObjectURL(blob);
        link.href = downloadUrl;
        link.download = `palimpsest-${title}-${minutes}-${seconds}.png`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      })
      .catch(reportError);
  },
  onFullscreen: () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(reportError);
    } else {
      void document.documentElement.requestFullscreen().catch(reportError);
    }
  },
  onSettingsChange: (settings) => visualiser?.setSettings(settings),
});

engine.on('trackchange', (track) => visualiser?.reset(track.seed));
const resetVisualiser = (): void => {
  const track = engine.track;
  if (track) {
    visualiser?.reset(track.seed);
  }
};
engine.on('seek', resetVisualiser);
engine.on('restart', resetVisualiser);

const stage = document.querySelector<HTMLElement>('#stage');
if (!stage) {
  throw new Error('The visual stage is missing.');
}

void createVisualiser({
  container: stage,
  source: engine,
  settings: controls.settings,
  onError: (message) => controls.showToast(message),
  onTick: () => {
    controls.updateTime();
    controls.updatePlaybackState();
  },
})
  .then((instance) => {
    visualiser = instance;
    if (engine.track) {
      visualiser.reset(engine.track.seed);
    }
  })
  .catch((error: unknown) => {
    reportError(error);
  });
