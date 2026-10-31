// @ts-check
/**
 * PC sync helper: a small program on a Windows PC reads Phone Link's texts and sends them here over HTTPS.
 * This is how a hosted server (Render, AWS, ...) gets Android texts without exports, since it cannot read files on the PC.
 *
 * - Each helper uses its own key (Authorization: Bearer prs_agent_...). Only a hash is stored; keys can be revoked.
 * - A key can only add texts to its own private source; it cannot read, search or change anything else.
 */
import crypto from 'node:crypto';
import { HttpError, ok, readJson, validate } from '../http.mjs';
import { requirePermission } from '../auth.mjs';
import { nowIso } from '../db.mjs';
import { sha256 } from '../security.mjs';
import { groupConversations } from '../ingest/messages.mjs';
import { embedPending, upsertRecord } from '../ingest/pipeline.mjs';

const TOKEN_PREFIX = 'prs_agent_';
const MAX_BATCH = 2000;

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
    const source = db.get("SELECT * FROM sources WHERE id = ? AND status != 'disconnected'", row.source_id);
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

  router.on('POST', '/api/agent-tokens', async ({ req, res, user, ipHash }) => {
    requirePermission(user, 'sources.manage');
    s.realGate(user);
    const body = validate({ name: { type: 'string', required: true, min: 1, max: 60 }, acknowledged: { type: 'bool', required: true } }, await readJson(req));
    if (body.acknowledged !== true) throw new HttpError(400, 'not_acknowledged', 'Confirm that these are your own texts and that you may index them.');
    const name = body.name.trim();
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const sourceId = crypto.randomUUID(), id = crypto.randomUUID();
    db.tx(() => {
      db.run(`INSERT INTO sources (id, tenant_id, owner_user_id, type, name, status, visibility, allowed_roles, scopes, config, account_label, created_at, updated_at)
        VALUES (?, ?, ?, 'messages', ?, 'connected', 'owner', '[]', ?, ?, ?, ?, ?)`, sourceId, user.tenantId, user.id, `Android texts from ${name} (${user.name})`,
        JSON.stringify(['texts.receive']), JSON.stringify({ provider: 'phonelink-agent', tokenId: id }), `PC sync helper: ${name}`, nowIso(), nowIso());
      db.run('INSERT INTO agent_tokens (id, tenant_id, user_id, source_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, user.tenantId, user.id, sourceId, name, sha256(token), nowIso());
    });
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'agent.key_created', targetType: 'source', targetId: sourceId, ipHash, details: { name } });
    ok(res, { id, sourceId, token }, undefined, 201);
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
}
