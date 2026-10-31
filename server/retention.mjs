// @ts-check
/** Retention policy: removes old search history, audit events and AI usage rows; tidies sessions and index rows. */

/** @param {import('./db.mjs').Database} db @param {import('./config.mjs').AppConfig} config @param {import('./audit.mjs').AuditLog} audit */
export function applyRetention(db, config, audit) {
  const before = (days) => new Date(Date.now() - days * 86400_000).toISOString();
  const r = config.retention;
  const searches = db.run('DELETE FROM search_requests WHERE created_at < ?', before(r.searchHistoryDays)).changes;
  const events = db.run('DELETE FROM audit_events WHERE created_at < ?', before(r.auditDays)).changes;
  const usage = db.run('DELETE FROM ai_usage WHERE created_at < ?', before(r.aiUsageDays)).changes;
  // Demo workspaces hold only invented records; they are removed after three days.
  const demos = db.run('DELETE FROM tenants WHERE is_demo = 1 AND created_at < ?', before(3)).changes;
  if (demos) db.run('DELETE FROM chunks WHERE record_id NOT IN (SELECT id FROM records)');
  db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  db.run('DELETE FROM oauth_states WHERE expires_at < ?', new Date().toISOString());
  db.run('DELETE FROM chunk_fts WHERE rowid NOT IN (SELECT id FROM chunks)');
  if (searches || events || usage) audit.write({ action: 'retention.applied', details: { searches: Number(searches), auditEvents: Number(events), aiUsage: Number(usage) } });
  return { searches: Number(searches), auditEvents: Number(events), aiUsage: Number(usage) };
}
