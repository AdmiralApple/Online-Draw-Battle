// Local static file server for development: serves the repo root, like GitHub Pages does.
// ES modules and Web Workers don't load from file://, so open the game through this.
//   npm start            (PORT env var, default 3000)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/** Resolve a URL path to a file inside ROOT, refusing anything that escapes it. */
export function safePath(rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  const p = normalize(join(ROOT, decoded));
  return p === ROOT || p.startsWith(ROOT + sep) ? p : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let file = safePath(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file || file.includes(`${sep}node_modules${sep}`) || file.includes(`${sep}.git`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let st = await stat(file).catch(() => null);
    if (st && st.isDirectory()) {
      file = join(file, 'index.html');
      st = await stat(file).catch(() => null);
    }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`Scribble Siege running at http://localhost:${PORT}`);
});
