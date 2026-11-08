export interface YouTubeSong {
  id: string;
  title: string;
  artist: string;
}

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

/** Accept individual tracks, including links copied from YouTube Music. */
export function youtubeId(value: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = url.pathname.split('/')[1] ?? null;
    } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      id = url.searchParams.get('v');
      if (!id && /^\/(shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split('/')[2] ?? null;
    }
    return id && VIDEO_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

function decodeTitle(value: string): string {
  const text = document.createElement('textarea');
  text.innerHTML = value;
  return text.value;
}

export async function searchYouTube(query: string, key: string, signal: AbortSignal): Promise<YouTubeSong[]> {
  const params = new URLSearchParams({
    key,
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    maxResults: '10',
    q: query,
    fields: 'items(id/videoId,snippet(title,channelTitle))',
  });
  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
    credentials: 'omit',
  });
  const data = await response.json() as {
    items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }[];
    error?: { errors?: { reason?: string }[] };
  };
  if (!response.ok) {
    const reason = data.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new Error('YouTube search has reached its daily limit. You can still paste a YouTube or YouTube Music link.');
    }
    if (response.status === 400 || response.status === 403) {
      throw new Error('Check your search API key, enable YouTube Data API v3, and allow this website in the key’s restrictions.');
    }
    throw new Error('YouTube search is unavailable. Try again, or paste a track link.');
  }
  if (!Array.isArray(data.items)) throw new Error('YouTube returned an unexpected response. Please try again.');
  const seen = new Set<string>();
  return data.items.flatMap((item) => {
    const id = item.id?.videoId;
    if (!id || !VIDEO_ID.test(id) || !item.snippet?.title || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: decodeTitle(item.snippet.title), artist: decodeTitle(item.snippet.channelTitle ?? 'YouTube') }];
  });
}
