import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMusicHandler } from './music.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const music = createMusicHandler();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
const server = createServer((request, response) => {
  void music(request, response, () => {
    void (async () => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return; }
        const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        let target = resolve(root, `.${path}`);
        if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403); response.end(); return; }
        if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
        const body = await readFile(target);
        response.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Content-Length': body.length });
        response.end(request.method === 'HEAD' ? undefined : body);
      } catch { response.writeHead(404); response.end('Not found. Run npm run dev for development.'); }
    })();
  });
});
server.listen(Number(process.env.PORT || 5173), process.env.HOST || '127.0.0.1', () => {
  console.log(`PALIMPSEST listening on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 5173}`);
});
