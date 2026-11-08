import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const pythonModules = fileURLToPath(new URL('../.tools/python', import.meta.url));
const AUDIO_FORMAT = 'bestaudio[ext=m4a][protocol=https]/bestaudio[protocol=https]/bestaudio[protocol=http]';

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

function extract(id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PALIMPSEST_PYTHON || 'python', [
      '-m', 'yt_dlp', '--ignore-config', '--no-playlist', '--no-warnings', '--no-progress',
      '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '15', '--retries', '1',
      '--skip-download', '--dump-single-json', '--format', AUDIO_FORMAT,
      `https://www.youtube.com/watch?v=${id}`,
    ], {
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: [pythonModules, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Finding the audio took too long. Please try another track.')); }, 40_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 4_000_000) { child.kill(); reject(new Error('This track returned an unsupported response.')); }
    });
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-8000); });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Audio playback is unavailable on this server. Try a local audio file.')); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        const message = /No module named|not recognized|not found/i.test(error)
          ? 'Audio playback is not set up on this server. Try a local audio file.'
          : /sign in|private|unavailable|not available|age.restricted/i.test(error)
            ? 'This track’s audio is unavailable. Try another result or a local audio file.'
            : 'Could not open this track’s audio. Try another result or a local audio file.';
        reject(new Error(message));
        return;
      }
      try {
        const data = JSON.parse(output);
        const url = new URL(data.url);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || data.vcodec !== 'none') {
          throw new Error('The track did not provide a supported audio-only stream.');
        }
        resolve({ url: url.href, headers: data.http_headers ?? {}, title: data.title || 'YouTube track', duration: data.duration || 0 });
      } catch {
        reject(new Error('This track did not provide a supported audio-only stream. Try another result.'));
      }
    });
  });
}

/** Shared by Vite dev/preview and the production server; never downloads video. */
export function createMusicHandler({ resolveTrack = extract, fetchAudio = fetch } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function track(id) {
    const cached = cache.get(id);
    if (cached && cached.expires > Date.now()) return cached;
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 4) throw new Error('Several songs are loading. Please try again in a moment.');
    const promise = resolveTrack(id).then((data) => {
      const expiry = Number(new URL(data.url).searchParams.get('expire')) * 1000;
      const entry = { ...data, expires: Math.min(Date.now() + 600_000, expiry > Date.now() ? expiry - 60_000 : Infinity) };
      if (cache.size >= 80) cache.delete(cache.keys().next().value);
      cache.set(id, entry);
      return entry;
    }).finally(() => pending.delete(id));
    pending.set(id, promise);
    return promise;
  }

  return async (request, response, next) => {
    const path = new URL(request.url || '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/music/')) { next(); return; }
    const match = /^\/api\/music\/(tracks|audio)\/([^/]+)$/.exec(path);
    if (!match || !VIDEO_ID.test(match[2])) { json(response, 400, { error: 'Use a valid YouTube track link.' }); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); json(response, 405, { error: 'Method not allowed.' }); return; }
    const [, action, id] = match;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    response.once('close', disconnect);
    try {
      let audio = await track(id);
      if (controller.signal.aborted) return;
      if (action === 'tracks') {
        json(response, 200, { title: audio.title, duration: audio.duration, url: `/api/music/audio/${id}` });
        return;
      }
      const range = request.headers.range;
      if (range && !/^bytes=\d*-\d*$/.test(range)) { json(response, 416, { error: 'Unsupported audio range.' }); return; }
      const open = async () => {
        const headers = { ...audio.headers, 'Accept-Encoding': 'identity' };
        if (range) headers.Range = range;
        const timeout = setTimeout(() => controller.abort(), 20_000);
        try { return await fetchAudio(audio.url, { headers, method: request.method, signal: controller.signal }); }
        finally { clearTimeout(timeout); }
      };
      let upstream = await open();
      if (upstream.status === 403 || upstream.status === 410) {
        await upstream.body?.cancel();
        cache.delete(id);
        audio = await track(id);
        upstream = await open();
      }
      if (![200, 206, 416].includes(upstream.status)) {
        await upstream.body?.cancel();
        throw new Error('The audio stream is unavailable. Please try another track.');
      }
      response.statusCode = upstream.status;
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.setHeader('Cache-Control', 'private, max-age=300');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method === 'HEAD' || !upstream.body) response.end();
      else await pipeline(Readable.fromWeb(upstream.body), response, { signal: controller.signal });
    } catch (error) {
      if (response.destroyed) return;
      if (controller.signal.aborted) {
        if (!response.headersSent) json(response, 504, { error: 'The audio stream took too long to respond. Please try again.' });
        else response.destroy();
        return;
      }
      if (!response.headersSent) json(response, 502, { error: error instanceof Error ? error.message : 'Could not load audio.' });
      else response.destroy();
    } finally {
      response.off('close', disconnect);
    }
  };
}
