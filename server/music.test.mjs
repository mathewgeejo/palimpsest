import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createMusicHandler } from './music.mjs';

async function withServer(options, run) {
  const handler = createMusicHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response, () => { response.writeHead(404); response.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

const id = 'dQw4w9WgXcQ';
const audio = { url: 'https://test.googlevideo.com/audio', title: 'Test song', duration: 120, headers: { 'User-Agent': 'audio-client' } };

test('metadata keeps the upstream URL private and caches extraction', async () => {
  let calls = 0;
  await withServer({ resolveTrack: async () => { calls++; return audio; } }, async (base) => {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/music/tracks/${id}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { title: 'Test song', duration: 120, url: `/api/music/audio/${id}` });
    }
    assert.equal(calls, 1);
  });
});

test('audio forwards byte ranges and streams only the selected audio response', async () => {
  await withServer({ resolveTrack: async () => audio, fetchAudio: async (url, options) => {
    assert.equal(url, audio.url);
    assert.equal(options.headers.Range, 'bytes=2-5');
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.equal(options.headers['User-Agent'], 'audio-client');
    return new Response('2345', { status: 206, headers: { 'content-type': 'audio/mp4', 'content-range': 'bytes 2-5/10', 'content-length': '4', 'accept-ranges': 'bytes' } });
  } }, async (base) => {
    const response = await fetch(`${base}/api/music/audio/${id}`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mp4');
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await response.text(), '2345');
  });
});

test('expired upstream audio URLs are refreshed once', async () => {
  let resolves = 0;
  let opens = 0;
  await withServer({ resolveTrack: async () => { resolves++; return audio; }, fetchAudio: async () => {
    opens++;
    return opens === 1 ? new Response('expired', {status: 403}) : new Response('audio', {headers: {'content-type': 'audio/mp4'}});
  } }, async (base) => {
    const response = await fetch(`${base}/api/music/audio/${id}`);
    assert.equal(await response.text(), 'audio');
    assert.equal(resolves, 2);
    assert.equal(opens, 2);
  });
});

test('concurrent requests for one track share a single extraction', async () => {
  let calls = 0;
  await withServer({ resolveTrack: async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 25)); return audio; } }, async (base) => {
    const responses = await Promise.all([fetch(`${base}/api/music/tracks/${id}`), fetch(`${base}/api/music/tracks/${id}`)]);
    assert.equal(calls, 1);
    assert(responses.every((response) => response.ok));
    await Promise.all(responses.map((response) => response.text()));
  });
});

test('bad IDs and multi-range requests are rejected', async () => {
  let opens = 0;
  await withServer({ resolveTrack: async () => audio, fetchAudio: async () => { opens++; return new Response('unexpected'); } }, async (base) => {
    const badId = await fetch(`${base}/api/music/tracks/invalid!`);
    assert.equal(badId.status, 400);
    const multiRange = await fetch(`${base}/api/music/audio/${id}`, {headers: {Range: 'bytes=0-1,5-6'}});
    assert.equal(multiRange.status, 416);
    assert.equal(opens, 0);
  });
});

test('extraction failures return a useful error and can be retried', async () => {
  let calls = 0;
  await withServer({ resolveTrack: async () => { if (++calls === 1) throw new Error('Track unavailable'); return audio; } }, async (base) => {
    const failed = await fetch(`${base}/api/music/tracks/${id}`);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), {error: 'Track unavailable'});
    assert.equal((await fetch(`${base}/api/music/tracks/${id}`)).status, 200);
  });
});
