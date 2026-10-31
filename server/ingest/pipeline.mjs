// @ts-check
/**
 * Source-independent ingestion: every connector hands normalized records to
 * upsertRecord(), which checksums, de-duplicates, chunks, indexes for full-text
 * search and queues chunks for embedding. Provenance (source, source record
 * id, URL) is kept on every record and each chunk points back to its record.
 */
import crypto from 'node:crypto';
import { nowIso, parseJson } from '../db.mjs';

const STOP = new Set('a an and are as at be been but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when where which who will with you your about after all also any can could did do does had how may more most no not now only other over said should some such up us very would'.split(' '));

/** @param {string} text */
export function keywordsOf(text, n = 12) {
  /** @type {Map<string, number>} */
  const tf = new Map();
  for (const t of (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])) if (!STOP.has(t)) tf.set(t, (tf.get(t) || 0) + 1);
  return [...tf.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([t]) => t);
}

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

/** Rule-based entity extraction: dates, emails, money, and capitalised names/places. */
export function extractEntities(text) {
  const sample = text.slice(0, 50000);
  const uniq = (xs, n = 25) => [...new Set(xs.map(x => x.trim()))].filter(Boolean).slice(0, n);
  return {
    dates: uniq([
      ...(sample.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []),
      ...(sample.match(new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, 'gi')) || []),
      ...(sample.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || [])
    ]),
    emails: uniq(sample.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []),
    money: uniq(sample.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) || []),
    names: uniq((sample.match(/\b(?:[A-Z][a-z]+(?:\s+(?:of|de|la|the)?\s*[A-Z][a-z]+){1,3})\b/g) || []).filter(n => !/^(The|This|That|Dear|Thanks|Regards)\b/.test(n)), 40)
  };
}

/**
 * Split text into overlapping chunks on sentence/paragraph boundaries.
 * @returns {{text: string, start: number, end: number}[]}
 */
export function chunkText(text, size = 1200, overlap = 200) {
  const clean = text.replace(/\u0000/g, '');
  if (clean.length <= size) return clean.trim() ? [{ text: clean, start: 0, end: clean.length }] : [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size * 0.6), end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (cut > 0) end = start + Math.floor(size * 0.6) + cut + 1;
    }
    const piece = clean.slice(start, end);
    if (piece.trim()) chunks.push({ text: piece, start, end });
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export const checksumOf = (title, content) => crypto.createHash('sha256').update(`${title}\u0000${content}`).digest('hex');

/**
 * @typedef {{
 *   sourceRecordId: string, title: string, content: string, sender?: string | null, recipients?: string[],
 *   createdAt?: string | null, modifiedAt?: string | null, department?: string | null, documentType?: string | null,
 *   sourceUrl?: string | null, accessPermissions?: Record<string, unknown>, parentRecordId?: string | null, threadKey?: string | null,
 *   keywords?: string[]
 * }} NormalizedRecord
 */

/**
 * Insert or update a record. Returns what happened so sync jobs can report counts.
 * @param {import('../db.mjs').Database} db
 * @param {{tenantId: string, sourceId: string, sourceType: string, isSynthetic?: boolean}} ctx
 * @param {NormalizedRecord} rec
 * @returns {{status: 'added' | 'updated' | 'unchanged', id: string}}
 */
export function upsertRecord(db, ctx, rec) {
  const title = String(rec.title || 'Untitled').slice(0, 500);
  const content = String(rec.content || '').slice(0, 2_000_000);
  const checksum = checksumOf(title, content);
  const existing = db.get('SELECT id, checksum FROM records WHERE source_id = ? AND source_record_id = ?', ctx.sourceId, rec.sourceRecordId);
  if (existing && existing.checksum === checksum) return { status: 'unchanged', id: existing.id };

  return db.tx(() => {
    const id = existing?.id ?? crypto.randomUUID();
    // Exact duplicate of another record in the same tenant and mode (e.g. the same attachment in two emails).
    const dup = db.get('SELECT id FROM records WHERE tenant_id = ? AND checksum = ? AND id != ? AND is_synthetic = ? ORDER BY ingestion_timestamp LIMIT 1',
      ctx.tenantId, checksum, id, ctx.isSynthetic ? 1 : 0);
    const values = [
      title, content, rec.sender ?? null, JSON.stringify(rec.recipients ?? []), toIso(rec.createdAt), toIso(rec.modifiedAt),
      rec.department ?? null, rec.documentType ?? null, JSON.stringify(rec.keywords ?? keywordsOf(`${title} ${content}`)),
      JSON.stringify(extractEntities(`${title}\n${content}`)), JSON.stringify(rec.accessPermissions ?? {}), rec.sourceUrl ?? null,
      rec.parentRecordId ?? null, rec.threadKey ?? null, checksum, dup?.id ?? null, nowIso()
    ];
    if (existing) {
      removeChunks(db, id);
      db.run(`UPDATE records SET title=?, content=?, sender=?, recipients=?, created_at=?, modified_at=?, department=?, document_type=?, keywords=?,
        extracted_entities=?, access_permissions=?, source_url=?, parent_record_id=?, thread_key=?, checksum=?, duplicate_of=?, ingestion_timestamp=? WHERE id=?`, ...values, id);
    } else {
      db.run(`INSERT INTO records (title, content, sender, recipients, created_at, modified_at, department, document_type, keywords,
        extracted_entities, access_permissions, source_url, parent_record_id, thread_key, checksum, duplicate_of, ingestion_timestamp,
        id, tenant_id, source_id, source_type, source_record_id, is_synthetic) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...values, id, ctx.tenantId, ctx.sourceId, ctx.sourceType, rec.sourceRecordId, ctx.isSynthetic ? 1 : 0);
    }
    const chunks = chunkText(content || title);
    chunks.forEach((c, i) => {
      const r = db.run('INSERT INTO chunks (record_id, tenant_id, ordinal, text, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?)', id, ctx.tenantId, i, c.text, c.start, c.end);
      db.run('INSERT INTO chunk_fts (rowid, title, text) VALUES (?, ?, ?)', Number(r.lastInsertRowid), i === 0 ? title : '', c.text);
    });
    if (!chunks.length) {
      const r = db.run('INSERT INTO chunks (record_id, tenant_id, ordinal, text, start_offset, end_offset) VALUES (?, ?, 0, ?, 0, 0)', id, ctx.tenantId, '');
      db.run('INSERT INTO chunk_fts (rowid, title, text) VALUES (?, ?, ?)', Number(r.lastInsertRowid), title, '');
    }
    return { status: existing ? 'updated' : 'added', id };
  });
}

function toIso(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** FTS rows are not covered by foreign keys, so remove them explicitly. */
function removeChunks(db, recordId) {
  db.run('DELETE FROM chunk_fts WHERE rowid IN (SELECT id FROM chunks WHERE record_id = ?)', recordId);
  db.run('DELETE FROM chunks WHERE record_id = ?', recordId);
}

/** Delete one record and everything derived from it (chunks, full-text rows, embeddings). */
export function deleteRecord(db, recordId) {
  db.tx(() => {
    removeChunks(db, recordId);
    db.run('UPDATE records SET duplicate_of = NULL WHERE duplicate_of = ?', recordId);
    db.run('DELETE FROM records WHERE id = ?', recordId);
  });
}

/** Delete records of a source; optionally only those whose source ids are not in keepIds. */
export function deleteSourceRecords(db, sourceId, { where = '', params = [] } = {}) {
  const ids = db.all(`SELECT id FROM records WHERE source_id = ? ${where}`, sourceId, ...params).map(r => r.id);
  db.tx(() => { for (const id of ids) deleteRecord(db, id); });
  return ids.length;
}

/* ---------------- embeddings ---------------- */

export const toBlob = (vec) => Buffer.from(new Float32Array(vec).buffer);
export const fromBlob = (blob) => new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);

/**
 * Embed chunks that don't have a vector yet (or were made with another model).
 * @param {import('../db.mjs').Database} db
 * @param {{model: string, embed: (texts: string[], kind: 'document' | 'query') => Promise<number[][]>} | null} embedder
 * @param {string} tenantId
 */
export async function embedPending(db, embedder, tenantId, { batchSize = 64, max = 5000 } = {}) {
  if (!embedder) return 0;
  let done = 0;
  while (done < max) {
    const rows = db.all(`SELECT c.id, r.title, c.text FROM chunks c JOIN records r ON r.id = c.record_id
      LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model = ? WHERE c.tenant_id = ? AND e.chunk_id IS NULL AND length(c.text) > 0 LIMIT ?`,
    embedder.model, tenantId, batchSize);
    if (!rows.length) break;
    const vectors = await embedder.embed(rows.map(r => `${r.title}\n${r.text}`.slice(0, 8000)), 'document');
    db.tx(() => rows.forEach((r, i) => {
      const v = vectors[i];
      if (!Array.isArray(v) || !v.length) return;
      db.run('INSERT OR REPLACE INTO embeddings (chunk_id, model, dims, vector) VALUES (?, ?, ?, ?)', r.id, embedder.model, v.length, toBlob(normalize(v)));
    }));
    done += rows.length;
  }
  return done;
}

export function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

/** Record JSON columns parsed for API output. */
export function recordView(row, { includeContent = false } = {}) {
  return {
    id: row.id, sourceId: row.source_id, sourceType: row.source_type, sourceRecordId: row.source_record_id, isSynthetic: Boolean(row.is_synthetic),
    title: row.title, sender: row.sender, recipients: parseJson(row.recipients, []), createdAt: row.created_at, modifiedAt: row.modified_at,
    department: row.department, documentType: row.document_type, keywords: parseJson(row.keywords, []), entities: parseJson(row.extracted_entities, {}),
    sourceUrl: row.source_url, checksum: row.checksum, duplicateOf: row.duplicate_of, threadKey: row.thread_key, ingestedAt: row.ingestion_timestamp,
    ...(includeContent ? { content: row.content } : {})
  };
}
