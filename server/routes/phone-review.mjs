// @ts-check
/**
 * Phone Link texts, employee self-review (experimental, behind the admin switch).
 * When a confirmed plan includes an employee's phone source, matching texts are shown to that employee first.
 * The employee marks each match City business, Personal or Unsure, ticks an attestation, and sends only the
 * City business items to the clerk. The clerk and the tool never browse a phone. Matching is local; no text
 * content goes to a model (hard rule in code, not a setting).
 */
import { HttpError, ok, readJson, validate } from '../http.mjs';
import { nowIso, parseJson } from '../db.mjs';
import { ftsQuery, snippetAround, termsIn } from '../search/hybrid.mjs';
import { activePack, switches } from '../packs.mjs';

const PERSONAL_CUES = /\b(love|babe|honey|mom|dad|mum|kids?|son|daughter|dinner|lunch|birthday|doctor|dentist|clinic|pharmacy|church|date night|miss you|xoxo|home soon|groceries)\b/i;

/** @param {import('../http.mjs').Router} router */
export function registerPhoneReviewRoutes(router, s) {
  const { db, audit, config } = s;

  function gate(user) {
    if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.');
    if (!switches(db, user.tenantId, config).phoneLink) throw new HttpError(404, 'phonelink_off', 'Phone Link texts are switched off.');
  }
  const mySources = (user) => db.all("SELECT * FROM sources WHERE tenant_id = ? AND owner_user_id = ? AND type = 'messages' AND status != 'disconnected'", user.tenantId, user.id)
    .filter(src => String(parseJson(src.config, {}).provider || '').startsWith('phonelink'));

  /** Requests whose latest confirmed plan includes one of this employee's phone sources, with the employee's matches. */
  function queue(user) {
    const pack = activePack(db, user.tenantId);
    const mine = mySources(user);
    if (!mine.length) return [];
    const ids = new Set(mine.map(x => x.id));
    const reqs = db.all(`SELECT q.*, pv.plan, pv.source_ids, pv.version FROM search_requests q JOIN plan_versions pv ON pv.search_id = q.id
      WHERE q.tenant_id = ? AND pv.status = 'confirmed' AND pv.version = (SELECT MAX(version) FROM plan_versions WHERE search_id = q.id AND status = 'confirmed') ORDER BY q.created_at DESC`, user.tenantId);
    const out = [];
    for (const q of reqs) {
      const chosen = parseJson(q.source_ids, []).filter(id => ids.has(id));
      if (!chosen.length) continue;
      const plan = parseJson(q.plan, {});
      const terms = [...(plan.keywords || []), ...(plan.phrases || []), ...(plan.alternateTerms || []), ...(plan.people || []), ...(plan.locations || [])];
      const fq = ftsQuery(terms);
      if (!fq) continue;
      const rows = db.all(`SELECT DISTINCT r.id, r.title, r.content, r.created_at FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid JOIN records r ON r.id = c.record_id
        WHERE chunk_fts MATCH ? AND r.source_id IN (${chosen.map(() => '?').join(',')}) ORDER BY r.created_at DESC LIMIT 200`, fq, ...chosen);
      const items = rows.map(r => {
        const rev = db.get('SELECT * FROM text_reviews WHERE search_id = ? AND record_id = ?', q.id, r.id);
        const hits = termsIn(`${r.title}\n${r.content}`, terms);
        return { recordId: r.id, title: r.title, date: r.created_at, matched: hits.slice(0, 4), personalLooking: PERSONAL_CUES.test(r.content),
          preview: snippetAround(r.content, hits, 220), decision: rev?.decision ?? null, sentAt: rev?.sent_at ?? null };
      });
      out.push({ requestId: q.id, ref: q.ref, request: q.request_text, planVersion: q.version, items, sent: items.filter(i => i.sentAt).length });
    }
    void pack;
    return out;
  }

  router.on('GET', '/api/phone-review', ({ res, user }) => {
    gate(user);
    ok(res, { sources: mySources(user).map(x => ({ id: x.id, name: x.name })), requests: queue(user),
      limits: ['Android only.', 'Recent texts only: what Phone Link has synced.', 'No picture messages.', 'Not a search of all texts.'],
      banner: 'Texts stay on this PC and are never sent to an AI model. Only items you mark City business and send reach the clerk.' });
  });

  router.on('PUT', '/api/phone-review/:requestId/:recordId', async ({ req, res, user, params, ipHash }) => {
    gate(user);
    const body = validate({ decision: { type: 'string', required: true, values: ['city', 'personal', 'unsure'] } }, await readJson(req));
    const q = queue(user).find(x => x.requestId === params.requestId);
    const item = q?.items.find(i => i.recordId === params.recordId);
    if (!q || !item) throw new HttpError(404, 'not_found', 'That text is not one of your matches for this request.');
    if (item.sentAt) throw new HttpError(409, 'already_sent', 'This item was already sent to the clerk.');
    db.run(`INSERT INTO text_reviews (search_id, record_id, owner_user_id, decision, decided_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (search_id, record_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at`, q.requestId, item.recordId, user.id, body.decision, nowIso());
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'texts.reviewed', targetType: 'request', targetId: q.requestId, ipHash, details: { ref: q.ref }, before: item.decision, after: body.decision });
    ok(res, { saved: true });
  });

  router.on('POST', '/api/phone-review/:requestId/send', async ({ req, res, user, params, ipHash }) => {
    gate(user);
    const body = validate({ attested: { type: 'bool', required: true } }, await readJson(req));
    if (body.attested !== true) throw new HttpError(400, 'not_attested', 'Tick the attestation before sending.');
    const q = queue(user).find(x => x.requestId === params.requestId);
    if (!q) throw new HttpError(404, 'not_found', 'No matches for that request.');
    const city = q.items.filter(i => i.decision === 'city' && !i.sentAt);
    const now = nowIso();
    for (const i of city) db.run('UPDATE text_reviews SET sent_at = ? WHERE search_id = ? AND record_id = ?', now, q.requestId, i.recordId);
    audit.write({ tenantId: user.tenantId, userId: user.id, action: 'texts.sent', targetType: 'request', targetId: q.requestId, ipHash,
      details: { ref: q.ref, sent: city.length, personal: q.items.filter(i => i.decision === 'personal').length, unsure: q.items.filter(i => i.decision === 'unsure').length, unmarked: q.items.filter(i => !i.decision).length, attested: true } });
    ok(res, { sent: city.length });
  });
}
