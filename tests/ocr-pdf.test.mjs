import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';
import { startApp, searchReq } from './helpers.mjs';
import { ROOT } from '../server/config.mjs';

/** A PDF like a scanner makes: each page is one picture, with no text layer at all. */
function makeScannedPdf(pagesOfLines) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesId = add(null);
  const kids = [];
  for (const lines of pagesOfLines) {
    const w = 1240, h = 300 + lines.length * 90;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#000'; ctx.font = '56px sans-serif';
    lines.forEach((l, i) => ctx.fillText(l, 80, 160 + i * 90));
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
    const data = zlib.deflateSync(rgb);
    const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]));
    const pw = 612, ph = Math.round(612 * h / w);
    const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    const content = add(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const parts = [Buffer.from('%PDF-1.4\n')], offsets = [];
  let len = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(len);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n')]);
    parts.push(b); len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref)]);
}

test('OCR: a scanned PDF (pages are images, no text layer) is read on the server and becomes searchable', { timeout: 180_000 }, async (t) => {
  const env = await startApp({ OCR_ENABLED: 'true', OCR_LANG_PATH: ROOT });
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const pdf = makeScannedPdf([['Cedar Avenue lane closure', 'Permit number 4471'], ['Detour on Birch Street', 'Approved by Transportation']]);
  const r = await c.upload('scanned-permit.pdf', pdf);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.data.extraction, 'ok', JSON.stringify(r.data.data.notes));
  assert.match(r.data.data.notes.join(' '), /OCR from 2 scanned pages/);
  const rec = (await c.get(`/api/records/${r.data.data.recordId}`)).data.data;
  assert.equal(rec.documentType, 'PDF (OCR)');
  assert.match(rec.content, /Cedar Avenue/i);
  assert.match(rec.content, /Birch Street/i, 'the second page is read too');
  const sr = await searchReq(c, 'Birch Street detour', { edits: { recordTypes: [], dateFrom: null, dateTo: null } });
  assert(sr.results.some(x => x.record.id === r.data.data.recordId), 'found by words that exist only in the scanned image');
});

test('OCR off: a scanned PDF is stored and says why it is not searchable', async (t) => {
  const env = await startApp({ OCR_ENABLED: 'false' });
  t.after(() => env.close());
  const c = env.client(); await c.setup();
  const r = await c.upload('scan.pdf', makeScannedPdf([['Cedar Avenue']]));
  assert.equal(r.status, 201);
  assert.equal(r.data.data.extraction, 'ocr_unavailable');
  assert.match(r.data.data.notes.join(' '), /OCR is switched off/);
});
