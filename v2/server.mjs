// Serves the built app (dist/) with the same security headers as v1.
// No packages needed at runtime: `npm run build` once, then `node server.mjs`.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.env.PORT || process.env.POC_PORT || 8765);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
};
const indexHtml = () => fs.readFileSync(path.join(root, 'index.html'));

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('dist/ not found. Run `npm install` then `npm run build` first.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
    return res.end(JSON.stringify({ ok: true, corpus: 'synthetic', version: 2 }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY });
    return res.end(JSON.stringify({ error: 'Method not allowed.' }));
  }
  const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  const insideRoot = file.startsWith(root + path.sep);
  if (insideRoot && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const hashed = file.includes(`${path.sep}assets${path.sep}`);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache', ...SECURITY });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(file).pipe(res);
  }
  if (path.extname(url.pathname) && !url.pathname.endsWith('.html')) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY });
    return res.end(JSON.stringify({ error: 'Not found.' }));
  }
  // Client-side routes (/, /search, /evaluation, and the old *.html URLs) get the app shell.
  res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', ...SECURITY });
  res.end(req.method === 'HEAD' ? undefined : indexHtml());
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Public Records POC v2 listening on port ${port}.`);
  console.log(`This computer: http://localhost:${port}/`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) console.log(`Same-network preview: http://${a.address}:${port}/`);
  }
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
