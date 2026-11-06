// @ts-check
/**
 * Android companion app: automatic SMS sync from the user's own phone, with no export and no Phone Link files.
 *
 * Flow:
 *  1. Signed in on the website, the user clicks Connect phone. The server makes a one-time code (shown as text and as
 *     a QR code) that lasts 10 minutes.
 *  2. The Android app sends the code to POST /api/phone/pair. The server creates a private "messages" source and a
 *     revocable key (Authorization: Bearer prs_phone_...). Only a hash of the code and of the key is stored.
 *  3. After the user grants READ_SMS/RECEIVE_SMS on the phone, the app sends its history, then new texts, to
 *     POST /api/phone/messages. Each text is stored once (by the phone's message id and by a fingerprint), merged into
 *     one record per conversation per day, and indexed like any other source.
 *  4. The key can only add texts to its own source and report status. Revoking it, or removing the source, stops the
 *     phone; removing the source also deletes every synced text.
 *
 * Message content is never logged and never written to the audit log; only counts are.
 */
import crypto from 'node:crypto';
import { HttpError, ok, readJson, validate } from '../http.mjs';
import { requirePermission } from '../auth.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { RateLimiter, sha256 } from '../security.mjs';
import { embedPending, upsertRecord } from '../ingest/pipeline.mjs';
import { removeSource } from './sources.mjs';

const TOKEN_PREFIX = 'prs_phone_';
export const PHONE_PROVIDER = 'android-app';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_BATCH = 500;
const MAX_OPEN_PAIRINGS_PER_USER = 5;

const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Phone numbers compare by digits (and a leading +); other addresses (short codes, names) by lowercase text. */
export function conversationKey(address) {
  const a = String(address || '').trim();
  const digits = a.replace(/[^\d+]/g, '');
  if (/^\+?\d{5,}$/.test(digits) && digits.replace(/\D/g, '').length >= a.replace(/\D/g, '').length) return digits.replace(/(?!^)\+/g, '');
  return a.toLowerCase() || 'unknown';
}

/** @param {import('../http.mjs').Router} router */
export function registerPhoneRoutes(router, s) {
  const { db, audit } = s;
  const wrongCodes = new RateLimiter(10, 15 * 60_000); // per IP, on the unauthenticated pairing endpoint

  const realOn = () => { if (!s.config.realSources) throw new HttpError(403, 'real_sources_off', 'This server only holds Tier 0 data. It does not accept texts.'); };

  /** Authenticate the phone by its bearer key. */
  function phoneFromRequest(req) {
    realOn();
    const m = /^Bearer\s+(prs_phone_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization || ''));
    if (!m) throw new HttpError(401, 'phone_key_missing', 'Send the phone key as "Authorization: Bearer prs_phone_...".');
    const row = db.get(`SELECT t.*, u.name AS user_name, u.disabled FROM agent_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.kind = 'phone'`, sha256(m[1]));
    if (!row || row.revoked_at || row.disabled) throw new HttpError(401, 'phone_key_invalid', 'This phone was disconnected. Pair it again from the website.');
    const source = db.get("SELECT * FROM sources WHERE id = ? AND status NOT IN ('disconnected', 'pending_approval')", row.source_id);
    if (!source) throw new HttpError(401, 'phone_key_invalid', 'The source for this phone was removed. Pair it again from the website.');
    return { token: row, source };
  }

  /** Where the phone should resume: the newest message id and time already stored. */
  const cursorOf = (sourceId) => {
    const r = db.get('SELECT MAX(device_msg_id) AS id, MAX(sent_at) AS at, COUNT(*) AS n FROM phone_messages WHERE source_id = ?', sourceId);
    return { lastId: r.id ?? 0, lastDate: r.at ? Date.parse(r.at) : 0, messages: r.n };
  };

  const saveStatus = (tokenId, status) => {
    if (!status) return;
    const prev = parseJson(db.get('SELECT device_status FROM agent_tokens WHERE id = ?', tokenId)?.device_status, {});
    const next = { ...prev, reportedAt: nowIso() };
    if (status.permission) next.permission = status.permission;
    if (typeof status.pending === 'number') next.pending = status.pending;
    if (status.lastError !== undefined) { next.lastError = status.lastError || null; next.lastErrorAt = status.lastError ? nowIso() : prev.lastErrorAt ?? null; }
    db.run('UPDATE agent_tokens SET device_status = ?, last_used_at = ? WHERE id = ?', JSON.stringify(next), nowIso(), tokenId);
  };

  const statusSpec = { type: 'object', fields: {
    permission: { type: 'string', values: ['granted', 'denied', 'partial'], default: undefined },
    pending: { type: 'int', min: 0, max: 100000000, default: undefined },
    lastError: { type: 'string', max: 300, default: '' },
    appVersion: { type: 'string', max: 20, default: '' }
  } };

  /* ---------------- website (signed in) ---------------- */

  router.on('POST', '/api/phone-pairings', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'sources.manage');
    s.realGate(user);
    const body = validate({ name: { type: 'string', max: 60, default: '' }, acknowledged: { type: 'bool', required: true } }, await readJson(req));
    if (body.acknowledged !== true) throw new HttpError(400, 'not_acknowledged', 'Confirm that these are your own texts and that you may index them.');
    db.run("UPDATE phone_pairings SET status = 'cancelled' WHERE user_id = ? AND status = 'pending' AND expires_at < ?", user.id, nowIso());
    if (db.get("SELECT COUNT(*) AS n FROM phone_pairings WHERE user_id = ? AND status = 'pending'", user.id).n >= MAX_OPEN_PAIRINGS_PER_USER) {
      throw new HttpError(429, 'too_many_pairings', 'You have several pairing codes waiting. Use one, or wait 10 minutes.');
    }
    const id = crypto.randomUUID(), expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    for (let attempt = 0; ; attempt++) {
      const code = newCode();
      try {
        db.run('INSERT INTO phone_pairings (id, code_hash, tenant_id, user_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, sha256(code), user.tenantId, user.id, clean(body.name, 60), nowIso(), expiresAt);
        audit.write({ tenantId: user.tenantId, userId: user.id, action: 'phone.pairing_started', targetType: 'phone_pairing', targetId: id, ipHash, details: {} });
        const server = s.config.publicUrl;
        ok(res, { id, code: showCode(code), expiresAt, server, pairUri: `prsphone://pair?s=${encodeURIComponent(server)}&c=${code}` }, undefined, 201);
        return;
      } catch (err) { if (attempt >= 4) throw err; }
    }
  });

  router.on('GET', '/api/phone-pairings/:id', ({ res, user, params }) => {
    requirePermission(user, 'sources.manage');
    const p = db.get('SELECT * FROM phone_pairings WHERE id = ? AND user_id = ?', params.id, user.id);
    if (!p) throw new HttpError(404, 'not_found', 'That pairing does not exist.');
    const status = p.status === 'pending' && p.expires_at < nowIso() ? 'expired' : p.status;
    const device = p.token_id ? db.get('SELECT id, name FROM agent_tokens WHERE id = ?', p.token_id) : null;
    ok(res, { status, expiresAt: p.expires_at, device });
  });

  router.on('DELETE', '/api/phone-pairings/:id', ({ res, user, params }) => {
    requirePermission(user, 'sources.manage');
    db.run("UPDATE phone_pairings SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'", params.id, user.id);
    ok(res, { cancelled: true });
  });

  router.on('GET', '/api/phone-devices', ({ res, user }) => {
    requirePermission(user, 'sources.manage');
    const rows = db.all(`SELECT t.*, s.name AS source_name, s.last_sync_at, s.last_error AS source_error,
        (SELECT COUNT(*) FROM phone_messages m WHERE m.source_id = t.source_id) AS messages,
        (SELECT COUNT(*) FROM records r WHERE r.source_id = t.source_id) AS records
      FROM agent_tokens t LEFT JOIN sources s ON s.id = t.source_id WHERE t.user_id = ? AND t.kind = 'phone' ORDER BY t.created_at DESC`, user.id);
    ok(res, rows.map(r => {
      const st = parseJson(r.device_status, {});
      const info = parseJson(r.device_info, {});
      const seen = r.last_used_at ? Date.now() - Date.parse(r.last_used_at) : Infinity;
      const connection = r.revoked_at ? 'revoked' : !r.source_id || !r.source_name ? 'removed' : seen < 24 * 3600_000 ? 'connected' : r.last_used_at ? 'not_seen_recently' : 'waiting';
      const sync = connection !== 'connected' ? null : st.permission && st.permission !== 'granted' ? 'needs_permission' : st.pending > 0 ? 'syncing' : st.lastError ? 'error' : 'up_to_date';
      return {
        id: r.id, name: r.name, sourceId: r.source_name ? r.source_id : null, sourceName: r.source_name, createdAt: r.created_at, lastSeenAt: r.last_used_at, revokedAt: r.revoked_at,
        connection, sync, permission: st.permission ?? 'unknown', pending: st.pending ?? null, lastError: st.lastError ?? r.source_error ?? null, lastErrorAt: st.lastErrorAt ?? null,
        lastSyncAt: r.last_sync_at, messages: r.messages, records: r.records,
        device: { model: info.model ?? null, androidVersion: info.androidVersion ?? null, appVersion: info.appVersion ?? null }
      };
    }));
  });

  /** Disconnect a phone: revoke its key; with ?deleteData=true also remove the source and every synced text. */
  router.on('DELETE', '/api/phone-devices/:id', async ({ res, url, user, params, ipHash }) => {
    requirePermission(user, 'sources.manage');
    const row = db.get("SELECT * FROM agent_tokens WHERE id = ? AND tenant_id = ? AND kind = 'phone'", params.id, user.tenantId);
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'not_found', 'That phone does not exist.');
    ok(res, await disconnect(row, user, ipHash, url.searchParams.get('deleteData') === 'true'));
  });

  async function disconnect(token, actor, ipHash, deleteData) {
    if (!token.revoked_at) db.run('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?', nowIso(), token.id);
    audit.write({ tenantId: token.tenant_id, userId: actor.id, action: 'phone.disconnected', targetType: 'source', targetId: token.source_id, ipHash, details: { name: token.name, deleteData } });
    let recordsDeleted = 0;
    const source = deleteData && token.source_id ? db.get('SELECT * FROM sources WHERE id = ?', token.source_id) : null;
    if (source) {
      if (s.running.has(source.id)) throw new HttpError(409, 'sync_running', 'A sync is running. Try again in a moment.');
      db.run('DELETE FROM phone_messages WHERE source_id = ?', source.id);
      recordsDeleted = (await removeSource(s, source, { id: actor.id, tenantId: token.tenant_id }, ipHash)).recordsDeleted;
    }
    return { revoked: true, dataDeleted: Boolean(source), recordsDeleted };
  }

  /* ---------------- phone (no cookies) ---------------- */

  router.on('POST', '/api/phone/pair', async ({ req, res, ip, ipHash }) => {
    realOn();
    const body = validate({
      code: { type: 'string', required: true, max: 20 },
      device: { type: 'object', default: {}, fields: { model: { type: 'string', max: 80, default: '' }, androidVersion: { type: 'string', max: 20, default: '' }, appVersion: { type: 'string', max: 20, default: '' } } }
    }, await readJson(req));
    const limit = wrongCodes.take(`ip:${ip}`);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', 'Too many wrong codes. Wait a few minutes and try again.', { retryAfter: limit.retryAfter });
    const code = normalizeCode(body.code);
    const p = code.length === CODE_LENGTH ? db.get("SELECT * FROM phone_pairings WHERE code_hash = ? AND status = 'pending' AND expires_at > ?", sha256(code), nowIso()) : null;
    if (!p) throw new HttpError(404, 'pairing_code_invalid', 'That code is not valid. Check it on the website; codes expire after 10 minutes and work once.');
    const owner = db.get('SELECT id, tenant_id, name, disabled FROM users WHERE id = ?', p.user_id);
    if (!owner || owner.disabled) throw new HttpError(403, 'pairing_refused', 'The account that made this code can no longer add sources.');
    if (db.run("UPDATE phone_pairings SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'pending'", nowIso(), p.id).changes !== 1) {
      throw new HttpError(404, 'pairing_code_invalid', 'That code was already used.');
    }
    wrongCodes.reset(`ip:${ip}`);
    const device = { model: clean(body.device.model, 80), androidVersion: clean(body.device.androidVersion, 20), appVersion: clean(body.device.appVersion, 20) };
    const name = clean(p.name, 60) || device.model || 'Android phone';
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const sourceId = crypto.randomUUID(), tokenId = crypto.randomUUID();
    const sourceName = `Android texts from ${name} (${owner.name})`;
    db.tx(() => {
      db.run(`INSERT INTO sources (id, tenant_id, owner_user_id, type, name, status, visibility, allowed_roles, scopes, config, account_label, created_at, updated_at)
        VALUES (?, ?, ?, 'messages', ?, 'connected', 'owner', '[]', ?, ?, ?, ?, ?)`, sourceId, owner.tenant_id, owner.id, sourceName,
        JSON.stringify(['sms.receive']), JSON.stringify({ provider: PHONE_PROVIDER, tokenId }), `Android app: ${name}`, nowIso(), nowIso());
      db.run(`INSERT INTO agent_tokens (id, tenant_id, user_id, source_id, name, token_hash, created_at, kind, device_info, device_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'phone', ?, '{}')`, tokenId, owner.tenant_id, owner.id, sourceId, name, sha256(token), nowIso(), JSON.stringify(device));
      db.run('UPDATE phone_pairings SET token_id = ? WHERE id = ?', tokenId, p.id);
    });
    audit.write({ tenantId: owner.tenant_id, userId: owner.id, action: 'phone.paired', targetType: 'source', targetId: sourceId, ipHash, details: { name, model: device.model, appVersion: device.appVersion } });
    ok(res, { token, sourceId, sourceName, deviceName: name, userName: owner.name }, undefined, 201);
  });

  router.on('GET', '/api/phone/status', ({ req, res }) => {
    const { token, source } = phoneFromRequest(req);
    db.run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', nowIso(), token.id);
    const cur = cursorOf(source.id);
    ok(res, { userName: token.user_name, deviceName: token.name, sourceName: source.name, lastSyncAt: source.last_sync_at, cursor: { lastId: cur.lastId, lastDate: cur.lastDate }, messages: cur.messages });
  });

  router.on('POST', '/api/phone/heartbeat', async ({ req, res }) => {
    const { token } = phoneFromRequest(req);
    const body = validate({ status: { ...statusSpec, required: true } }, await readJson(req));
    saveStatus(token.id, body.status);
    ok(res, { saved: true });
  });

  router.on('POST', '/api/phone/messages', async ({ req, res, ipHash }) => {
    const { token, source } = phoneFromRequest(req);
    const body = validate({
      messages: { type: 'array', required: true, max: MAX_BATCH, items: { type: 'object', fields: {
        id: { type: 'int', required: true, min: 0 }, address: { type: 'string', max: 200, default: '' }, contact: { type: 'string', max: 200, default: '' },
        body: { type: 'string', max: 20000, default: '', trim: false }, date: { type: 'int', required: true, min: 1 }, sent: { type: 'bool', default: false } } } },
      status: { ...statusSpec, default: null }
    }, await readJson(req, 16 * 1024 * 1024));

    const ownerLabel = token.user_name || 'Me';
    const touched = new Set();
    let inserted = 0, duplicates = 0, skipped = 0;
    const now = nowIso();
    db.tx(() => {
      for (const m of body.messages) {
        if (!Number.isSafeInteger(m.id) || m.id < 0 || !Number.isFinite(m.date) || m.date <= 0 || !m.body.trim()) { skipped++; continue; }
        const at = new Date(m.date).toISOString();
        const address = clean(m.address, 200) || 'Unknown';
        const key = conversationKey(address);
        const contact = clean(m.contact, 200);
        const label = contact && contact !== address ? `${contact} (${address})` : address;
        const fp = sha256(`${m.date}|${key}|${m.sent ? 1 : 0}|${m.body}`);
        const r = db.run(`INSERT OR IGNORE INTO phone_messages (source_id, device_msg_id, fingerprint, conv_key, conv_label, sent, sent_at, body, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, source.id, m.id, fp, key, label, m.sent ? 1 : 0, at, m.body, now);
        if (r.changes === 1) { inserted++; touched.add(`${key}|${at.slice(0, 10)}`); } else duplicates++;
      }
    });

    // Rebuild each conversation-day that gained texts from everything stored for it, so partial sends never drop texts.
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'messages' };
    const counts = { added: 0, updated: 0, unchanged: 0 };
    for (const k of touched) {
      const [key, day] = k.split('|');
      const msgs = db.all(`SELECT conv_label, sent, sent_at, body FROM phone_messages WHERE source_id = ? AND conv_key = ? AND sent_at >= ? AND sent_at < ? ORDER BY sent_at, device_msg_id`,
        source.id, key, `${day}T`, `${day}U`);
      if (!msgs.length) continue;
      const label = msgs[msgs.length - 1].conv_label;
      const rec = {
        sourceRecordId: `sms:${key}|${day}`,
        title: `SMS: ${label}, ${day}`,
        content: msgs.map(m => `[${m.sent_at.slice(11, 16)}] ${m.sent ? ownerLabel : m.conv_label}: ${m.body}`).join('\n'),
        sender: msgs[0].sent ? ownerLabel : msgs[0].conv_label,
        recipients: [...new Set(msgs.map(m => m.sent ? m.conv_label : ownerLabel))],
        createdAt: msgs[0].sent_at, modifiedAt: msgs[msgs.length - 1].sent_at,
        documentType: 'Text messages', threadKey: `sms:${key}`, accessPermissions: {}
      };
      counts[upsertRecord(db, ctx, rec).status]++;
    }
    if (counts.added || counts.updated) await embedPending(db, s.embedder, source.tenant_id).catch(() => 0);
    db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded', last_error = NULL, status = 'connected', updated_at = ? WHERE id = ?", nowIso(), nowIso(), source.id);
    saveStatus(token.id, body.status ?? {});
    if (inserted) {
      audit.write({ tenantId: source.tenant_id, userId: token.user_id, action: 'phone.texts_received', targetType: 'source', targetId: source.id, ipHash, details: { device: token.name, received: body.messages.length, inserted, duplicates, ...counts } });
    }
    const cur = cursorOf(source.id);
    ok(res, { received: body.messages.length, inserted, duplicates, skipped, ...counts, cursor: { lastId: cur.lastId, lastDate: cur.lastDate }, messages: cur.messages });
  });

  /** The phone disconnects itself (and optionally deletes everything it sent). */
  router.on('POST', '/api/phone/disconnect', async ({ req, res, ipHash }) => {
    const { token } = phoneFromRequest(req);
    const body = validate({ deleteData: { type: 'bool', default: false } }, await readJson(req));
    ok(res, await disconnect(token, { id: token.user_id }, ipHash, body.deleteData));
  });
}
