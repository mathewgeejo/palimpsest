import { searchYouTube, youtubeId, type YouTubeSong } from '../music/search';

const KEY_STORAGE = 'palimpsest.youtube-search-key';

function savedKey(): string {
  try { return sessionStorage.getItem(KEY_STORAGE) ?? ''; }
  catch { return ''; }
}

export class SongPicker {
  private readonly dialog: HTMLDialogElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly results: HTMLElement;
  private readonly setup: HTMLDetailsElement;
  private readonly keyInput: HTMLInputElement;
  private readonly keyStatus: HTMLElement;
  private readonly environmentKey = (import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined)?.trim() ?? '';
  private key = savedKey() || this.environmentKey;
  private debounce: number | null = null;
  private request: AbortController | null = null;
  private requestId = 0;
  private selecting = false;
  private readonly cache = new Map<string, YouTubeSong[]>();

  constructor(container: HTMLElement, private readonly onPlay: (song: YouTubeSong) => Promise<void>) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'song-dialog';
    this.dialog.setAttribute('aria-labelledby', 'song-dialog-title');
    this.dialog.setAttribute('aria-describedby', 'song-dialog-description');
    this.dialog.innerHTML = `
      <div class="song-dialog-heading">
        <div><p class="song-eyebrow">Choose your soundtrack</p><h2 id="song-dialog-title">Find a song</h2></div>
        <button class="icon-button" id="close-song-dialog" type="button" aria-label="Close song search">✕</button>
      </div>
      <p id="song-dialog-description" class="song-description">Search YouTube by song or artist, or paste a YouTube / YouTube Music track link.</p>
      <form id="song-search-form" class="song-search-form" role="search">
        <label class="sr-only" for="song-query">Song, artist, or YouTube link</label>
        <input id="song-query" type="search" placeholder="Song, artist, or YouTube Music link…" autocomplete="off" spellcheck="false" maxlength="500" autofocus />
        <button class="button button-primary" type="submit">Search</button>
      </form>
      <p class="song-status" id="song-search-status" role="status" aria-live="polite"></p>
      <ul class="song-results" aria-label="Song results" aria-busy="false"></ul>
      <details class="song-setup">
        <summary>YouTube search settings <span class="song-key-status"></span></summary>
        <p>To search by name, enable <strong>YouTube Data API v3</strong> in a <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer">Google Cloud project ↗</a>, then create an API key. Restrict it to the YouTube Data API and this website’s address.</p>
        <form class="song-key-form">
          <label for="youtube-search-key">YouTube Data API key</label>
          <div class="song-key-row"><input id="youtube-search-key" type="password" placeholder="Paste your search API key" autocomplete="off" spellcheck="false" /><button class="button button-quiet" type="submit">Use key</button></div>
          <p class="song-key-note">Used only for YouTube search. Stored for this browser tab’s session.</p>
          <button class="song-forget-key" type="button">Forget saved key</button>
        </form>
      </details>
      <p class="song-footnote">Audio only — no music video. The visuals follow the actual song and freeze when you pause. Track links work without a search key.</p>
    `;
    container.append(this.dialog);
    this.input = this.dialog.querySelector<HTMLInputElement>('#song-query')!;
    this.status = this.dialog.querySelector<HTMLElement>('#song-search-status')!;
    this.results = this.dialog.querySelector<HTMLElement>('.song-results')!;
    this.setup = this.dialog.querySelector<HTMLDetailsElement>('.song-setup')!;
    this.keyInput = this.dialog.querySelector<HTMLInputElement>('#youtube-search-key')!;
    this.keyStatus = this.dialog.querySelector<HTMLElement>('.song-key-status')!;
    this.dialog.querySelector('#close-song-dialog')!.addEventListener('click', () => this.dialog.close());
    this.dialog.addEventListener('click', (event) => {
      if (event.target !== this.dialog) return;
      const bounds = this.dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) this.dialog.close();
    });
    this.dialog.addEventListener('close', () => this.cancelSearch());
    this.input.addEventListener('input', () => this.scheduleSearch());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        const first = this.results.querySelector<HTMLButtonElement>('button');
        if (first) { event.preventDefault(); first.focus(); }
      }
    });
    this.results.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...this.results.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index < 0) return;
      event.preventDefault();
      if (index === 0 && event.key === 'ArrowUp') this.input.focus();
      else buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    });
    this.dialog.querySelector('#song-search-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      this.cancelSearch();
      void this.search();
    });
    this.dialog.querySelector('.song-key-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const key = this.keyInput.value.trim();
      if (!key) { this.keyInput.focus(); return; }
      this.key = key;
      try { sessionStorage.setItem(KEY_STORAGE, key); } catch { /* The key still works in memory. */ }
      this.keyInput.value = '';
      this.cache.clear();
      this.updateSetup();
      this.setup.open = false;
      this.scheduleSearch();
      this.input.focus();
    });
    this.dialog.querySelector('.song-forget-key')!.addEventListener('click', () => {
      try { sessionStorage.removeItem(KEY_STORAGE); } catch { /* Storage may be disabled. */ }
      this.key = this.environmentKey;
      this.keyInput.value = '';
      this.cache.clear();
      this.updateSetup();
      this.scheduleSearch();
    });
    this.updateSetup();
  }

  open(query?: string): void {
    if (!this.dialog.open) this.dialog.showModal();
    if (query !== undefined) this.input.value = query;
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.scheduleSearch();
  }

  private updateSetup(): void {
    this.keyStatus.textContent = this.key ? 'Ready' : 'Key needed for search';
    this.setup.open = !this.key;
    this.dialog.querySelector<HTMLButtonElement>('.song-forget-key')!.hidden = !savedKey();
  }

  private cancelSearch(): void {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = null;
    this.request?.abort();
    this.request = null;
    this.requestId += 1;
    this.results.setAttribute('aria-busy', 'false');
  }

  private scheduleSearch(): void {
    this.cancelSearch();
    if (this.selecting) return;
    this.results.replaceChildren();
    const query = this.input.value.trim();
    if (!query) {
      this.status.textContent = this.key ? 'Type a song name to find something to play.' : 'Paste a track link, or add a search key below to find songs by name.';
      return;
    }
    if (youtubeId(query)) { void this.search(); return; }
    if (!this.key) {
      this.status.textContent = 'Add a YouTube search key below to search by name. You can also paste a track link.';
      return;
    }
    if (query.length < 2) {
      this.status.textContent = 'Type at least two characters.';
      return;
    }
    this.status.textContent = 'Waiting for you to finish typing…';
    this.debounce = window.setTimeout(() => { this.debounce = null; void this.search(); }, 650);
  }

  private async search(): Promise<void> {
    if (this.selecting) return;
    const query = this.input.value.trim();
    const id = youtubeId(query);
    if (id) {
      this.renderResults([{ id, title: 'YouTube track', artist: 'Play this YouTube / YouTube Music link' }]);
      this.status.textContent = 'Track link ready. Choose it to play.';
      return;
    }
    if (!query || query.length < 2 || !this.key) { this.scheduleSearch(); return; }
    if (/^(https?:\/\/|www\.|music\.youtube\.|youtu\.be\/)/i.test(query)) {
      this.results.replaceChildren();
      this.status.textContent = 'Use a link to a single YouTube track, or type a song name.';
      return;
    }
    const cached = this.cache.get(query.toLocaleLowerCase());
    if (cached) {
      this.renderResults(cached);
      this.showResultCount(cached.length);
      return;
    }
    const requestId = ++this.requestId;
    const request = new AbortController();
    this.request = request;
    this.results.replaceChildren();
    this.results.setAttribute('aria-busy', 'true');
    this.status.textContent = 'Searching YouTube…';
    try {
      const songs = await searchYouTube(query, this.key, request.signal);
      if (requestId !== this.requestId || !this.dialog.open) return;
      if (this.cache.size >= 30) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(query.toLocaleLowerCase(), songs);
      this.renderResults(songs);
      this.showResultCount(songs.length);
    } catch (error) {
      if (requestId !== this.requestId || request.signal.aborted) return;
      this.status.textContent = error instanceof Error && error.name === 'TimeoutError'
        ? 'Search timed out. Check your connection and try again.'
        : error instanceof TypeError ? 'Could not reach YouTube. Check your connection and try again.'
          : error instanceof Error ? error.message : 'Could not search YouTube. Please try again.';
    } finally {
      if (requestId === this.requestId) {
        this.results.setAttribute('aria-busy', 'false');
        this.request = null;
      }
    }
  }

  private showResultCount(count: number): void {
    this.status.textContent = count ? `${count} result${count === 1 ? '' : 's'} · choose a song to play` : 'No songs found. Try another title or artist.';
  }

  private renderResults(songs: YouTubeSong[]): void {
    this.results.replaceChildren();
    for (const song of songs) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'song-result';
      button.setAttribute('aria-label', `Play ${song.title} — ${song.artist}`);
      const image = document.createElement('img');
      image.src = `https://i.ytimg.com/vi/${song.id}/mqdefault.jpg`;
      image.alt = '';
      image.loading = 'lazy';
      const info = document.createElement('span');
      info.className = 'song-result-info';
      const title = document.createElement('span');
      title.className = 'song-result-title';
      title.textContent = song.title;
      const artist = document.createElement('span');
      artist.className = 'song-result-artist';
      artist.textContent = song.artist;
      const play = document.createElement('span');
      play.className = 'song-result-play';
      play.textContent = 'Play';
      play.setAttribute('aria-hidden', 'true');
      info.append(title, artist);
      button.append(image, info, play);
      button.addEventListener('click', () => { void this.select(song); });
      item.append(button);
      this.results.append(item);
    }
  }

  private async select(song: YouTubeSong): Promise<void> {
    if (this.selecting) return;
    this.cancelSearch();
    this.selecting = true;
    this.input.disabled = true;
    this.results.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
    this.status.textContent = `Loading ${song.title}…`;
    try {
      await this.onPlay(song);
      this.dialog.close();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.status.textContent = error instanceof Error ? error.message : 'Could not play this track. Try another result.';
      }
    } finally {
      this.selecting = false;
      this.input.disabled = false;
      this.results.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = false; });
    }
  }
}
