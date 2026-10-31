// Test helpers: start the real app on a random port with a throwaway data folder,
// a cookie-aware client, fake external services, and tiny DOCX/XLSX/PDF builders.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { getConfig } from '../server/config.mjs';
import { createApp } from '../server/app.mjs';

export async function startApp(env = {}, deps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prs-test-'));
  const config = getConfig({ DATA_DIR: dir, OCR_ENABLED: 'false', RATE_LIMIT_API_PER_MINUTE: '10000', RATE_LIMIT_SEARCH_PER_MINUTE: '1000', ...env });
  const logs = [];
  const app = createApp(config, { log: (...a) => logs.push(a.join(' ')), ...deps });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, app, config, dir, logs,
    client: () => new Client(base),
    async close() { await new Promise(r => server.close(r)); await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

export class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, headers = {}) {
    const h = { ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    let payload = body;
    if (body !== undefined && !(body instanceof Buffer) && typeof body !== 'string') { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) {
      const jar = new Map(this.cookie ? this.cookie.split('; ').map(c => [c.split('=')[0], c]) : []);
      for (const part of set.split(/,(?=\s*[A-Za-z_][\w-]*=)/)) { const kv = part.trim().split(';')[0]; const name = kv.split('=')[0]; if (kv.endsWith('=')) jar.delete(name); else jar.set(name, kv); }
      this.cookie = [...jar.values()].join('; ');
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(u, h) { return this.req('GET', u, undefined, h); }
  post(u, b, h) { return this.req('POST', u, b, h); }
  put(u, b) { return this.req('PUT', u, b); }
  patch(u, b) { return this.req('PATCH', u, b); }
  del(u) { return this.req('DELETE', u); }
  async upload(file, buf, query = '') { return this.req('POST', `/api/uploads${query}`, buf, { 'x-file-name': encodeURIComponent(file), 'content-type': 'application/octet-stream' }); }
  async setup(email = 'admin@example.org', password = 'correct horse battery') {
    const r = await this.post('/api/auth/setup', { orgName: 'Example City', name: 'Ada Admin', email, password });
    this.csrf = r.data.data?.csrfToken;
    if (this.autoConsent !== false && r.status === 201) await this.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true });
    return r;
  }
  async login(email, password) {
    this.csrf = '';
    const r = await this.post('/api/auth/login', { email, password });
    this.csrf = r.data.data?.csrfToken || '';
    if (this.autoConsent !== false && r.status === 200) await this.put('/api/consent', { scope: 'all', sourceIds: [], acknowledged: true });
    return r;
  }
}

/** Wait for background sync of a source to finish. */
export async function waitForSync(client, sourceId, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await client.get('/api/sources');
    const s = r.data.data.find(x => x.id === sourceId);
    if (s && s.status !== 'syncing') return s;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('sync timed out');
}

/** Start an HTTP server whose handler is a function (req, url, body) => {status, json|body, headers}. */
export async function fakeServer(handle) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    calls.push({ method: req.method, path: url.pathname, url, headers: req.headers, body });
    const out = await handle(req, url, body, calls);
    res.writeHead(out.status ?? 200, { 'content-type': out.body !== undefined ? 'text/plain' : 'application/json', ...(out.headers || {}) });
    res.end(out.body !== undefined ? out.body : JSON.stringify(out.json ?? {}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => server.close(r)) };
}

/* ---------------- file builders ---------------- */

export function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export function makeDocx(paragraphs, { title = 'Test document', created = '2025-02-10T09:00:00Z' } = {}) {
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs.map(p => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`,
    'docProps/core.xml': `<?xml version="1.0"?><cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:title>${title}</dc:title><dc:creator>Pat Engineer</dc:creator><dcterms:created>${created}</dcterms:created></cp:coreProperties>`
  });
}

export function makeXlsx(rows) {
  const strings = [...new Set(rows.flat().map(String))];
  const cell = (v, i, r) => `<c r="${String.fromCharCode(65 + i)}${r}" t="s"><v>${strings.indexOf(String(v))}</v></c>`;
  return makeZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Permits" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${strings.map(s => `<si><t>${s}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, i) => cell(v, i, ri + 1)).join('')}</row>`).join('')}</sheetData></worksheet>`
  });
}

/** A valid single-page PDF with a text layer. */
export function makePdf(lines, { title = 'Test PDF' } = {}) {
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map(l => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${title}) /Author (Records Unit) /CreationDate (D:20250305120000Z) >>`
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
