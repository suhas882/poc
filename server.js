const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const root = __dirname;
const port = Number(process.env.PORT || process.env.POC_PORT || 8765);
const feedbackPath = path.join(root, 'feedback.jsonl');
const allowedFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/search.html', ['search.html', 'text/html; charset=utf-8']],
  ['/evaluation.html', ['evaluation.html', 'text/html; charset=utf-8']],
  ['/workflow.html', ['workflow.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
const categories = new Set(['Overall impression', 'Search results', 'Search plan', 'Accessibility', 'Other']);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > 4096) {
        reject(Object.assign(new Error('Feedback is too large.'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('Invalid JSON.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, feedbackStorage: 'local project folder' });
  }
  if (request.method === 'POST' && url.pathname === '/api/feedback') {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Send feedback as JSON.' });
    }
    try {
      const input = await readJson(request);
      const message = typeof input.message === 'string' ? input.message.trim() : '';
      const category = typeof input.category === 'string' ? input.category : '';
      if (!message || message.length > 3000) return sendJson(response, 400, { error: 'Comments must contain 1 to 3000 characters.' });
      if (!categories.has(category)) return sendJson(response, 400, { error: 'Choose a listed feedback area.' });
      const entry = {
        submittedAt: new Date().toISOString(),
        name: typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '',
        category,
        scenario: typeof input.scenario === 'string' ? input.scenario.slice(0, 80) : '',
        message
      };
      fs.appendFileSync(feedbackPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
      return sendJson(response, 201, { ok: true });
    } catch (error) {
      if (response.headersSent || request.destroyed) return;
      return sendJson(response, error.status || 500, { error: error.status ? error.message : 'Feedback could not be saved locally.' });
    }
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
  console.log(`Feedback is appended locally to ${feedbackPath}`);
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
