import './styles.css';
import { AudioEngine } from './audio/engine';
import { Controls } from './ui/controls';
import { SongPicker } from './ui/song-picker';
import { YouTubePlayer } from './audio/youtube';
import { createVisualiser, type Visualiser } from './visual';

const engine = new AudioEngine();
let visualiser: Visualiser | null = null;

function reportError(error: unknown): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
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
  onSearch: (query) => songPicker.open(query),
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

const app = document.querySelector<HTMLElement>('#app')!;
const youtubePlayer = new YouTubePlayer(app, () => songPicker.open());
const songPicker = new SongPicker(app, async (song) => {
  await engine.loadYouTube(song, youtubePlayer);
  controls.setWelcomeVisible(false);
});

engine.on('trackchange', (track) => {
  visualiser?.setIdle(track.source === 'youtube');
  visualiser?.reset(track.seed);
});
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
      visualiser.setIdle(engine.track.source === 'youtube');
      visualiser.reset(engine.track.seed);
    } else {
      // Until something is played, every room runs on silent, imaginary music.
      visualiser.setIdle(true);
    }
  })
  .catch((error: unknown) => {
    reportError(error);
  });
