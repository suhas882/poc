// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, ok, pageParams, readBody, readJson, sendJson, SECURITY_HEADERS, validate } from '../http.mjs';
import { can, requirePermission, ROLES } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { deleteRecord, deleteSourceRecords, embedPending, recordView, upsertRecord } from '../ingest/pipeline.mjs';
import { extractFile, SUPPORTED } from '../ingest/extract.mjs';
import { scanUpload } from '../ingest/scan.mjs';
import { groupConversations, parseMessages } from '../ingest/messages.mjs';
import { checkMapping, DIALECTS } from '../connectors/database.mjs';
import { GmailApiError, GOOGLE_SCOPES } from '../connectors/gmail.mjs';
import { MicrosoftApiError } from '../connectors/microsoft.mjs';
import { CATEGORY_LABEL, initialSharing, SOURCE_TYPES } from '../connectors/registry.mjs';

/** Pack placeholders that a connected source of this type replaces ("Exchange mail" by Outlook, "OneDrive" by OneDrive). */
const STUB_COVERED_BY = { exchange: 'outlook', onedrive: 'onedrive', sharepoint: 'sharepoint' };

/** The pack's not-connected placeholders, minus those this organization has actually connected. */
export function openStubs(db, tenantId, pack) {
  const have = new Set(db.all("SELECT DISTINCT type FROM sources WHERE tenant_id = ? AND status != 'disconnected'", tenantId).map(r => r.type));
  return pack.sources.filter(st => !have.has(STUB_COVERED_BY[st.key]));
}

/** The pack's known gaps, with the "not connected" line naming only the placeholders still not connected. */
export function knownGaps(db, tenantId, pack) {
  const names = openStubs(db, tenantId, pack).map(st => st.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return pack.knownGaps.flatMap(g => !/ are not connected/.test(g) ? [g]
    : names.length ? [`${list} ${names.length > 1 ? 'are' : 'is'} not connected. ${names.length > 1 ? 'They are' : 'It is'} listed as NOT searched.`] : []);
}
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
  const stubs = (tier0 ? pack.sources : openStubs(s.db, user.tenantId, pack)).map(st => ({ type: 'stub', key: st.key, name: st.name, description: `Would read: ${st.sees}. Read-only.`, permissions: [], status: 'not_connected', note: st.note }));
  const tag = (c) => ({ ...c, category: c.category ?? SOURCE_TYPES[c.type]?.category ?? (c.type === 'phonelink' ? 'messages' : c.type === 'stub' ? 'planned' : 'imports') });
  if (tier0) return [publicDocs, ...stubs].map(c => ({ ...tag(c), category: c.type === 'public' ? 'demo' : 'planned', lifecycle: c.type === 'public' ? 'available' : 'not_connected' }));
  // Discovery: what this person already has, so each connector says whether to connect, reconnect or wait.
  // Sources this person can search (their own, or shared with them), so a source connected once shows as connected for everyone it is shared with.
  const mine = s.db.all(`SELECT type, status, config, owner_user_id, (SELECT j.error_code FROM sync_jobs j WHERE j.source_id = sources.id ORDER BY j.started_at DESC LIMIT 1) AS last_job_code FROM sources WHERE tenant_id = ? AND status != 'disconnected' AND (owner_user_id = ?
    OR (status != 'pending_approval' AND visibility = 'roles' AND (allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(allowed_roles) WHERE value = ?))))`, user.tenantId, user.id, user.role);
  const approval = s.connectors.needsApproval(user);
  const lifecycleOf = (c) => {
    if (c.status === 'planned') return 'unsupported';
    if (c.status === 'needs_configuration') return 'needs_setup';
    const own = mine.filter(r => r.type === c.type && (c.type !== 'database' || parseJson(r.config, {}).driver === c.driver) && (c.type !== 'messages' || !parseJson(r.config, {}).provider));
    if (c.type === 'phonelink') own.push(...mine.filter(isPhoneLink));
    if (c.type === 'android') own.push(...mine.filter(r => parseJson(r.config, {}).provider === 'android-app'));
    if (own.some(r => r.status === 'pending_approval')) return 'pending_approval';
    // Only the owner can sign in again; for everyone else a shared source that needs attention still counts as connected.
    const broken = own.find(r => r.status === 'needs_attention' && r.owner_user_id === user.id);
    if (broken) return s.connectors.lifecycle({ ...broken, record_count: 0 }, false);
    if (own.length) return 'connected';
    return SOURCE_TYPES[c.type]?.auth === 'oauth' ? 'authorization_required' : 'available';
  };
  const real = fullCatalog(s).filter(c => c.type !== 'phonelink' || sw.phoneLink).map(c => ({ ...tag(c), lifecycle: lifecycleOf(c), approvalRequired: approval && c.type !== 'uploads' && c.type !== 'messages' && c.type !== 'android', ...(c.type === 'phonelink' ? { experimental: true } : {}) }));
  // A placeholder whose real connector exists on this server would only repeat it; it stays NOT searched in reports until connected.
  const ready = new Set(real.filter(c => c.status !== 'planned').map(c => c.type));
  const placeholders = stubs.filter(c => !ready.has(STUB_COVERED_BY[c.key]));
  return [...real, { ...tag(publicDocs), category: 'imports', lifecycle: 'available' }, ...placeholders.map(c => ({ ...tag(c), lifecycle: 'not_connected' }))];
}

export { CATEGORY_LABEL };

function fullCatalog(s) {
  const st = (ready, reason) => ready ? { status: 'available' } : { status: 'needs_configuration', reason };
  return [
    { type: 'gmail', name: 'Gmail', description: 'Read-only access to one mailbox through Google sign-in. Attachments in supported formats are indexed too.', permissions: ['Read email messages and attachments (gmail.readonly)'], ...st(s.gmail.configured && s.vault, !s.gmail.configured ? 'An administrator needs to add Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).' : 'Credential encryption key is missing.') },
    { type: 'uploads', name: 'Document uploads', description: 'Upload PDF, Word, Excel, CSV, JSON, text files and images (OCR). Each file is checked for type and size, scanned for malware when a scanner is configured, and de-duplicated. On a phone, use the file picker to choose exported files.', permissions: ['Only the files you choose'], status: 'available' },
    { type: 'android', category: 'messages', name: 'Android phone (companion app)', description: 'Pair your Android phone once with a code or QR code. The companion app sends your text message history, then new texts as they arrive, over HTTPS. No exports, no uploads, and nothing read from Windows Phone Link.', permissions: ['Read SMS on your phone, after you allow it there (READ_SMS, RECEIVE_SMS)', 'Texts go only to your own private source on this site', 'Nothing is sent from, changed on, or deleted from your phone'], status: 'available', note: 'Needs the companion app on the phone. SMS only: RCS chat messages, MMS pictures and other messaging apps are not included.' },
    { type: 'phonelink', name: 'Android texts (Phone Link)', description: 'Reads the texts your Android phone already syncs to Windows Phone Link on this PC, with no export. New texts are picked up automatically.', permissions: ['Read Phone Link’s copy of your texts, read-only', 'Nothing is sent from or changed on your phone'], status: 'available', local: s.phonelink.available, note: s.phonelink.available ? 'On a hosted server (Render, AWS), use the PC sync helper instead.' : 'This server is not on your PC, so it uses the PC sync helper: a small program on your Windows PC that sends new texts here.' },
    { type: 'messages', name: 'Message imports', description: 'Import message exports you create yourself: Android SMS Backup & Restore XML, WhatsApp “Export chat” text, or CSV.', permissions: ['Only the export files you choose'], status: 'available', note: 'For Android texts without exporting, use Android phone (companion app) above. WhatsApp and iPhone messages still need an export.' },
    { type: 'database', driver: 'postgres', name: 'PostgreSQL', description: 'Read-only, allowlisted tables and columns.', permissions: ['SELECT on allowlisted tables'], ...st(hasModule('pg'), 'The PostgreSQL driver is not installed (npm install pg).') },
    { type: 'database', driver: 'mysql', name: 'MySQL', description: 'Read-only, allowlisted tables and columns.', permissions: ['SELECT on allowlisted tables'], ...st(hasModule('mysql2'), 'The MySQL driver is not installed (npm install mysql2).') },
    { type: 'database', driver: 'sqlite', name: 'SQLite file', description: 'Read-only access to a SQLite file placed in the server’s connector folder.', permissions: ['Read the chosen file'], status: 'available' },
    { type: 'gdrive', name: 'Google Drive', description: 'Read-only access to the files in one Google Drive (My Drive and files shared with you) through Google sign-in. Google Docs, Sheets and Slides are exported as text; PDF, Word, Excel, CSV, text and image files are indexed. Later syncs pick up changes, trashed and removed files.', permissions: ['See and download your Drive files (drive.readonly)'], ...st(s.gmail.configured && s.vault, !s.gmail.configured ? 'An administrator needs to add Google OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET).' : 'Credential encryption key is missing.') },
    { type: 'outlook', name: 'Outlook mail', description: 'Read-only access to one Outlook.com or Microsoft 365 mailbox through Microsoft sign-in. Deleted Items and Junk are skipped. Attachments in supported formats are indexed too.', permissions: ['Read your mail (Mail.Read)', 'Your basic profile, to label the source (User.Read)'], ...st(s.microsoft.configured && s.vault, !s.microsoft.configured ? 'An administrator needs to add Microsoft sign-in credentials (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET).' : 'Credential encryption key is missing.') },
    { type: 'onedrive', name: 'OneDrive', description: 'Read-only access to the files in one OneDrive through Microsoft sign-in. PDF, Word, Excel, CSV, text and image files are indexed; changes and deletions are picked up on each sync.', permissions: ['Read your files (Files.Read)', 'Your basic profile, to label the source (User.Read)'], ...st(s.microsoft.configured && s.vault, !s.microsoft.configured ? 'An administrator needs to add Microsoft sign-in credentials (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET).' : 'Credential encryption key is missing.') },
    { type: 'sharepoint', name: 'SharePoint', description: 'Read-only access to the document library of one SharePoint site, for a Microsoft 365 work or school account. Personal Outlook.com accounts have no SharePoint. Changes and deletions are picked up on each sync.', permissions: ['Read items in sites you can already open (Sites.Read.All, delegated)', 'Your basic profile (User.Read)'], note: 'Some organizations require an administrator to approve this permission for the app in Microsoft Entra before anyone can connect.', ...st(s.microsoft.configured && s.vault, !s.microsoft.configured ? 'An administrator needs to add Microsoft sign-in credentials (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET).' : 'Credential encryption key is missing.') }
  ];
}

/** Sources this user can see: everything shared with them, everything they own, and (for admins) every source in the tenant. */
function visibleSources(db, user) {
  return db.all(`SELECT s.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM records r WHERE r.source_id = s.id) AS record_count,
      (SELECT COUNT(*) FROM records r WHERE r.source_id = s.id AND r.duplicate_of IS NOT NULL) AS duplicate_count,
      (SELECT j.error_code FROM sync_jobs j WHERE j.source_id = s.id ORDER BY j.started_at DESC LIMIT 1) AS last_job_code,
      (SELECT MAX(j.finished_at) FROM sync_jobs j WHERE j.source_id = s.id AND j.status = 'succeeded') AS last_success_at,
      EXISTS (SELECT 1 FROM source_credentials c WHERE c.source_id = s.id) AS has_credentials
    FROM sources s LEFT JOIN users u ON u.id = s.owner_user_id
    WHERE s.tenant_id = ? AND (? = 1 OR s.owner_user_id = ? OR (s.status != 'pending_approval' AND s.visibility = 'roles' AND (s.allowed_roles = '[]' OR EXISTS (SELECT 1 FROM json_each(s.allowed_roles) WHERE value = ?))))
    ORDER BY s.type = 'synthetic', s.created_at`, user.tenantId, user.role === 'admin' ? 1 : 0, user.id, user.role);
}

function sourceView(row, user, running, registry) {
  const cfg = parseJson(row.config, {});
  const repositories = row.type === 'gmail' ? [{ name: cfg.query ? `Messages matching “${cfg.query}”` : 'All mail except spam and trash', kind: 'gmail_query' }]
    : isPhoneLink(row) ? [{ name: 'Texts synced by Phone Link on this PC', kind: 'phonelink' }]
    : cfg.provider === 'phonelink-agent' ? [{ name: 'Texts sent by the PC sync helper', kind: 'phonelink-agent' }]
    : cfg.provider === 'android-app' ? [{ name: 'SMS sent by the Android companion app', kind: 'android-app' }]
    : row.type === 'outlook' ? [{ name: `Mail received in the last ${Math.round((Number(cfg.days) || 730) / 30)} months, except Deleted Items and Junk`, kind: 'outlook_window' }]
    : row.type === 'onedrive' ? [{ name: 'All files in this OneDrive', kind: 'onedrive_root' }]
    : row.type === 'gdrive' ? [{ name: 'My Drive and files shared with you, except the trash', kind: 'gdrive_all' }]
    : row.type === 'sharepoint' ? [{ name: `Document library of ${cfg.siteUrl || 'the site'}`, kind: 'sharepoint_library' }]
    : row.type === 'database' ? (cfg.tables || []).map(t => ({ name: t.name, kind: 'table', columns: [t.idColumn, t.titleColumn, ...(t.contentColumns || [])] }))
    : [];
  return {
    id: row.id, type: row.type, name: row.name, status: running ? 'syncing' : row.status, accountLabel: row.account_label,
    owner: row.owner_user_id ? { id: row.owner_user_id, name: row.owner_name } : null, isOwner: row.owner_user_id === user.id,
    canManage: row.type !== 'synthetic' && (user.role === 'admin' || (row.owner_user_id === user.id && can(user, 'sources.manage'))),
    visibility: row.visibility, allowedRoles: parseJson(row.allowed_roles, []), scopes: parseJson(row.scopes, []),
    driver: cfg.driver ?? null, provider: cfg.provider ?? null, repositories, recordCount: row.record_count, duplicateCount: row.duplicate_count,
    lastSyncAt: row.last_sync_at, lastSyncStatus: row.last_sync_status, lastError: row.last_error, createdAt: row.created_at,
    isSynthetic: row.type === 'synthetic', publicDocs: cfg.publicDocs === 1, experimental: String(cfg.provider || '').startsWith('phonelink'), readOnly: true,
    category: row.type === 'synthetic' || cfg.publicDocs === 1 ? 'demo' : SOURCE_TYPES[row.type]?.category ?? 'imports',
    lifecycle: registry.lifecycle(row, running), lastSuccessAt: row.last_success_at ?? null, lastErrorCode: row.status === 'needs_attention' ? row.last_job_code ?? null : null,
    // Whether secrets are held for this source; never the secrets themselves.
    credentials: row.has_credentials ? 'stored_encrypted' : 'none', syncs: registry.syncs(row),
    canApprove: row.status === 'pending_approval' && user.role === 'admin'
  };
}

function loadManageable(s, user, id) {
  const row = s.db.get('SELECT * FROM sources WHERE id = ? AND tenant_id = ?', id, user.tenantId);
  if (!row) throw new HttpError(404, 'not_found', 'That source does not exist.');
  if (row.type === 'synthetic') throw new HttpError(403, 'forbidden', 'The synthetic demo source cannot be changed.');
  if (!(user.role === 'admin' || (row.owner_user_id === user.id && can(user, 'sources.manage')))) throw new HttpError(403, 'forbidden', 'Only the person who connected this source, or an administrator, can change it.');
  return row;
}

/** Failures worth retrying on their own: quotas and temporary outages. Anything else waits for a person. */
const RETRYABLE = new Set(['gmail_rate_limited', 'gmail_unavailable', 'microsoft_throttled', 'microsoft_unavailable']);

/** Run a sync in the background; returns the job id immediately. `attempt` > 1 marks an automatic retry. */
export function startSync(s, source, user, trigger, { full = false, attempt = 1 } = {}) {
  if (s.running.has(source.id)) throw new HttpError(409, 'sync_running', 'This source is already synchronizing.');
  if (source.status === 'pending_approval') throw new HttpError(409, 'pending_approval', 'A Supervisor has to approve this source before it is synchronized or searched.');
  const handler = s.connectors.handlerFor(source);
  if (!handler) throw new HttpError(400, 'not_syncable', 'This source is updated by uploading files, not by synchronizing.');
  const jobId = crypto.randomUUID();
  s.db.run("INSERT INTO sync_jobs (id, tenant_id, source_id, trigger, status, started_at, retries) VALUES (?, ?, ?, ?, 'running', ?, ?)", jobId, source.tenant_id, source.id, trigger, nowIso(), attempt - 1);
  /** @type {any} filled in by the Gmail connector as it goes, so failures still show how far the run got */
  const diag = {};
  const saveDiag = (err) => {
    const d = err instanceof GmailApiError || err instanceof MicrosoftApiError ? err.diag : null;
    const c = diag.counts || {};
    s.db.run(`UPDATE sync_jobs SET added = ?, updated = ?, deleted = ?, skipped = ?, api_status = ?, error_code = ?, error_reason = ?, error_endpoint = ?, provider_message = ?,
      listed = ?, attempted = ?, fetched = ?, api_calls = ?, rate_limit_waits = ? WHERE id = ?`,
    c.added ?? 0, c.updated ?? 0, c.deleted ?? 0, c.skipped ?? 0, d?.httpStatus ?? null, err instanceof HttpError ? err.code : err ? 'error' : null, d?.reason ?? null, d?.endpoint ?? null, d?.providerMessage ?? null,
    diag.listed ?? null, diag.attempted ?? null, diag.fetched ?? null, diag.apiCalls ?? null, diag.rateLimitWaits ?? null, jobId);
  };
  const promise = (async () => {
    try {
      const counts = await handler.sync(source, { full, diag });
      let embedded = 0, embedError = null;
      try { embedded = await embedPending(s.db, s.embedder, source.tenant_id); } catch (err) { embedError = err instanceof Error ? err.message : String(err); }
      s.db.run("UPDATE sync_jobs SET status = 'succeeded', finished_at = ?, added = ?, updated = ?, deleted = ?, skipped = ?, error = ? WHERE id = ?",
        nowIso(), counts.added, counts.updated, counts.deleted, counts.skipped, counts.truncated ? 'Stopped at the per-sync limit; run it again to continue.' : embedError ? `Indexed for keyword search; semantic indexing failed: ${embedError}` : null, jobId);
      if (diag.counts) saveDiag(null);
      s.db.run("UPDATE sources SET status = 'connected', last_sync_at = ?, last_sync_status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?", nowIso(), nowIso(), source.id);
      s.audit.write({ tenantId: source.tenant_id, userId: user?.id, action: 'source.synced', targetType: 'source', targetId: source.id, details: { ...counts, embedded, trigger } });
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'The synchronization failed unexpectedly. Details are in the server log.';
      if (!(err instanceof HttpError)) s.log('[sync] failed:', err);
      if (err instanceof GmailApiError || err instanceof MicrosoftApiError) s.log(`[${source.type}] sync failed: ${err.diag.endpoint} HTTP ${err.diag.httpStatus} ${err.diag.reason || ''} after ${diag.apiCalls ?? 0} calls, ${diag.fetched ?? 0} messages fetched`);
      s.db.run("UPDATE sync_jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", nowIso(), message, jobId);
      saveDiag(err);
      s.db.run("UPDATE sources SET status = 'needs_attention', last_sync_at = ?, last_sync_status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", nowIso(), message, nowIso(), source.id);
      s.audit.write({ tenantId: source.tenant_id, userId: user?.id, action: 'source.synced', targetType: 'source', targetId: source.id, outcome: 'failure', details: { error: message, trigger } });
      // Quotas and outages clear on their own: try again later, a few times. What was indexed is kept and not fetched again.
      if (err instanceof HttpError && RETRYABLE.has(err.code) && attempt <= s.config.sync.retries) {
        setTimeout(() => {
          const fresh = s.db.get('SELECT * FROM sources WHERE id = ?', source.id);
          if (fresh && fresh.status !== 'disconnected' && !s.running.has(fresh.id)) { try { startSync(s, fresh, user, 'retry', { full, attempt: attempt + 1 }); } catch { /* removed or busy */ } }
        }, s.config.sync.retryDelayMs * attempt).unref();
      }
    } finally {
      s.running.delete(source.id);
    }
  })();
  s.running.set(source.id, promise);
  return jobId;
}

/**
 * After a source is connected: start its first sync, or hold it for a Supervisor when approval is required.
 * A source that is still waiting stays waiting when its owner reconnects. Returns the job id, or null when held.
 */
export function afterConnect(s, row, user, trigger, ipHash) {
  if (row.status === 'pending_approval') return null;
  if (trigger === 'initial' && s.connectors.needsApproval(user)) {
    s.db.run("UPDATE sources SET status = 'pending_approval', updated_at = ? WHERE id = ?", nowIso(), row.id);
    s.audit.write({ tenantId: row.tenant_id, userId: user.id, action: 'source.approval_requested', targetType: 'source', targetId: row.id, ipHash, details: { type: row.type, name: row.name } });
    return null;
  }
  return s.running.has(row.id) ? null : startSync(s, row, user, trigger);
}

/** Remove a source completely: revoke at the provider, delete credentials, records, files and the source row. */
export async function removeSource(s, row, user, ipHash) {
  const handler = s.connectors.handlerFor(row);
  const revoked = handler ? (await handler.disconnect(row)).revoked : null;
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
    ok(res, visibleSources(db, user).filter(r => phoneOn || !String(parseJson(r.config, {}).provider || '').startsWith('phonelink')).map(r => sourceView(r, user, s.running.has(r.id), s.connectors)));
  });

  router.on('GET', '/api/sources/:id/jobs', ({ res, user, params }) => {
    requirePermission(user, 'sources.read');
    if (!visibleSources(db, user).some(r => r.id === params.id)) throw new HttpError(404, 'not_found', 'That source does not exist.');
    ok(res, db.all(`SELECT id, trigger, status, started_at AS startedAt, finished_at AS finishedAt, added, updated, deleted, skipped, error,
      api_status AS apiStatus, error_code AS errorCode, error_reason AS errorReason, error_endpoint AS errorEndpoint, provider_message AS providerMessage,
      listed, attempted, fetched, api_calls AS apiCalls, rate_limit_waits AS rateLimitWaits
      FROM sync_jobs WHERE source_id = ? ORDER BY started_at DESC LIMIT 20`, params.id));
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
    ok(res, sourceView({ ...db.get('SELECT s.*, u.name AS owner_name FROM sources s LEFT JOIN users u ON u.id = s.owner_user_id WHERE s.id = ?', row.id), record_count: db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', row.id).n, duplicate_count: 0 }, user, false, s.connectors));
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
    const jobId = afterConnect(s, db.get('SELECT * FROM sources WHERE id = ?', id), user, 'initial', ipHash);
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

  /** Check access: stored sign-in accepted, permissions granted, API reachable. Reads no content; the result is audited. */
  router.on('POST', '/api/sources/:id/verify', async ({ res, user, params, ipHash }) => {
    requirePermission(user, 'sources.manage');
    const row = loadManageable(s, user, params.id);
    const result = await s.connectors.verify(row);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.verified', targetType: 'source', targetId: row.id, ipHash, outcome: result.checks.every(c => c.ok) ? 'success' : 'failure', details: { checks: result.checks.map(c => ({ label: c.label, ok: c.ok })) } });
    ok(res, { ...result, checkedAt: nowIso() });
  });

  /* ---- Supervisor approval of sources connected while approval is required ---- */
  const loadPending = (user, id) => {
    requirePermission(user, 'settings.manage');
    const row = db.get('SELECT * FROM sources WHERE id = ? AND tenant_id = ?', id, user.tenantId);
    if (!row) throw new HttpError(404, 'not_found', 'That source does not exist.');
    if (row.status !== 'pending_approval') throw new HttpError(409, 'not_pending', 'This source is not waiting for approval.');
    return row;
  };
  router.on('POST', '/api/sources/:id/approve', ({ res, user, params, ipHash }) => {
    const row = loadPending(user, params.id);
    db.run("UPDATE sources SET status = 'connected', updated_at = ? WHERE id = ?", nowIso(), row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.approved', targetType: 'source', targetId: row.id, ipHash, details: { type: row.type, name: row.name, owner: row.owner_user_id } });
    const fresh = db.get('SELECT * FROM sources WHERE id = ?', row.id);
    const jobId = s.connectors.syncs(fresh) ? startSync(s, fresh, user, 'initial') : null;
    ok(res, { sourceId: row.id, jobId });
  });
  router.on('POST', '/api/sources/:id/reject', async ({ res, user, params, ipHash }) => {
    const row = loadPending(user, params.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.rejected', targetType: 'source', targetId: row.id, ipHash, details: { type: row.type, name: row.name, owner: row.owner_user_id } });
    ok(res, await removeSource(s, row, user, ipHash));
  });

  /* ---- Gmail OAuth ---- */

  router.on('POST', '/api/connectors/gmail/authorize', async ({ req, res, user, ipHash }) => {
    if (user) realGate(user);
    requirePermission(user, 'sources.manage');
    const body = validate({ kind: { type: 'string', values: ['gmail', 'gdrive'], default: 'gmail' }, visibility: { type: 'string', values: ['org', 'owner', 'roles'], default: 'owner' }, query: { type: 'string', max: 500, default: config.gmail.defaultQuery }, shareWithRoles: { ...roleList, default: [] } }, await readJson(req));
    const result = s.gmail.authorize(user, body);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.oauth_started', targetType: 'connector', targetId: body.kind, ipHash, details: { scopes: result.scopes } });
    ok(res, result);
  });

  /** The callback of a "Continue with Google/Microsoft" sign-in: start a session for the matching user. */
  async function finishSignIn(provider, pending, { res, url, ipHash }) {
    const go = (location, cookies) => { res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); };
    try {
      const r = await s.signin.finish(provider, pending, Object.fromEntries(url.searchParams));
      db.run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), r.user.id);
      const session = s.sessions.create(r.user);
      audit.write({ tenantId: r.user.tenant_id, userId: r.user.id, action: 'auth.login', ipHash, details: { method: provider, identityLinked: r.linked } });
      // Straight after signing in, offer this provider's sources: each one asks for its own read-only permission.
      go(r.next === '/' ? `/sources.html?welcome=${provider}` : r.next, [session.cookie, s.signin.clearCookie()]);
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'Signing in failed. Try again.';
      if (!(err instanceof HttpError)) s.log('[signin] failed:', err);
      audit.write({ action: 'auth.login_failed', outcome: 'failure', ipHash, details: { method: provider, reason: err instanceof HttpError ? err.code : 'error', email: /** @type {any} */ (err)?.details?.email } });
      // A verified identity with no account may ask for access; nobody is signed in and nothing is created.
      const identity = err instanceof HttpError && err.code === 'no_account' ? /** @type {any} */ (err.details)?.identity : null;
      if (identity) return go('/request-access.html', [s.signin.clearCookie(), s.signin.requestCookie(identity)]);
      go(`/login.html?${new URLSearchParams({ error: message })}`, [s.signin.clearCookie()]);
    }
  }

  /** The callback of "Link Microsoft Account" (or Google): attach the provider account to the person signed in now. */
  async function finishLink(provider, pending, { res, url, user, ipHash }) {
    const go = (q) => { res.writeHead(302, { Location: `/sources.html?${new URLSearchParams(q)}`, 'Set-Cookie': s.signin.clearCookie(), 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); };
    try {
      const r = await s.signin.finishLink(provider, pending, Object.fromEntries(url.searchParams), user);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'auth.identity_linked', targetType: 'user', targetId: user.id, ipHash, details: { provider, email: r.email, alreadyLinked: r.alreadyLinked } });
      go({ linked: provider });
    } catch (err) {
      const message = err instanceof HttpError ? err.message : 'Linking failed. You are still signed in; try again later.';
      if (!(err instanceof HttpError)) s.log('[link] failed:', err);
      audit.write({ tenantId: user?.tenantId, userId: user?.id, action: 'auth.identity_linked', outcome: 'failure', targetType: 'user', targetId: user?.id, ipHash, details: { provider, reason: err instanceof HttpError ? err.code : 'error' } });
      go({ link_error: message });
    }
  }

  /** Start linking a provider account to the signed-in person. A POST with the CSRF token, so no other site can start it. */
  router.on('POST', '/api/signin/link/:provider', ({ res, user, params }) => {
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    realGate(user);
    const provider = params.provider === 'microsoft' ? 'microsoft' : params.provider === 'google' ? 'google' : null;
    if (!provider) throw new HttpError(404, 'not_found', 'Unknown provider.');
    const { url, cookie } = s.signin.startLink(provider, user);
    sendJson(res, 200, { ok: true, data: { url } }, { 'Set-Cookie': cookie });
  });

  router.on('DELETE', '/api/signin/identities/:provider', ({ res, user, params, ipHash }) => {
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    const n = db.run('DELETE FROM user_identities WHERE user_id = ? AND provider = ?', user.id, params.provider).changes;
    if (n) audit.write({ tenantId: user.tenantId, userId: user.id, action: 'auth.identity_unlinked', targetType: 'user', targetId: user.id, ipHash, details: { provider: params.provider } });
    ok(res, { unlinked: Boolean(n) });
  });

  router.on('GET', '/oauth/google/callback', async ({ req, res, url, user, ipHash }) => {
    const signin = s.signin.pending(req, 'google', url.searchParams.get('state'));
    if (signin?.mode === 'link') return finishLink('google', signin, { res, url, user, ipHash });
    if (signin) return finishSignIn('google', signin, { res, url, ipHash });
    const redirect = (q) => { res.writeHead(302, { Location: `/sources.html?${new URLSearchParams(q)}`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); };
    if (!user) return redirect({ error: 'Your session ended before Google finished. Sign in and connect Gmail again.' });
    try {
      requirePermission(user, 'sources.manage');
      const result = await s.gmail.handleCallback(user, Object.fromEntries(url.searchParams));
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: result.sourceId, ipHash, details: { type: result.kind, reconnected: result.reconnected, scopes: [GOOGLE_SCOPES[result.kind]] } });
      const row = db.get('SELECT * FROM sources WHERE id = ?', result.sourceId);
      afterConnect(s, row, user, result.reconnected ? 'reconnect' : 'initial', ipHash);
      redirect({ connected: result.sourceId });
    } catch (err) {
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'connector', targetId: 'google', outcome: 'failure', ipHash, details: { code: err instanceof HttpError ? err.code : 'error', reason: err instanceof HttpError ? err.message.slice(0, 300) : undefined } });
      if (!(err instanceof HttpError)) s.log('[gmail] callback failed:', err);
      redirect({ error: err instanceof HttpError ? err.message : 'Connecting Gmail failed. Try again.' });
    }
  });

  /* ---- Microsoft OAuth (Outlook mail, OneDrive) ---- */

  router.on('POST', '/api/connectors/microsoft/authorize', async ({ req, res, user, ipHash }) => {
    if (user) realGate(user);
    requirePermission(user, 'sources.manage');
    const body = validate({ kind: { type: 'string', values: ['outlook', 'onedrive', 'sharepoint'], required: true }, visibility: { type: 'string', values: ['org', 'owner', 'roles'], default: 'owner' }, siteUrl: { type: 'string', max: 500, default: '' }, shareWithRoles: { ...roleList, default: [] } }, await readJson(req));
    const result = s.microsoft.authorize(user, body);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.oauth_started', targetType: 'connector', targetId: body.kind, ipHash, details: { scopes: result.scopes } });
    ok(res, result);
  });

  router.on('GET', '/oauth/microsoft/callback', async ({ req, res, url, user, ipHash }) => {
    const signin = s.signin.pending(req, 'microsoft', url.searchParams.get('state'));
    if (signin?.mode === 'link') return finishLink('microsoft', signin, { res, url, user, ipHash });
    if (signin) return finishSignIn('microsoft', signin, { res, url, ipHash });
    const redirect = (q) => { res.writeHead(302, { Location: `/sources.html?${new URLSearchParams(q)}`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(); };
    if (!user) return redirect({ error: 'Your session ended before Microsoft finished. Sign in and connect again.' });
    try {
      requirePermission(user, 'sources.manage');
      realGate(user);
      const result = await s.microsoft.handleCallback(user, Object.fromEntries(url.searchParams));
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: result.sourceId, ipHash, details: { type: result.kind, reconnected: result.reconnected } });
      const row = db.get('SELECT * FROM sources WHERE id = ?', result.sourceId);
      afterConnect(s, row, user, result.reconnected ? 'reconnect' : 'initial', ipHash);
      redirect({ connected: result.sourceId });
    } catch (err) {
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'connector', targetId: 'microsoft', outcome: 'failure', ipHash, details: { code: err instanceof HttpError ? err.code : 'error' } });
      if (!(err instanceof HttpError)) s.log('[microsoft] callback failed:', err);
      redirect({ error: err instanceof HttpError ? err.message : 'Connecting the Microsoft account failed. Try again.' });
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
    if (isPhoneLink(source) || ['phonelink-agent', 'android-app'].includes(parseJson(source.config, {}).provider)) throw new HttpError(400, 'wrong_source', 'Phone texts update by themselves. Import message exports into a message import source instead.');
    if (source.type !== kind) throw new HttpError(400, 'wrong_source', kind === 'messages' ? 'Message exports go into a message import source.' : 'Documents go into an upload source.');
    const buf = await readBody(req, config.uploads.maxBytes);
    if (!buf.length) throw new HttpError(400, 'empty_file', 'The file is empty.');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const ctx = { tenantId: user.tenantId, sourceId: source.id, sourceType: kind, isSynthetic: isPublic };
    // Scan before anything is parsed or stored. An infected file is refused and logged; nothing is kept.
    let scan;
    try { scan = await scanUpload(buf, config.clamav); } catch (err) {
      if (err instanceof HttpError && err.code === 'malware_found') audit.write({ tenantId: user.tenantId, userId: user.id, action: 'upload.rejected', targetType: 'source', targetId: source.id, outcome: 'denied', ipHash, details: { reason: 'malware_found', file: filename, bytes: buf.length, sha256: sha, ...(/** @type {any} */ (err.details) || {}) } });
      throw err;
    }

    if (kind === 'messages') {
      let parsed;
      try { parsed = parseMessages(filename, buf); } catch (err) { throw new HttpError(415, 'unsupported_export', err instanceof Error ? err.message : 'Unsupported export.'); }
      const groups = groupConversations(parsed.messages, parsed.format === 'whatsapp-txt' ? 'WhatsApp' : parsed.format === 'sms-backup-xml' ? 'SMS' : 'Messages');
      const counts = { added: 0, updated: 0, unchanged: 0 };
      for (const g of groups) counts[upsertRecord(db, ctx, { ...g, accessPermissions: {} }).status]++;
      await embedPending(db, s.embedder, user.tenantId).catch(() => 0);
      db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded', status = 'connected' WHERE id = ?", nowIso(), source.id);
      audit.write({ tenantId: user.tenantId, userId: user.id, action: 'upload.ingested', targetType: 'source', targetId: source.id, ipHash, details: { kind, format: parsed.format, messages: parsed.messages.length, conversations: groups.length, bytes: buf.length, scan: scan.status } });
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
    db.run("UPDATE records SET extracted_entities = json_set(extracted_entities, '$.file', json(?)) WHERE id = ?", JSON.stringify({ name: filename, bytes: buf.length, ext, sha256: sha, status: ex.status, notes: ex.notes, scan: scan.status, uploadedBy: user.name, uploadedAt: nowIso() }), result.id);
    await embedPending(db, s.embedder, user.tenantId).catch(() => 0);
    db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded', status = 'connected' WHERE id = ?", nowIso(), source.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'upload.ingested', targetType: 'record', targetId: result.id, ipHash, details: { kind, type: SUPPORTED[ext.slice(1)]?.label, bytes: buf.length, status: ex.status, result: result.status, scan: scan.status } });
    ok(res, { sourceId: source.id, recordId: result.id, result: result.status, extraction: ex.status, characters: ex.text.length, notes: ex.notes, scan: scan.status }, undefined, 201);
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
    tenantColumn: { type: 'string', max: 63 }, tenantValue: { type: 'string', max: 255 }, visibility: { type: 'string', values: ['org', 'owner', 'roles'], default: 'owner' },
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
    const sharing = initialSharing(body);
    db.tx(() => {
      db.run(`INSERT INTO sources (id, tenant_id, type, name, owner_user_id, visibility, allowed_roles, config, scopes, account_label) VALUES (?, ?, 'database', ?, ?, ?, ?, ?, ?, ?)`,
        id, user.tenantId, body.name, user.id, sharing.visibility, JSON.stringify(sharing.allowedRoles), JSON.stringify(cfg),
        JSON.stringify(cfg.tables.map(t => `SELECT ${[t.idColumn, t.titleColumn, ...(t.contentColumns || [])].join(', ')} FROM ${t.name}`)), cfg.driver === 'sqlite' ? cfg.file : `${cfg.user || ''}@${cfg.host || 'connection string'}/${cfg.database || ''}`);
      if (Object.keys(secret).length && s.vault) db.run('INSERT INTO source_credentials (source_id, ciphertext, key_id) VALUES (?, ?, ?)', id, s.vault.seal(secret), s.vault.keyId);
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'source.connected', targetType: 'source', targetId: id, ipHash, details: { type: 'database', driver: cfg.driver, tables: cfg.tables.map(t => t.name) } });
    const jobId = afterConnect(s, db.get('SELECT * FROM sources WHERE id = ?', id), user, 'initial', ipHash);
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
