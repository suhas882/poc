// @ts-check
/**
 * Text and metadata extraction for uploaded files and email attachments.
 * Every extractor returns {text, title?, author?, createdAt?, modifiedAt?, documentType, status, notes[]}.
 * status: 'ok' | 'no_text' | 'ocr_unavailable'.
 */
import path from 'node:path';
import { decodeXml, readZip } from './zip.mjs';

export const SUPPORTED = Object.freeze({
  pdf: { label: 'PDF', mime: ['application/pdf'] },
  docx: { label: 'Word document', mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  xlsx: { label: 'Spreadsheet', mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
  csv: { label: 'CSV', mime: ['text/csv', 'application/vnd.ms-excel'] },
  txt: { label: 'Text', mime: ['text/plain'] },
  md: { label: 'Text', mime: ['text/markdown'] },
  png: { label: 'Image', mime: ['image/png'] },
  jpg: { label: 'Image', mime: ['image/jpeg'] },
  jpeg: { label: 'Image', mime: ['image/jpeg'] },
  tif: { label: 'Image', mime: ['image/tiff'] },
  tiff: { label: 'Image', mime: ['image/tiff'] },
  webp: { label: 'Image', mime: ['image/webp'] }
});

/** Identify the real file type from its bytes, then require the extension to agree. */
export function detectType(filename, buf) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const head = buf.subarray(0, 8);
  const sniff =
    head.subarray(0, 5).toString('latin1') === '%PDF-' ? 'pdf' :
    head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 ? 'zip' :
    head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG' ? 'png' :
    head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'jpg' :
    (head.subarray(0, 4).toString('latin1') === 'II*\0' || head.subarray(0, 4).toString('latin1') === 'MM\0*') ? 'tif' :
    head.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? 'webp' :
    looksLikeText(buf) ? 'text' : 'binary';
  const ok =
    (ext === 'pdf' && sniff === 'pdf') ||
    ((ext === 'docx' || ext === 'xlsx') && sniff === 'zip') ||
    (['png'].includes(ext) && sniff === 'png') ||
    (['jpg', 'jpeg'].includes(ext) && sniff === 'jpg') ||
    (['tif', 'tiff'].includes(ext) && sniff === 'tif') ||
    (ext === 'webp' && sniff === 'webp') ||
    (['txt', 'csv', 'md', 'xml'].includes(ext) && sniff === 'text');
  return { ext, sniff, ok };
}

function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096);
  if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) return true;
  let bad = 0;
  for (const b of sample) if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) bad++;
  return bad <= sample.length * 0.01;
}

export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  const s = buf.toString('utf8');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/* ---------------- DOCX ---------------- */

export function extractDocx(buf) {
  const zip = readZip(buf);
  const xml = zip.read('word/document.xml');
  if (!xml) throw new Error('This file is not a Word document (word/document.xml is missing).');
  const text = docxXmlToText(xml.toString('utf8'));
  const core = zip.read('docProps/core.xml')?.toString('utf8') || '';
  const tag = (t) => { const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(core); return m ? decodeXml(m[1]).trim() : undefined; };
  return { text, title: tag('dc:title'), author: tag('dc:creator'), createdAt: tag('dcterms:created'), modifiedAt: tag('dcterms:modified'), documentType: 'Word document', status: text.trim() ? 'ok' : 'no_text', notes: [] };
}

export function docxXmlToText(xml) {
  return decodeXml(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------- XLSX ---------------- */

export function extractXlsx(buf, { maxRows = 20000 } = {}) {
  const zip = readZip(buf);
  const wb = zip.read('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new Error('This file is not an Excel workbook (xl/workbook.xml is missing).');
  const shared = [];
  const ss = zip.read('xl/sharedStrings.xml')?.toString('utf8') || '';
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  const rels = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relTarget = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const out = [];
  let rows = 0;
  for (const s of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = decodeXml(attr(s[0], 'name') || 'Sheet');
    let target = relTarget.get(attr(s[0], 'r:id') || '') || '';
    if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const sheet = zip.read(target)?.toString('utf8');
    if (!sheet) continue;
    out.push(`Sheet: ${name}`);
    for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (++rows > maxRows) { out.push('[Further rows were not indexed.]'); break; }
      const cells = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = attr(c[1], 't');
        const body = c[2] || '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const inline = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('');
        const value = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? decodeXml(inline) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : decodeXml(v ?? '');
        cells.push(value);
      }
      if (cells.some(x => x !== '')) out.push(cells.join('\t'));
    }
  }
  const text = out.join('\n');
  return { text, documentType: 'Spreadsheet', status: text.trim() ? 'ok' : 'no_text', notes: rows > maxRows ? [`Only the first ${maxRows} rows were indexed.`] : [] };
}

const attr = (tag, name) => new RegExp(`\\b${name.replace(':', '\\:')}="([^"]*)"`).exec(tag)?.[1];

/* ---------------- CSV ---------------- */

/** RFC 4180-style parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text, { maxRows = 50000 } = {}) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(x => x !== '')) rows.push(row); }
  return rows;
}

export function extractCsv(buf) {
  const rows = parseCsv(decodeText(buf));
  if (!rows.length) return { text: '', documentType: 'CSV', status: 'no_text', notes: [] };
  const [header, ...body] = rows;
  const lines = body.map(r => header.map((h, i) => (r[i] ?? '').trim() ? `${h.trim() || `Column ${i + 1}`}: ${r[i].trim()}` : '').filter(Boolean).join('; '));
  return { text: [`Columns: ${header.join(', ')}`, ...lines].join('\n'), documentType: 'CSV', status: 'ok', notes: [] };
}

/* ---------------- PDF ---------------- */

/** PDF dates look like D:20250114093000-08'00' */
export function pdfDate(s) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(s || ''));
  if (!m) return undefined;
  const d = new Date(Date.UTC(+m[1], (+(m[2] || 1)) - 1, +(m[3] || 1), +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function extractPdf(buf, { maxPages = 500 } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages = [];
    const n = Math.min(doc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n').trim());
      page.cleanup();
    }
    const meta = await doc.getMetadata().catch(() => null);
    const info = /** @type {any} */ (meta?.info) || {};
    const text = pages.filter(Boolean).join('\n\n');
    const notes = [];
    if (doc.numPages > maxPages) notes.push(`Only the first ${maxPages} pages were indexed.`);
    if (!text.trim()) notes.push('This PDF has no text layer (it is probably a scan). Run it through OCR software and upload the result, or upload page images to use OCR here.');
    return { text, title: info.Title || undefined, author: info.Author || undefined, createdAt: pdfDate(info.CreationDate), modifiedAt: pdfDate(info.ModDate), documentType: 'PDF', status: text.trim() ? 'ok' : 'no_text', notes, pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}

/* ---------------- images (OCR) ---------------- */

/** @param {Buffer} buf @param {{enabled: boolean, lang: string, langPath: string}} ocr */
export async function extractImage(buf, ocr) {
  if (!ocr.enabled) return { text: '', documentType: 'Image', status: 'ocr_unavailable', notes: ['OCR is switched off (OCR_ENABLED=false). The image was stored but its text is not searchable.'] };
  let Tesseract;
  try { Tesseract = (await import('tesseract.js')).default; } catch {
    return { text: '', documentType: 'Image', status: 'ocr_unavailable', notes: ['OCR is not installed. Run "npm install tesseract.js" to make image text searchable.'] };
  }
  try {
    const options = ocr.langPath ? { langPath: ocr.langPath } : {};
    const worker = await Tesseract.createWorker(ocr.lang, 1, options);
    try {
      const { data } = await worker.recognize(buf);
      const text = String(data.text || '').trim();
      return { text, documentType: 'Image (OCR)', status: text ? 'ok' : 'no_text', notes: text ? [`Text read by OCR (confidence ${Math.round(data.confidence ?? 0)}%). Check important passages against the image.`] : ['OCR found no readable text.'] };
    } finally { await worker.terminate(); }
  } catch (err) {
    return { text: '', documentType: 'Image', status: 'ocr_unavailable', notes: [`OCR could not run: ${err instanceof Error ? err.message : 'unknown error'}. Language data is downloaded on first use unless OCR_LANG_PATH points to a local copy.`] };
  }
}

/* ---------------- dispatcher ---------------- */

/**
 * @param {string} filename @param {Buffer} buf
 * @param {{ocr: {enabled: boolean, lang: string, langPath: string}}} opts
 */
export async function extractFile(filename, buf, opts) {
  const { ext, ok } = detectType(filename, buf);
  if (!(ext in SUPPORTED)) {
    const err = new Error(`".${ext || 'unknown'}" files are not supported. Upload PDF, DOCX, XLSX, CSV, TXT or an image.`);
    /** @type {any} */ (err).code = 'unsupported_type';
    throw err;
  }
  if (!ok) {
    const err = new Error(`The file's contents don't match its .${ext} extension, so it was rejected.`);
    /** @type {any} */ (err).code = 'type_mismatch';
    throw err;
  }
  switch (ext) {
    case 'pdf': return extractPdf(buf);
    case 'docx': return extractDocx(buf);
    case 'xlsx': return extractXlsx(buf);
    case 'csv': return extractCsv(buf);
    case 'txt': case 'md': { const text = decodeText(buf); return { text, documentType: 'Text', status: text.trim() ? 'ok' : 'no_text', notes: [] }; }
    default: return extractImage(buf, opts.ocr);
  }
}
