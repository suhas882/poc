const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const root = __dirname;
const port = Number(process.env.PORT || process.env.POC_PORT || 8765);
const allowedFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/search.html', ['search.html', 'text/html; charset=utf-8']],
  ['/evaluation.html', ['evaluation.html', 'text/html; charset=utf-8']],
  ['/POC-VIDEO.html', ['POC-VIDEO.html', 'text/html; charset=utf-8']],
  ['/PITCH-VIDEO-SCRIPT.md', ['PITCH-VIDEO-SCRIPT.md', 'text/markdown; charset=utf-8']],
  ['/video-output/bellevue-public-records-poc-walkthrough.mp4', ['video-output/bellevue-public-records-poc-walkthrough.mp4', 'video/mp4']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, corpus: 'synthetic' });
  }
  if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' });
  const file = allowedFiles.get(url.pathname);
  if (!file) return sendJson(response, 404, { error: 'Not found.' });
  response.writeHead(200, {
    'Content-Type': file[1],
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  fs.createReadStream(path.join(root, file[0])).pipe(response);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Public Records POC listening on port ${port}.`);
  console.log(`This computer: http://localhost:${port}/`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        console.log(`Same-network preview: http://${address.address}:${port}/`);
      }
    }
  }
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
