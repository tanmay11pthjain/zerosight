// Production entry: serves the built app from dist/ plus the courier API on one port.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { handleApi } from './app.mjs';

const PORT = Number(process.env.PORT) || 8787;
const DIST = resolve(import.meta.dirname, '..', 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const server = http.createServer(async (req, res) => {
  if (await handleApi(req, res)) return;
  const url = new URL(req.url || '/', 'http://local');
  let file = resolve(DIST, '.' + decodeURIComponent(url.pathname));
  if (file !== DIST && !file.startsWith(DIST + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
  } catch {
    file = join(DIST, 'index.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(data);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Build missing. Run: npm run build');
  }
});

server.listen(PORT, () => console.log(`ZeroSight courier + app on http://localhost:${PORT}`));
