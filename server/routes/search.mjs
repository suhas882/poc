// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, ok, pageParams, readJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { accessFilter } from '../search/hybrid.mjs';
import { recordView } from '../ingest/pipeline.mjs';
import { applyConsent, consentRequired, getConsent } from '../consent.mjs';

const MIME = { '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp' };

/** Sources this user can search in a mode (used to scope plans). */
export function searchableSources(db, user, mode) {
  const rows = db.all(`SELECT s.id, s.name, s.type FROM sources s WHERE s.tenant_id = ? AND s.status != 'disconnected' AND (s.type = 'synthetic' OR COALESCE(json_extract(s.config, '$.publicDocs'), 0) = 1) = ?
    AND ((s.visibility = 'owner' AND s.owner_user_id = ?) OR (s.visibility = 'roles' AND (s.allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(s.allowed_roles) WHERE value = ?))))
    ORDER BY s.name`, user.tenantId, mode === 'demo' ? 1 : 0, user.id, user.role);
  return mode === 'real' ? applyConsent(db, user, rows) : rows;
}

export function requireConsent(db, user, mode) {
  if (mode === 'real' && consentRequired(db, user)) throw new HttpError(428, 'consent_required', 'Before searching real records, choose what this app may search for you on the permission screen.');
}

export function loadSearch(db, user, id, { needResults = false } = {}) {
  const row = db.get('SELECT q.*, u.name AS user_name FROM search_requests q LEFT JOIN users u ON u.id = q.user_id WHERE q.id = ? AND q.tenant_id = ?', id, user.tenantId);
  if (!row) throw new HttpError(404, 'not_found', 'That search does not exist (it may have been removed by the retention policy).');
  const own = row.user_id === user.id;
  if (!own && !can(user, 'history.read_all')) throw new HttpError(403, 'forbidden', 'You can only open your own searches.');
  if (needResults && !can(user, 'records.read')) throw new HttpError(403, 'forbidden', 'Your role can see search history but not the records themselves.');
  return { row, own };
}

/** @param {import('../http.mjs').Router} router */
export function registerSearchRoutes(router, s) {
  const { db, audit } = s;

  /* ---- records ---- */

  function loadReadableRecord(user, id) {
    const rec = db.get('SELECT is_synthetic FROM records WHERE id = ? AND tenant_id = ?', id, user.tenantId);
    if (!rec) throw new HttpError(404, 'not_found', 'That record does not exist or you do not have access to it.');
    const acl = accessFilter(user, rec.is_synthetic ? 'demo' : 'real');
    const row = db.get(`SELECT r.*, s.name AS source_name FROM records r JOIN sources s ON s.id = r.source_id WHERE r.id = ? AND ${acl.sql}`, id, ...acl.params);
    if (!row) throw new HttpError(404, 'not_found', 'That record does not exist or you do not have access to it.');
    return row;
  }

  router.on('GET', '/api/records/:id', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'records.read');
    const row = loadReadableRecord(user, params.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'record.viewed', targetType: 'record', targetId: row.id, ipHash, details: { sourceType: row.source_type } });
    const parent = row.parent_record_id ? db.get('SELECT id, title FROM records WHERE id = ?', row.parent_record_id) : null;
    const related = row.thread_key ? db.all('SELECT id, title, created_at AS createdAt FROM records WHERE tenant_id = ? AND thread_key = ? AND id != ? ORDER BY created_at LIMIT 20', user.tenantId, row.thread_key, row.id) : [];
    ok(res, { ...recordView(row, { includeContent: true }), sourceName: row.source_name, parent, related });
  });

  router.on('GET', '/api/records/:id/original', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'records.read');
    const row = loadReadableRecord(user, params.id);
    if (row.source_type !== 'uploads') throw new HttpError(404, 'no_original', 'Only uploaded files have a stored original. Use the source link instead.');
    const file = parseJson(row.extracted_entities, {}).file || {};
    const p = path.join(s.config.dataDir, 'uploads', row.tenant_id, row.source_id, `${row.source_record_id}${file.ext || ''}`);
    if (!fs.existsSync(p)) throw new HttpError(404, 'missing_original', 'The original file is no longer stored.');
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'record.viewed', targetType: 'record', targetId: row.id, ipHash, details: { original: true } });
    const safeName = String(file.name || 'document').replace(/["\\\r\n]/g, '_');
    res.writeHead(200, { 'Content-Type': MIME[file.ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${safeName}"`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    fs.createReadStream(p).pipe(res);
  });

}
