// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, ok, pageParams, readBody, readJson, sendJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission, ROLES } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { deleteRecord, deleteSourceRecords, embedPending, recordView, upsertRecord } from '../ingest/pipeline.mjs';
import { extractFile, SUPPORTED } from '../ingest/extract.mjs';
import { groupConversations, parseMessages } from '../ingest/messages.mjs';
import { checkMapping, DIALECTS } from '../connectors/database.mjs';
import { GMAIL_SCOPE } from '../connectors/gmail.mjs';
import { isPhoneLink } from '../connectors/phonelink.mjs';
import { activePack, switches } from '../packs.mjs';

const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
import { accessFilter } from '../search/hybrid.mjs';
import { ROOT } from '../config.mjs';

const hasModule = (m) => fs.existsSync(path.join(ROOT, 'node_modules', m));

/** What can be connected, and honestly whether it works on this server. */
export function connectorCatalog(s, user) {
  const tier0 = !s.config.realSources || Boolean(s.db.get('SELECT is_demo FROM tenants WHERE id = ?', user.tenantId)?.is_demo);
  const pack = activePack(s.db, user.tenantId);
  const sw = switches(s.db, user.tenantId, s.config);
  const publicDocs = { type: 'public', name: 'Public documents', description: 'Openly published documents only (Tier 0). Each file needs its web address, retrieval date and a terms-of-use check.', permissions: ['Only the files you add, with their provenance'], status: 'available' };
  const stubs = pack.sources.map(st => ({ type: 'stub', key: st.key, name: st.name, description: `Would read: ${st.sees}. Read-only.`, permissions: [], status: 'not_connected', note: st.note }));
  if (tier0) return [publicDocs, ...stubs];
  return [...fullCatalog(s).filter(c => !['google_drive', 'onedrive', 'sharepoint', 'outlook'].includes(c.type)).filter(c => c.type !== 'phonelink' || sw.phoneLink).map(c => c.type === 'phonelink' ? { ...c, experimental: true } : c), publicDocs, ...stubs];
}

function fullCatalog(s) {
  const st = (ready, reason) => ready ? { status: 'available' } : { status: 'needs_configuration', reason };
  return [
    { type: 'gmail', name: 'Gmail', description: 'Read-only access to one mailbox through Google sign-in. Attachments in supported formats are indexed too.', permissions: ['Read email messages and attachments (gmail.readonly)'], ...st(s.gmail.configured && s.vault, !s.gmail.configured ? 'An administrator needs to add Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).' : 'Credential encryption key is missing.') },
    { type: 'uploads', name: 'Document uploads', description: 'Upload PDF, Word, Excel, CSV, text files and images (OCR). On a phone, use the file picker to choose exported files.', permissions: ['Only the files you choose'], status: 'available' },
    { type: 'phonelink', name: 'Android texts (Phone Link)', description: 'Reads the texts your Android phone already syncs to Windows Phone Link on this PC, with no export. New texts are picked up automatically.', permissions: ['Read Phone Link’s copy of your texts, read-only', 'Nothing is sent from or changed on your phone'], status: 'available', local: s.phonelink.available, note: s.phonelink.available ? 'On a hosted server (Render, AWS), use the PC sync helper instead.' : 'This server is not on your PC, so it uses the PC sync helper: a small program on your Windows PC that sends new texts here.' },
    { type: 'messages', name: 'Message imports', description: 'Import message exports you create yourself: Android SMS Backup & Restore XML, WhatsApp “Export chat” text, or CSV.', permissions: ['Only the export files you choose'], status: 'available', note: 'For Android texts without exporting, use Android texts (Phone Link) above. WhatsApp and iPhone messages still need an export.' },
    { type: 'database', driver: 'postgres', name: 'PostgreSQL', description: 'Read-only, allowlisted tables and columns.', permissions: ['SELECT on allowlisted tables'], ...st(hasModule('pg'), 'The PostgreSQL driver is not installed (npm install pg).') },
    { type: 'database', driver: 'mysql', name: 'MySQL', description: 'Read-only, allowlisted tables and columns.', permissions: ['SELECT on allowlisted tables'], ...st(hasModule('mysql2'), 'The MySQL driver is not installed (npm install mysql2).') },
    { type: 'database', driver: 'sqlite', name: 'SQLite file', description: 'Read-only access to a SQLite file placed in the server’s connector folder.', permissions: ['Read the chosen file'], status: 'available' },
    { type: 'google_drive', name: 'Google Drive', description: 'Planned. Not built yet.', permissions: [], status: 'planned' },
    { type: 'onedrive', name: 'Microsoft OneDrive', description: 'Planned. Not built yet.', permissions: [], status: 'planned' },
    { type: 'sharepoint', name: 'SharePoint', description: 'Planned. Not built yet.', permissions: [], status: 'planned' },
    { type: 'outlook', name: 'Outlook mail', description: 'Planned. Not built yet.', permissions: [], status: 'planned' }
  ];
}

/** Sources this user can see: everything shared with them, everything they own, and (for admins) every source in the tenant. */
function visibleSources(db, user) {
  return db.all(`SELECT s.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM records r WHERE r.source_id = s.id) AS record_count,
      (SELECT COUNT(*) FROM records r WHERE r.source_id = s.id AND r.duplicate_of IS NOT NULL) AS duplicate_count
    FROM sources s LEFT JOIN users u ON u.id = s.owner_user_id
    WHERE s.tenant_id = ? AND (? = 1 OR s.owner_user_id = ? OR (s.visibility = 'roles' AND (s.allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(s.allowed_roles) WHERE value = ?))))
    ORDER BY s.type = 'synthetic', s.created_at`, user.tenantId, user.role === 'admin' ? 1 : 0, user.id, user.role);
}

function sourceView(row, user, running) {
  const cfg = parseJson(row.config, {});
  const repositories = row.type === 'gmail' ? [{ name: cfg.query ? `Messages matching “${cfg.query}”` : 'All mail except spam and trash', kind: 'gmail_query' }]
    : isPhoneLink(row) ? [{ name: 'Texts synced by Phone Link on this PC', kind: 'phonelink' }]
    : cfg.provider === 'phonelink-agent' ? [{ name: 'Texts sent by the PC sync helper', kind: 'phonelink-agent' }]
    : row.type === 'database' ? (cfg.tables || []).map(t => ({ name: t.name, kind: 'table', columns: [t.idColumn, t.titleColumn, ...(t.contentColumns || [])] }))
    : [];
  return {
    id: row.id, type: row.type, name: row.name, status: running ? 'syncing' : row.status, accountLabel: row.account_label,
    owner: row.owner_user_id ? { id: row.owner_user_id, name: row.owner_name } : null, isOwner: row.owner_user_id === user.id,
    canManage: row.type !== 'synthetic' && (user.role === 'admin' || (row.owner_user_id === user.id && can(user, 'sources.manage'))),
    visibility: row.visibility, allowedRoles: parseJson(row.allowed_roles, []), scopes: parseJson(row.scopes, []),
    driver: cfg.driver ?? null, provider: cfg.provider ?? null, repositories, recordCount: row.record_count, duplicateCount: row.duplicate_count,
    lastSyncAt: row.last_sync_at, lastSyncStatus: row.last_sync_status, lastError: row.last_error, createdAt: row.created_at,
    isSynthetic: row.type === 'synthetic', publicDocs: cfg.publicDocs === 1, experimental: String(cfg.provider || '').startsWith('phonelink'), readOnly: true
  };
}

function loadManageable(s, user, id) {
  const row = s.db.get('SELECT * FROM sources WHERE id = ? AND tenant_id = ?', id, user.tenantId);
  if (!row) throw new HttpError(404, 'not_found', 'That source does not exist.');
  if (row.type === 'synthetic') throw new HttpError(403, 'forbidden', 'The synthetic demo source cannot be changed.');
  if (!(user.role === 'admin' || (row.owner_user_id === user.id && can(user, 'sources.manage')))) throw new HttpError(403, 'forbidden', 'Only the person who connected this source, or an administrator, can change it.');
  return row;
}

/** Run a sync in the background; returns the job id immediately. */
export function startSync(s, source, user, trigger, { full = false } = {}) {
  if (s.running.has(source.id)) throw new HttpError(409, 'sync_running', 'This source is already synchronizing.');
  const jobId = crypto.randomUUID();
  s.db.run("INSERT INTO sync_jobs (id, tenant_id, source_id, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)", jobId, source.tenant_id, source.id, trigger, nowIso());
  const promise = (async () => {
    try {
      const counts = source.type === 'gmail' ? await s.gmail.sync(source, { full })
        : source.type === 'database' ? await s.database.sync(source)
        : isPhoneLink(source) ? s.phonelink.sync(source)
        : (() => { throw new HttpError(400, 'not_syncable', 'This source is updated by uploading files, not by synchronizing.'); })();
      let embedded = 0, embedError = null;
      try { embedded = await embedPending(s.db, s.embedder, source.tenant_id); } catch (err) { embedError = err instanceof Error ? err.message : String(err); }
      s.db.run("UPDATE sync_jobs SET status = 'succeeded', finished_at = ?, added = ?, updated = ?, deleted = ?, skipped = ?, error = ? WHERE id = ?",
        nowIso(), counts.added, counts.updated, counts.deleted, counts.skipped, counts.truncated ? 'Stopped at the per-sync limit; run it again to continue.' : embedError ? `Indexed for keyword search; semantic indexing failed: ${embedError}` : null, jobId);
      s.db.run("UPDATE sources SET status = 'connected', last_sync_at = ?, last_sync_status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?", nowIso(), nowIso(), source.id);
      s.audit.write({ tenantId: source.tenant_id, userId: user?.id, action: 'source.synced', targetType: 'source', targetId: source.id, details: { ...counts, embedded, trigger } });
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'The synchronization failed unexpectedly. Details are in the server log.';
      if (!(err instanceof HttpError)) s.log('[sync] failed:', err);
      s.db.run("UPDATE sync_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", nowIso(), message, jobId);
      s.db.run("UPDATE sources SET status = 'needs_attention', last_sync_at = ?, last_sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", nowIso(), message, nowIso(), source.id);
      s.audit.write({ tenantId: source.tenant_id, userId: user?.id, action: 'source.synced', targetType: 'source', targetId: source.id, outcome: 'failure', details: { error: message, trigger } });
    } finally {
      s.running.delete(source.id);
    }
  })();
  s.running.set(source.id, promise);
  return jobId;
}

/** Remove a source completely: revoke at the provider, delete credentials, records, files and the source row. */
async function removeSource(s, row, user, ipHash) {
  let revoked = null;
  if (row.type === 'gmail') revoked = (await s.gmail.disconnect(row)).revoked;
  const removed = deleteSourceRecords(s.db, row.id);
  const dir = path.join(s.config.dataDir, 'uploads', row.tenant_id, row.id);
  fs.rmSync(dir, { recursive: true, force: true });
  s.db.run('DELETE FROM source_credentials WHERE source_id = ?', row.id);
  s.db.run('DELETE FROM sources WHERE id = ?', row.id);
  s.audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.disconnected', targetType: 'source', targetId: row.id, ipHash, details: { type: row.type, name: row.name, recordsDeleted: removed, revokedAtProvider: revoked } });
  return { recordsDeleted: removed, revokedAtProvider: revoked };
}

const roleList = { type: 'array', items: { type: 'string', values: ROLES }, max: 4 };

/** @param {import('../http.mjs').Router} router */
export function registerSourceRoutes(router, s) {
  const { db, audit, config } = s;

  router.on('GET', '/api/connectors', ({ res, user }) => { requirePermission(user, 'sources.read'); ok(res, connectorCatalog(s, user)); });

  /** Real sources are refused unless the server has REAL_SOURCES=true and this is not a demo organization. */
  const realGate = (user) => {
    if (!config.realSources || db.get('SELECT is_demo FROM tenants WHERE id = ?', user.tenantId)?.is_demo) {
      throw new HttpError(403, 'real_sources_off', 'Real sources are switched off on this server. It only holds Tier 0 data: invented records and public documents.');
    }
  };
  s.realGate = realGate;

  router.on('GET', '/api/sources', ({ res, user }) => {
    requirePermission(user, 'sources.read');
    const phoneOn = switches(db, user.tenantId, config).phoneLink;
    // Phone Link sources stay hidden while the switch is off.
    ok(res, visibleSources(db, user).filter(r => phoneOn || !String(parseJson(r.config, {}).provider || '').startsWith('phonelink')).map(r => sourceView(r, user, s.running.has(r.id))));
  });

  router.on('GET', '/api/sources/:id/jobs', ({ res, user, params }) => {
    requirePermission(user, 'sources.read');
    if (!visibleSources(db, user).some(r => r.id === params.id)) throw new HttpError(404, 'not_found', 'That source does not exist.');
    ok(res, db.all('SELECT id, trigger, status, started_at AS startedAt, finished_at AS finishedAt, added, updated, deleted, skipped, error FROM sync_jobs WHERE source_id = ? ORDER BY started_at DESC LIMIT 20', params.id));
  });

  router.on('PATCH', '/api/sources/:id', async ({ req, res, user, params, ipHash }) => {
    requirePermission(user, 'sources.manage');
    const row = loadManageable(s, user, params.id);
    const body = validate({ name: { type: 'string', max: 120 }, visibility: { type: 'string', values: ['owner', 'roles'] }, allowedRoles: roleList, query: { type: 'string', max: 500 } }, await readJson(req));
    const cfg = parseJson(row.config, {});
    if (body.query !== undefined && row.type === 'gmail') cfg.query = body.query;
    db.run('UPDATE sources SET name = COALESCE(?, name), visibility = COALESCE(?, visibility), allowed_roles = COALESCE(?, allowed_roles), config = ?, updated_at = ? WHERE id = ?',
      body.name ?? null, body.visibility ?? null, body.allowedRoles ? JSON.stringify(body.allowedRoles) : null, JSON.stringify(cfg), nowIso(), row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.updated', targetType: 'source', targetId: row.id, ipHash, details: { visibility: body.visibility, allowedRoles: body.allowedRoles, queryChanged: body.query !== undefined } });
    ok(res, sourceView({ ...db.get('SELECT s.*, u.name AS owner_name FROM sources s LEFT JOIN users u ON u.id = s.owner_user_id WHERE s.id = ?', row.id), record_count: db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', row.id).n, duplicate_count: 0 }, user, false));
  });

  /* ---- Phone Link (Android texts on this PC) ---- */
  const phoneLinkGate = (user, ip) => {
    requirePermission(user, 'sources.manage');
    realGate(user);
    if (!switches(db, user.tenantId, config).phoneLink) throw new HttpError(403, 'phonelink_off', 'Phone Link texts are experimental and switched off. A Supervisor can turn them on in Settings.');
    // Texts on this PC belong to whoever uses it, so only someone sitting at it may connect them.
    if (!isLoopback(ip)) throw new HttpError(403, 'phonelink_local_only', 'Connect Phone Link from the PC where it runs (open the app at http://localhost there).');
  };
  router.on('GET', '/api/connectors/phonelink/check', ({ res, user, ip }) => {
    phoneLinkGate(user, ip);
    ok(res, s.phonelink.check());
  });
  router.on('POST', '/api/connectors/phonelink/connect', async ({ req, res, user, ip, ipHash }) => {
    phoneLinkGate(user, ip);
    const body = validate({ acknowledged: { type: 'bool', required: true } }, await readJson(req));
    if (body.acknowledged !== true) throw new HttpError(400, 'not_acknowledged', 'Confirm that these are your own texts and that you may index them.');
    const existing = db.all("SELECT * FROM sources WHERE tenant_id = ? AND owner_user_id = ? AND type = 'messages' AND status != 'disconnected'", user.tenantId, user.id).find(isPhoneLink);
    if (existing) throw new HttpError(409, 'already_connected', 'Phone Link is already connected for you. Use Sync now on its card.');
    const check = s.phonelink.check();
    if (!check.found || !check.recognized) throw new HttpError(409, 'phonelink_not_ready', check.reason || 'Phone Link is not ready on this PC.');
    const id = crypto.randomUUID();
    db.run(`INSERT INTO sources (id, tenant_id, owner_user_id, type, name, status, visibility, allowed_roles, scopes, config, account_label, created_at, updated_at)
      VALUES (?, ?, ?, 'messages', ?, 'connected', 'owner', '[]', ?, ?, ?, ?, ?)`, id, user.tenantId, user.id, `Android texts (${user.name})`,
      JSON.stringify(['phonelink.read']), JSON.stringify({ provider: 'phonelink' }), 'Phone Link on this PC', nowIso(), nowIso());
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: id, ipHash, details: { type: 'phonelink', messages: check.messages } });
    const jobId = startSync(s, db.get('SELECT * FROM sources WHERE id = ?', id), user, 'initial');
    ok(res, { sourceId: id, jobId }, undefined, 201);
  });

  router.on('POST', '/api/sources/:id/sync', async ({ req, res, user, params }) => {
    requirePermission(user, 'sources.manage');
    const row = loadManageable(s, user, params.id);
    const body = req.headers['content-type']?.includes('json') ? validate({ full: { type: 'bool', default: false } }, await readJson(req)) : { full: false };
    const jobId = startSync(s, row, user, 'manual', { full: body.full });
    ok(res, { jobId }, undefined, 202);
  });

  router.on('DELETE', '/api/sources/:id', async ({ res, user, params, ipHash }) => {
    requirePermission(user, 'sources.manage');
    const row = loadManageable(s, user, params.id);
    if (s.running.has(row.id)) throw new HttpError(409, 'sync_running', 'Wait for the current synchronization to finish, then disconnect.');
    ok(res, await removeSource(s, row, user, ipHash));
  });

  /* ---- Gmail OAuth ---- */

  router.on('POST', '/api/connectors/gmail/authorize', async ({ req, res, user, ipHash }) => {
    if (user) realGate(user);
    requirePermission(user, 'sources.manage');
    const body = validate({ query: { type: 'string', max: 500, default: config.gmail.defaultQuery }, shareWithRoles: { ...roleList, default: [] } }, await readJson(req));
    const result = s.gmail.authorize(user, body);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.oauth_started', targetType: 'connector', targetId: 'gmail', ipHash, details: { scopes: result.scopes } });
    ok(res, result);
  });

  router.on('GET', '/oauth/google/callback', async ({ res, url, user, ipHash }) => {
    const redirect = (q) => { res.writeHead(302, { Location: `/sources.html?${new URLSearchParams(q)}`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); };
    if (!user) return redirect({ error: 'Your session ended before Google finished. Sign in and connect Gmail again.' });
    try {
      requirePermission(user, 'sources.manage');
      const result = await s.gmail.handleCallback(user, Object.fromEntries(url.searchParams));
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: result.sourceId, ipHash, details: { type: 'gmail', reconnected: result.reconnected, scopes: [GMAIL_SCOPE] } });
      const row = db.get('SELECT * FROM sources WHERE id = ?', result.sourceId);
      if (!s.running.has(row.id)) startSync(s, row, user, result.reconnected ? 'reconnect' : 'initial');
      redirect({ connected: result.sourceId });
    } catch (err) {
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'connector', targetId: 'gmail', outcome: 'failure', ipHash, details: { code: err instanceof HttpError ? err.code : 'error' } });
      if (!(err instanceof HttpError)) s.log('[gmail] callback failed:', err);
      redirect({ error: err instanceof HttpError ? err.message : 'Connecting Gmail failed. Try again.' });
    }
  });

  /* ---- Uploads and message imports ---- */

  /** One shared "Public documents" source per organization: Tier 0 data, searched with the demo corpus. */
  function publicCollection(user) {
    let row = db.get("SELECT * FROM sources WHERE tenant_id = ? AND type = 'uploads' AND json_extract(config, '$.publicDocs') = 1", user.tenantId);
    if (!row) {
      const id = crypto.randomUUID();
      db.run(`INSERT INTO sources (id, tenant_id, type, name, owner_user_id, visibility, allowed_roles, config, account_label) VALUES (?, ?, 'uploads', 'Public documents', ?, 'roles', '[]', '{"publicDocs": 1}', 'Openly published documents')`, id, user.tenantId, user.id);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: id, details: { type: 'public documents' } });
      row = db.get('SELECT * FROM sources WHERE id = ?', id);
    }
    return row;
  }

  function defaultCollection(user, type) {
    const name = type === 'uploads' ? 'Uploaded documents' : 'Imported messages';
    let row = db.get("SELECT * FROM sources WHERE tenant_id = ? AND type = ? AND owner_user_id = ? AND json_extract(config, '$.provider') IS NULL AND json_extract(config, '$.publicDocs') IS NULL ORDER BY created_at LIMIT 1", user.tenantId, type, user.id);
    if (!row) {
      const id = crypto.randomUUID();
      db.run("INSERT INTO sources (id, tenant_id, type, name, owner_user_id, visibility, allowed_roles, account_label) VALUES (?, ?, ?, ?, ?, 'owner', '[]', ?)", id, user.tenantId, type, `${name} (${user.name})`, user.id, user.email);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: id, details: { type } });
      row = db.get('SELECT * FROM sources WHERE id = ?', id);
    }
    return row;
  }

  router.on('POST', '/api/uploads', async ({ req, res, user, url, ipHash }) => {
    requirePermission(user, 'uploads.create');
    const requested = url.searchParams.get('kind');
    const isPublic = requested === 'public';
    const kind = requested === 'messages' ? 'messages' : 'uploads';
    let provenance = null;
    if (isPublic) {
      const src = String(req.headers['x-source-url'] || ''), got = String(req.headers['x-retrieved-at'] || ''), terms = String(req.headers['x-terms-checked'] || '');
      let okUrl = false; try { okUrl = ['http:', 'https:'].includes(new URL(src).protocol); } catch { /* invalid */ }
      if (!okUrl) throw new HttpError(400, 'missing_url', 'Give the public web address the document was downloaded from.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(got) || Number.isNaN(Date.parse(got))) throw new HttpError(400, 'missing_date', 'Give the retrieval date (YYYY-MM-DD).');
      if (terms !== 'yes') throw new HttpError(400, 'terms_not_checked', 'Confirm that the site’s terms of use allow this use before adding the document.');
      provenance = { kind: 'public', url: src, retrievedAt: got, termsChecked: true, addedBy: user.name };
    } else {
      realGate(user);
    }
    let filename = '';
    try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { /* fall through */ }
    filename = path.basename(filename).replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 180);
    if (!filename || filename.startsWith('.')) throw new HttpError(400, 'missing_filename', 'Send the file name in the X-File-Name header.');
    const sourceId = url.searchParams.get('sourceId');
    const source = isPublic ? publicCollection(user) : sourceId ? loadManageable(s, user, sourceId) : defaultCollection(user, kind);
    if (isPhoneLink(source) || parseJson(source.config, {}).provider === 'phonelink-agent') throw new HttpError(400, 'wrong_source', 'Phone Link texts update by themselves. Import message exports into a message import source instead.');
    if (source.type !== kind) throw new HttpError(400, 'wrong_source', kind === 'messages' ? 'Message exports go into a message import source.' : 'Documents go into an upload source.');
    const buf = await readBody(req, config.uploads.maxBytes);
    if (!buf.length) throw new HttpError(400, 'empty_file', 'The file is empty.');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const ctx = { tenantId: user.tenantId, sourceId: source.id, sourceType: kind, isSynthetic: isPublic };

    if (kind === 'messages') {
      let parsed;
      try { parsed = parseMessages(filename, buf); } catch (err) { throw new HttpError(415, 'unsupported_export', err instanceof Error ? err.message : 'Unsupported export.'); }
      const groups = groupConversations(parsed.messages, parsed.format === 'whatsapp-txt' ? 'WhatsApp' : parsed.format === 'sms-backup-xml' ? 'SMS' : 'Messages');
      const counts = { added: 0, updated: 0, unchanged: 0 };
      for (const g of groups) counts[upsertRecord(db, ctx, { ...g, accessPermissions: {} }).status]++;
      await embedPending(db, s.embedder, user.tenantId).catch(() => 0);
      db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded', status = 'connected' WHERE id = ?", nowIso(), source.id);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'upload.ingested', targetType: 'source', targetId: source.id, ipHash, details: { kind, format: parsed.format, messages: parsed.messages.length, conversations: groups.length, bytes: buf.length } });
      return ok(res, { sourceId: source.id, format: parsed.format, messages: parsed.messages.length, conversationDays: groups.length, ...counts }, undefined, 201);
    }

    const already = db.get('SELECT id FROM records WHERE source_id = ? AND source_record_id = ?', source.id, sha);
    if (already) return ok(res, { sourceId: source.id, recordId: already.id, result: 'unchanged', extraction: 'skipped', characters: 0, notes: ['This exact file is already in this source.'] }, undefined, 200);
    let ex;
    try { ex = await extractFile(filename, buf, { ocr: config.ocr }); }
    catch (err) {
      const code = /** @type {any} */ (err)?.code;
      throw new HttpError(code === 'unsupported_type' || code === 'type_mismatch' ? 415 : 422, code || 'extraction_failed', err instanceof Error ? err.message : 'The file could not be read.');
    }
    // Keep the original so staff can open it later. Stored outside the web root, readable only through the API.
    const ext = path.extname(filename).toLowerCase();
    const dir = path.join(config.dataDir, 'uploads', user.tenantId, source.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sha}${ext}`), buf, { mode: 0o600 });
    const result = upsertRecord(db, ctx, {
      sourceRecordId: sha, title: ex.title?.trim() || filename, content: ex.text, sender: ex.author ?? null,
      createdAt: ex.createdAt ?? null, modifiedAt: ex.modifiedAt ?? null, documentType: ex.documentType,
      accessPermissions: {}, keywords: undefined
    });
    db.run('UPDATE records SET source_url = ? WHERE id = ?', provenance ? provenance.url : `/api/records/${result.id}/original`, result.id);
    if (provenance) db.run("UPDATE records SET extracted_entities = json_set(extracted_entities, '$.provenance', json(?)) WHERE id = ?", JSON.stringify(provenance), result.id);
    db.run("UPDATE records SET extracted_entities = json_set(extracted_entities, '$.file', json(?)) WHERE id = ?", JSON.stringify({ name: filename, bytes: buf.length, ext, status: ex.status, notes: ex.notes }), result.id);
    await embedPending(db, s.embedder, user.tenantId).catch(() => 0);
    db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded', status = 'connected' WHERE id = ?", nowIso(), source.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'upload.ingested', targetType: 'record', targetId: result.id, ipHash, details: { kind, type: SUPPORTED[ext.slice(1)]?.label, bytes: buf.length, status: ex.status, result: result.status } });
    ok(res, { sourceId: source.id, recordId: result.id, result: result.status, extraction: ex.status, characters: ex.text.length, notes: ex.notes }, undefined, 201);
  });

  router.on('GET', '/api/sources/:id/records', ({ res, user, params, url }) => {
    requirePermission(user, 'records.read');
    const synthetic = db.get("SELECT type FROM sources WHERE id = ? AND tenant_id = ?", params.id, user.tenantId)?.type === 'synthetic';
    const aclSql = accessFilter(user, synthetic ? 'demo' : 'real');
    const { page, size, offset } = pageParams(url, 25);
    const where = `FROM records r JOIN sources s ON s.id = r.source_id WHERE r.source_id = ? AND ${aclSql.sql}`;
    const total = db.get(`SELECT COUNT(*) AS n ${where}`, params.id, ...aclSql.params).n;
    const rows = db.all(`SELECT r.* ${where} ORDER BY r.ingestion_timestamp DESC LIMIT ? OFFSET ?`, params.id, ...aclSql.params, size, offset);
    ok(res, rows.map(r => recordView(r)), { page, pageSize: size, total });
  });

  /* ---- Databases ---- */

  const dbSpec = {
    name: { type: 'string', required: true, max: 120 }, driver: { type: 'string', required: true, values: DIALECTS },
    host: { type: 'string', max: 255 }, port: { type: 'int', min: 1, max: 65535 }, database: { type: 'string', max: 128 }, user: { type: 'string', max: 128 },
    password: { type: 'string', max: 512, trim: false }, connectionString: { type: 'string', max: 2000 }, ssl: { type: 'bool', default: false }, file: { type: 'string', max: 255 },
    tenantColumn: { type: 'string', max: 63 }, tenantValue: { type: 'string', max: 255 },
    tables: { type: 'array', max: 25, items: { type: 'object', fields: {
      name: { type: 'string', required: true, max: 63 }, label: { type: 'string', max: 80 }, idColumn: { type: 'string', required: true, max: 63 }, titleColumn: { type: 'string', required: true, max: 63 },
      contentColumns: { type: 'array', max: 20, items: { type: 'string', max: 63 }, default: [] }, dateColumn: { type: 'string', max: 63 }, departmentColumn: { type: 'string', max: 63 },
      typeColumn: { type: 'string', max: 63 }, urlTemplate: { type: 'string', max: 500, pattern: /^https:\/\//, patternMessage: 'must start with https://' }
    } } },
    shareWithRoles: { ...roleList, default: [] }
  };
  const splitDbBody = (b) => ({
    cfg: { driver: b.driver, host: b.host, port: b.port, database: b.database, user: b.user, ssl: b.ssl, file: b.file, tenantColumn: b.tenantColumn, tenantValue: b.tenantValue, tables: b.tables || [] },
    secret: { ...(b.password ? { password: b.password } : {}), ...(b.connectionString ? { connectionString: b.connectionString } : {}) }
  });

  router.on('POST', '/api/connectors/database/inspect', async ({ req, res, user }) => {
    if (user) realGate(user);
    requirePermission(user, 'sources.manage');
    const body = validate({ ...dbSpec, name: { type: 'string', max: 120, default: 'inspect' } }, await readJson(req));
    const { cfg, secret } = splitDbBody(body);
    try { ok(res, await s.database.inspect(cfg, secret)); }
    catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(502, 'connection_failed', `Could not connect: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}.`); }
  });

  router.on('POST', '/api/sources/database', async ({ req, res, user, ipHash }) => {
    if (user) realGate(user);
    requirePermission(user, 'sources.manage');
    const body = validate(dbSpec, await readJson(req));
    if (!body.tables?.length) throw new HttpError(400, 'no_tables', 'Choose at least one table to index.');
    const { cfg, secret } = splitDbBody(body);
    if (Object.keys(secret).length && !s.vault) throw new HttpError(503, 'encryption_not_configured', 'Set CREDENTIAL_ENCRYPTION_KEY before saving database passwords.');
    let columns;
    try { columns = await s.database.inspect(cfg, secret); }
    catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(502, 'connection_failed', `Could not connect: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}.`); }
    const problems = cfg.tables.flatMap(t => checkMapping(t, columns));
    if (cfg.tenantColumn) for (const t of cfg.tables) if (!columns.some(c => c.table === t.name && c.column === cfg.tenantColumn)) problems.push(`Tenant column "${cfg.tenantColumn}" is missing from "${t.name}".`);
    if (problems.length) throw new HttpError(400, 'mapping_invalid', problems.join(' '), { problems });
    const id = crypto.randomUUID();
    db.tx(() => {
      db.run(`INSERT INTO sources (id, tenant_id, type, name, owner_user_id, visibility, allowed_roles, config, scopes, account_label) VALUES (?, ?, 'database', ?, ?, ?, ?, ?, ?, ?)`,
        id, user.tenantId, body.name, user.id, body.shareWithRoles.length ? 'roles' : 'owner', JSON.stringify(body.shareWithRoles), JSON.stringify(cfg),
        JSON.stringify(cfg.tables.map(t => `SELECT ${[t.idColumn, t.titleColumn, ...(t.contentColumns || [])].join(', ')} FROM ${t.name}`)), cfg.driver === 'sqlite' ? cfg.file : `${cfg.user || ''}@${cfg.host || 'connection string'}/${cfg.database || ''}`);
      if (Object.keys(secret).length && s.vault) db.run('INSERT INTO source_credentials (source_id, ciphertext, key_id) VALUES (?, ?, ?)', id, s.vault.seal(secret), s.vault.keyId);
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: id, ipHash, details: { type: 'database', driver: cfg.driver, tables: cfg.tables.map(t => t.name) } });
    const jobId = startSync(s, db.get('SELECT * FROM sources WHERE id = ?', id), user, 'initial');
    ok(res, { sourceId: id, jobId }, undefined, 201);
  });

  router.on('POST', '/api/sources/:id/preview', async ({ req, res, user, params }) => {
    requirePermission(user, 'sources.manage');
    const row = loadManageable(s, user, params.id);
    if (row.type !== 'database') throw new HttpError(400, 'not_database', 'Previews are only for database sources.');
    const body = validate({ table: { type: 'string', required: true, max: 63 }, keyword: { type: 'string', max: 200 }, since: { type: 'date' } }, await readJson(req));
    ok(res, await s.database.preview(row, body));
  });

  /* ---- deleting a single uploaded record ---- */
  router.on('DELETE', '/api/records/:id', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'sources.manage');
    const rec = db.get('SELECT r.id, r.source_id, r.source_record_id, s.type, s.tenant_id FROM records r JOIN sources s ON s.id = r.source_id WHERE r.id = ? AND r.tenant_id = ?', params.id, user.tenantId);
    if (!rec) throw new HttpError(404, 'not_found', 'That record does not exist.');
    if (!['uploads', 'messages'].includes(rec.type)) throw new HttpError(400, 'not_deletable', 'Records from Gmail and databases are removed by deleting them at the source and synchronizing.');
    loadManageable(s, user, rec.source_id);
    const dir = path.join(config.dataDir, 'uploads', rec.tenant_id, rec.source_id);
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.startsWith(rec.source_record_id)) fs.rmSync(path.join(dir, f), { force: true });
    deleteRecord(db, rec.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'upload.deleted', targetType: 'record', targetId: rec.id, ipHash });
    sendJson(res, 200, { ok: true, data: { deleted: true } });
  });
}
