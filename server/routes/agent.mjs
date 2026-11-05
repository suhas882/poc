// @ts-check
/**
 * PC sync helper: a small program on a Windows PC reads Phone Link's texts and sends them here over HTTPS.
 * This is how a hosted server (Render, AWS, ...) gets Android texts without exports, since it cannot read files on the PC.
 *
 * - Each helper uses its own key (Authorization: Bearer prs_agent_...). Only a hash is stored; keys can be revoked.
 * - A key can only add texts to its own private source; it cannot read, search or change anything else.
 * - Pairing by code: the helper asks for a pairing and shows a short code; a signed-in person types it on the website,
 *   and the helper then collects its key once. Nobody has to copy the long key by hand.
 */
import crypto from 'node:crypto';
import { HttpError, ok, readJson, validate } from '../http.mjs';
import { requirePermission } from '../auth.mjs';
import { nowIso } from '../db.mjs';
import { RateLimiter, sha256 } from '../security.mjs';
import { groupConversations } from '../ingest/messages.mjs';
import { embedPending, upsertRecord } from '../ingest/pipeline.mjs';

const TOKEN_PREFIX = 'prs_agent_';
const MAX_BATCH = 2000;
// Pairing codes: 8 characters with no look-alikes (no 0/O, 1/I/L), shown as ABCD-2345: about 850 billion possibilities.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_POLL_SECONDS = 3;
const MAX_OPEN_PAIRINGS = 500;

/** Uppercase and drop spaces and dashes, so "abcd 2345" and "ABCD-2345" match. */
export const normalizePairingCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const newPairingCode = () => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
const showCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;

/** @param {import('../http.mjs').Router} router */
export function registerAgentRoutes(router, s) {
  const { db, audit } = s;

  /** Authenticate a helper by its bearer key. */
  function agentFromRequest(req) {
    if (!s.config.realSources) throw new HttpError(403, 'real_sources_off', 'This server only holds Tier 0 data. It does not accept texts.');
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(prs_agent_[A-Za-z0-9_-]{20,})$/.exec(auth);
    if (!m) throw new HttpError(401, 'agent_key_missing', 'Send the helper key as "Authorization: Bearer prs_agent_...".');
    const row = db.get(`SELECT t.*, u.name AS user_name, u.disabled, u.role FROM agent_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`, sha256(m[1]));
    if (!row || row.revoked_at || row.disabled) throw new HttpError(401, 'agent_key_invalid', 'This helper key is not valid. It may have been revoked; create a new one in Connected Sources.');
    const source = db.get("SELECT * FROM sources WHERE id = ? AND status NOT IN ('disconnected', 'pending_approval')", row.source_id);
    if (!source) throw new HttpError(401, 'agent_key_invalid', 'The source for this key was removed. Create a new key in Connected Sources.');
    return { token: row, source };
  }

  /* ---- managing keys (signed-in staff) ---- */

  router.on('GET', '/api/agent-tokens', ({ res, user }) => {
    requirePermission(user, 'sources.manage');
    ok(res, db.all(`SELECT t.id, t.name, t.created_at, t.last_used_at, t.revoked_at, t.source_id, s.name AS source_name,
        (SELECT COUNT(*) FROM records r WHERE r.source_id = t.source_id) AS records
      FROM agent_tokens t LEFT JOIN sources s ON s.id = t.source_id WHERE t.user_id = ? ORDER BY t.created_at DESC`, user.id)
      .map(r => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at, sourceId: r.source_id, sourceName: r.source_name, records: r.records })));
  });

  /** Create a helper key and its private source. Returns the key itself, which is never stored. */
  function createKey(user, name, ipHash, via) {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const sourceId = crypto.randomUUID(), id = crypto.randomUUID();
    db.tx(() => {
      db.run(`INSERT INTO sources (id, tenant_id, owner_user_id, type, name, status, visibility, allowed_roles, scopes, config, account_label, created_at, updated_at)
        VALUES (?, ?, ?, 'messages', ?, 'connected', 'owner', '[]', ?, ?, ?, ?, ?)`, sourceId, user.tenantId, user.id, `Android texts from ${name} (${user.name})`,
        JSON.stringify(['texts.receive']), JSON.stringify({ provider: 'phonelink-agent', tokenId: id }), `PC sync helper: ${name}`, nowIso(), nowIso());
      db.run('INSERT INTO agent_tokens (id, tenant_id, user_id, source_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user.tenantId, user.id, sourceId, name, sha256(token), nowIso());
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'agent.key_created', targetType: 'source', targetId: sourceId, ipHash, details: { name, via } });
    return { id, sourceId, token };
  }

  router.on('POST', '/api/agent-tokens', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'sources.manage');
    s.realGate(user);
    const body = validate({ name: { type: 'string', required: true, min: 1, max: 60 }, acknowledged: { type: 'bool', required: true } }, await readJson(req));
    if (body.acknowledged !== true) throw new HttpError(400, 'not_acknowledged', 'Confirm that these are your own texts and that you may index them.');
    ok(res, createKey(user, body.name.trim(), ipHash, 'key'), undefined, 201);
  });

  router.on('DELETE', '/api/agent-tokens/:id', ({ res, user, params, ipHash }) => {
    requirePermission(user, 'sources.manage');
    const row = db.get('SELECT * FROM agent_tokens WHERE id = ? AND tenant_id = ?', params.id, user.tenantId);
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'not_found', 'That helper key does not exist.');
    if (!row.revoked_at) db.run('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'agent.key_revoked', targetType: 'source', targetId: row.source_id, ipHash, details: { name: row.name } });
    ok(res, { revoked: true });
  });

  /* ---- called by the helper (bearer key, no cookies) ---- */

  router.on('GET', '/api/agent/whoami', ({ req, res }) => {
    const { token, source } = agentFromRequest(req);
    db.run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', nowIso(), token.id);
    const records = db.get('SELECT COUNT(*) AS n FROM records WHERE source_id = ?', source.id).n;
    ok(res, { userName: token.user_name, keyName: token.name, sourceId: source.id, sourceName: source.name, records });
  });

  router.on('POST', '/api/agent/messages', async ({ req, res, ipHash }) => {
    const { token, source } = agentFromRequest(req);
    const str = (max) => ({ type: 'string', max, default: '' });
    const body = validate({
      messages: { type: 'array', required: true, max: MAX_BATCH, items: { type: 'object', fields: {
        conversation: { type: 'string', max: 200, required: true }, from: str(200), to: str(200),
        at: { type: 'string', max: 40, default: null }, body: { type: 'string', max: 20000, required: true } } } },
      helperVersion: str(20)
    }, await readJson(req, 8 * 1024 * 1024));
    const messages = body.messages.map(m => ({ ...m, at: m.at && !Number.isNaN(Date.parse(m.at)) ? new Date(m.at).toISOString() : null }));
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'messages' };
    const counts = { added: 0, updated: 0, unchanged: 0 };
    for (const g of groupConversations(messages, 'SMS')) counts[upsertRecord(db, ctx, { ...g, documentType: 'Text messages', accessPermissions: {} }).status]++;
    if (counts.added || counts.updated) await embedPending(db, s.embedder, source.tenant_id).catch(() => 0);
    db.run("UPDATE sources SET last_sync_at = ?, last_sync_status = 'succeeded', last_error = NULL, status = 'connected', updated_at = ? WHERE id = ?", nowIso(), nowIso(), source.id);
    db.run('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?', nowIso(), token.id);
    if (counts.added || counts.updated) {
      audit.write({ tenantId: source.tenant_id, userId: token.user_id, action: 'agent.texts_received', targetType: 'source', targetId: source.id, ipHash, details: { key: token.name, messages: messages.length, ...counts } });
    }
    ok(res, { received: messages.length, ...counts });
  });

  /* ---- pairing by code ---- */

  // Wrong codes typed on the website, per person. Together with the 10-minute lifetime this makes guessing hopeless.
  const wrongCodes = new RateLimiter(10, 15 * 60_000);
  const sweepPairings = () => db.run("DELETE FROM agent_pairings WHERE expires_at < ?", new Date(Date.now() - 24 * 3600_000).toISOString());

  // Called by the helper, which has no key yet.
  router.on('POST', '/api/agent/pair/start', async ({ req, res }) => {
    if (!s.config.realSources) throw new HttpError(403, 'real_sources_off', 'This server only holds Tier 0 data. It does not accept texts.');
    const body = validate({ pcName: { type: 'string', max: 60, default: '' }, helperVersion: { type: 'string', max: 20, default: '' } }, await readJson(req));
    sweepPairings();
    if (db.get("SELECT COUNT(*) AS n FROM agent_pairings WHERE status = 'pending' AND expires_at > ?", nowIso()).n >= MAX_OPEN_PAIRINGS) {
      throw new HttpError(429, 'too_many_pairings', 'Too many pairings are waiting. Try again in a few minutes.');
    }
    const deviceCode = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
    const pcName = body.pcName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    for (let attempt = 0; ; attempt++) {
      const code = newPairingCode();
      try {
        db.run('INSERT INTO agent_pairings (id, user_code_hash, device_code_hash, pc_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), sha256(code), sha256(deviceCode), pcName, nowIso(), expiresAt);
        ok(res, { deviceCode, userCode: showCode(code), expiresIn: PAIRING_TTL_MS / 1000, interval: PAIRING_POLL_SECONDS, verifyUrl: s.config.publicUrl }, undefined, 201);
        return;
      } catch (err) { if (attempt >= 4) throw err; } // the same code is already in use: pick another
    }
  });

  // Called by the helper every few seconds until someone types its code on the website. The key is handed out once.
  router.on('POST', '/api/agent/pair/poll', async ({ req, res, ipHash }) => {
    const body = validate({ deviceCode: { type: 'string', required: true, max: 100 } }, await readJson(req));
    const p = db.get('SELECT * FROM agent_pairings WHERE device_code_hash = ?', sha256(body.deviceCode));
    if (!p || p.status === 'claimed') throw new HttpError(404, 'pairing_not_found', 'This pairing is not known or was already used. Start pairing again.');
    if (p.status === 'pending') {
      if (p.expires_at < nowIso()) throw new HttpError(410, 'pairing_expired', 'The pairing code expired before it was entered. Start pairing again.');
      ok(res, { status: 'pending' });
      return;
    }
    const owner = db.get('SELECT id, tenant_id, name, disabled FROM users WHERE id = ?', p.user_id);
    if (!owner || owner.disabled) throw new HttpError(403, 'pairing_refused', 'The account that approved this pairing can no longer add sources. Start pairing again.');
    // Claim first, so two polls at once cannot both receive a key.
    if (db.run("UPDATE agent_pairings SET status = 'claimed' WHERE id = ? AND status = 'approved'", p.id).changes !== 1) {
      throw new HttpError(404, 'pairing_not_found', 'This pairing was already used. Start pairing again.');
    }
    const key = createKey({ id: owner.id, tenantId: owner.tenant_id, name: owner.name }, p.name, ipHash, 'pairing');
    db.run('UPDATE agent_pairings SET token_id = ? WHERE id = ?', key.id, p.id);
    ok(res, { status: 'approved', token: key.token, keyName: p.name, userName: owner.name });
  });

  // Called by a signed-in person who types the code the helper shows.
  router.on('POST', '/api/agent-pairings', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'sources.manage');
    s.realGate(user);
    const body = validate({ code: { type: 'string', required: true, max: 20 }, name: { type: 'string', max: 60, default: '' }, acknowledged: { type: 'bool', required: true } }, await readJson(req));
    if (body.acknowledged !== true) throw new HttpError(400, 'not_acknowledged', 'Confirm that these are your own texts and that you may index them.');
    const limit = wrongCodes.take(`u:${user.id}`);
    if (!limit.allowed) throw new HttpError(429, 'rate_limited', 'Too many wrong codes. Wait a few minutes and try again.', { retryAfter: limit.retryAfter });
    const code = normalizePairingCode(body.code);
    const p = code.length === CODE_LENGTH ? db.get("SELECT * FROM agent_pairings WHERE user_code_hash = ? AND status = 'pending' AND expires_at > ?", sha256(code), nowIso()) : null;
    if (!p) throw new HttpError(404, 'pairing_code_invalid', 'That code is not valid. Check it against the helper window; codes expire after 10 minutes.');
    wrongCodes.reset(`u:${user.id}`);
    const name = body.name.trim() || p.pc_name || 'My PC';
    db.run("UPDATE agent_pairings SET status = 'approved', tenant_id = ?, user_id = ?, name = ?, approved_at = ? WHERE id = ? AND status = 'pending'", user.tenantId, user.id, name, nowIso(), p.id);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'agent.pairing_approved', targetType: 'agent_pairing', targetId: p.id, ipHash, details: { name, pcName: p.pc_name } });
    ok(res, { paired: true, name, pcName: p.pc_name });
  });
}
