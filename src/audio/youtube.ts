import type { YouTubeSong } from '../music/search';

interface Player {
  loadVideoById(id: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { title?: string };
  destroy(): void;
}

interface YouTubeAPI {
  Player: new (element: HTMLElement, options: {
    width: string;
    height: string;
    videoId: string;
    playerVars: Record<string, string | number>;
    events: {
      onReady(event: { target: Player }): void;
      onStateChange(event: { data: number }): void;
      onError(event: { data: number }): void;
      onAutoplayBlocked(): void;
    };
  }) => Player;
}

declare global {
  interface Window {
    YT?: YouTubeAPI;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeAPI> | null = null;

function loadAPI(): Promise<YouTubeAPI> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YouTubeAPI>((resolve, reject) => {
    const script = document.createElement('script');
    const previousReady = window.onYouTubeIframeAPIReady;
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previousReady;
    };
    const fail = (): void => {
      cleanup();
      script.remove();
      reject(new Error('The YouTube player could not load. Check your connection or content blocker and try again.'));
    };
    const ready = (): void => {
      cleanup();
      previousReady?.();
      if (window.YT?.Player) resolve(window.YT);
      else fail();
    };
    const timeout = window.setTimeout(fail, 15_000);
    window.onYouTubeIframeAPIReady = ready;
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = fail;
    document.head.append(script);
  }).catch((error: unknown) => {
    apiPromise = null;
    throw error;
  });
  return apiPromise;
}

function playerError(code: number): string {
  if (code === 100) return 'This track is private or no longer available. Choose another result.';
  if (code === 101 || code === 150) return 'This track cannot play here. Choose another result or open it on YouTube.';
  if (code === 153) return 'YouTube could not verify this website. Open the track on YouTube or try another browser.';
  return 'YouTube could not play this track. Choose another result or open it on YouTube.';
}

/** The video remains visible; YouTube audio never passes through our analyser. */
export class YouTubePlayer {
  onStateChange: ((state: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onBlocked: (() => void) | null = null;
  private readonly panel: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly status: HTMLElement;
  private readonly link: HTMLAnchorElement;
  private player: Player | null = null;
  private readyPlayer: Player | null = null;
  private readyPromise: Promise<Player> | null = null;
  private generation = 0;
  private volume = 0.8;

  constructor(container: HTMLElement, onSearch: () => void) {
    this.panel = document.createElement('aside');
    this.panel.className = 'youtube-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', 'YouTube player');
    this.panel.innerHTML = `
      <div class="youtube-heading"><span>YouTube</span><button type="button" class="youtube-search">Change song</button></div>
      <p class="youtube-title"></p>
      <div class="youtube-mount"></div>
      <p class="youtube-status" role="status"></p>
      <p class="youtube-note">Gallery animation · YouTube audio cannot be analysed here.</p>
      <a class="youtube-link" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a>
    `;
    container.append(this.panel);
    this.mount = this.panel.querySelector<HTMLElement>('.youtube-mount')!;
    this.heading = this.panel.querySelector<HTMLElement>('.youtube-title')!;
    this.status = this.panel.querySelector<HTMLElement>('.youtube-status')!;
    this.link = this.panel.querySelector<HTMLAnchorElement>('.youtube-link')!;
    this.panel.querySelector('button')!.addEventListener('click', onSearch);
  }

  get playing(): boolean { return this.readyPlayer?.getPlayerState() === 1; }
  get ended(): boolean { return this.readyPlayer?.getPlayerState() === 0; }
  get currentTime(): number { return this.readyPlayer?.getCurrentTime() || 0; }
  get duration(): number { return this.readyPlayer?.getDuration() || 0; }
  get title(): string { return this.readyPlayer?.getVideoData().title ?? ''; }

  async load(song: YouTubeSong): Promise<void> {
    const generation = ++this.generation;
    this.panel.hidden = false;
    this.heading.textContent = song.title;
    this.heading.title = song.title;
    this.link.href = `https://www.youtube.com/watch?v=${song.id}`;
    this.status.textContent = 'Loading player…';
    try {
      const player = await this.ensurePlayer(song.id);
      if (generation !== this.generation) throw new DOMException('Track load was superseded.', 'AbortError');
      player.setVolume(this.volume * 100);
      this.status.textContent = 'Press play in the video if playback does not start.';
      player.loadVideoById(song.id);
    } catch (error) {
      if (generation === this.generation) this.status.textContent = error instanceof Error ? error.message : 'Could not load YouTube. Please try again.';
      throw error;
    }
  }

  play(): void { this.readyPlayer?.playVideo(); }
  pause(): void { this.readyPlayer?.pauseVideo(); }
  seek(seconds: number): void { this.readyPlayer?.seekTo(seconds, true); }
  setVolume(value: number): void {
    this.volume = value;
    this.readyPlayer?.setVolume(value * 100);
  }

  stop(): void {
    this.generation += 1;
    this.onStateChange = null;
    this.onError = null;
    this.onBlocked = null;
    this.readyPlayer?.stopVideo();
    this.panel.hidden = true;
  }

  private async ensurePlayer(videoId: string): Promise<Player> {
    if (this.readyPlayer) return this.readyPlayer;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = loadAPI().then((api) => new Promise<Player>((resolve, reject) => {
      const target = document.createElement('div');
      this.mount.replaceChildren(target);
      const timeout = window.setTimeout(() => {
        this.player?.destroy();
        this.player = null;
        reject(new Error('YouTube did not respond. Check your connection and try again.'));
      }, 15_000);
      this.player = new api.Player(target, {
        width: '100%',
        height: '200',
        videoId,
        playerVars: { playsinline: 1, origin: window.location.origin, rel: 0 },
        events: {
          onReady: ({ target: player }) => {
            window.clearTimeout(timeout);
            this.readyPlayer = player;
            resolve(player);
          },
          onStateChange: ({ data }) => {
            if (this.panel.hidden) return;
            if (data === 1) {
              this.status.textContent = '';
              const title = this.title;
              if (title) {
                this.heading.textContent = title;
                this.heading.title = title;
              }
            } else if (data === 3) this.status.textContent = 'Buffering…';
            else if (data === 5) this.status.textContent = 'Press play in the video to start listening.';
            else if (data === 2) this.status.textContent = 'Paused';
            else if (data === 0) this.status.textContent = 'Track finished.';
            this.onStateChange?.(data);
          },
          onError: ({ data }) => {
            const message = playerError(data);
            this.status.textContent = message;
            this.onError?.(message);
          },
          onAutoplayBlocked: () => {
            this.status.textContent = 'Press play in the video to start listening.';
            this.onBlocked?.();
          },
        },
      });
    })).catch((error: unknown) => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }
}
