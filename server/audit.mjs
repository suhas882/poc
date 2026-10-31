// @ts-check
import crypto from 'node:crypto';
import { scrub } from './security.mjs';

/**
 * Append-only, tamper-evident audit trail. Each event stores the hash of the previous event for the same
 * organization and its own hash over its contents, so editing or deleting a row in the middle breaks the chain.
 * This is tamper-evident, not tamper-proof: someone with database access could rewrite the whole chain.
 * Record content is never written here.
 */
const canonical = (row) => JSON.stringify([row.tenant_id ?? '', row.user_id ?? '', row.action, row.target_type ?? '', row.target_id ?? '',
  row.outcome, row.ip_hash ?? '', row.details ?? '{}', row.before_value ?? '', row.after_value ?? '', row.created_at]);
export const eventHash = (prev, row) => crypto.createHash('sha256').update(`${prev ?? ''}|${canonical(row)}`).digest('hex');

export class AuditLog {
  /** @param {import('./db.mjs').Database} db */
  constructor(db) { this.db = db; }

  /**
   * @param {{tenantId?: string | null, userId?: string | null, action: string, targetType?: string, targetId?: string | null,
   *   outcome?: 'success' | 'failure' | 'denied', ipHash?: string | null, details?: Record<string, unknown>, before?: unknown, after?: unknown}} e
   */
  write(e) {
    const row = {
      tenant_id: e.tenantId ?? null, user_id: e.userId ?? null, action: e.action, target_type: e.targetType ?? null, target_id: e.targetId ?? null,
      outcome: e.outcome ?? 'success', ip_hash: e.ipHash ?? null, details: JSON.stringify(scrub(e.details ?? {})),
      before_value: e.before === undefined ? null : JSON.stringify(e.before), after_value: e.after === undefined ? null : JSON.stringify(e.after),
      created_at: new Date().toISOString()
    };
    const prev = this.lastHash(row.tenant_id);
    const hash = eventHash(prev, row);
    this.db.run(`INSERT INTO audit_events (tenant_id, user_id, action, target_type, target_id, outcome, ip_hash, details, before_value, after_value, created_at, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.tenant_id, row.user_id, row.action, row.target_type, row.target_id, row.outcome, row.ip_hash,
    row.details, row.before_value, row.after_value, row.created_at, prev, hash);
  }

  lastHash(tenantId) {
    return this.db.get('SELECT hash FROM audit_events WHERE tenant_id IS ? AND hash IS NOT NULL ORDER BY id DESC LIMIT 1', tenantId)?.hash ?? null;
  }

  /** Give rows written before the chain existed their hashes, in order. */
  backfill() {
    const rows = this.db.all('SELECT * FROM audit_events WHERE hash IS NULL ORDER BY id');
    if (!rows.length) return 0;
    const last = new Map();
    this.db.tx(() => {
      for (const r of rows) {
        const key = r.tenant_id ?? null;
        const prev = last.has(key) ? last.get(key) : this.db.get('SELECT hash FROM audit_events WHERE tenant_id IS ? AND hash IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1', key, r.id)?.hash ?? null;
        const hash = eventHash(prev, r);
        this.db.run('UPDATE audit_events SET prev_hash = ?, hash = ? WHERE id = ?', prev, hash, r.id);
        last.set(key, hash);
      }
    });
    return rows.length;
  }

  /**
   * Re-compute the chain for one organization. The oldest remaining row is the anchor (older rows may have been
   * removed by the retention policy, which is itself logged).
   * @returns {{ok: boolean, checked: number, firstBroken: null | {id: number, createdAt: string, action: string, problem: string}, anchor: string | null}}
   */
  verify(tenantId) {
    const rows = this.db.all('SELECT * FROM audit_events WHERE tenant_id IS ? ORDER BY id', tenantId);
    let prev = rows[0]?.prev_hash ?? null;
    for (const [i, r] of rows.entries()) {
      const problem = r.prev_hash !== prev ? 'Its link to the previous entry does not match (an entry before it was changed or removed).'
        : eventHash(r.prev_hash, r) !== r.hash ? 'Its contents were changed after it was written.' : null;
      if (problem) return { ok: false, checked: i, firstBroken: { id: r.id, createdAt: r.created_at, action: r.action, problem }, anchor: rows[0]?.created_at ?? null };
      prev = r.hash;
    }
    return { ok: true, checked: rows.length, firstBroken: null, anchor: rows[0]?.created_at ?? null };
  }
}

/** Human-readable names for audit actions, shown in the Audit Logs page. */
export const AUDIT_ACTIONS = Object.freeze({
  'auth.setup': 'Created the first supervisor account',
  'auth.login': 'Signed in',
  'auth.demo': 'Started a demo session',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'user.created': 'Created a user',
  'user.updated': 'Changed a user',
  'request.created': 'Logged a request',
  'request.updated': 'Changed request details',
  'plan.drafted': 'Drafted a search plan',
  'plan.edited': 'Edited the search plan',
  'plan.confirmed': 'Confirmed and locked the search plan',
  'plan.terms_added': 'Added terms from relevant records',
  'plan.terms_rejected': 'Rejected suggested terms',
  'clarification.drafted': 'Drafted clarification questions',
  'search.run': 'Ran a search',
  'search.refused': 'Refused a search',
  'search.planned': 'Drafted a search plan',
  'record.viewed': 'Opened a record',
  'mark.saved': 'Marked a candidate',
  'mark.routed': 'Routed a candidate',
  'custodian.updated': 'Updated a custodian check',
  'export.created': 'Exported',
  'export.check_recorded': 'Recorded an export check',
  'report.handed_off': 'Marked handed to city process',
  'report.approved': 'Approved the search record',
  'source.connected': 'Connected a source',
  'source.updated': 'Changed source access',
  'source.synced': 'Synchronized a source',
  'source.disconnected': 'Disconnected a source',
  'source.oauth_started': 'Started an account connection',
  'upload.ingested': 'Added a document',
  'upload.deleted': 'Deleted an uploaded file',
  'evaluation.saved': 'Recorded a relevance decision',
  'evaluation.label_saved': 'Saved a test set label',
  'settings.updated': 'Changed settings',
  'pack.switched': 'Switched the city pack',
  'consent.granted': 'Gave search permission',
  'consent.changed': 'Changed search permission',
  'consent.withdrawn': 'Withdrew search permission',
  'texts.reviewed': 'Reviewed own text matches',
  'texts.sent': 'Sent city-business texts to the clerk',
  'agent.key_created': 'Created a PC sync helper key',
  'agent.key_revoked': 'Revoked a PC sync helper key',
  'agent.texts_received': 'Received texts from a PC sync helper',
  'retention.applied': 'Applied retention policy',
  'access.denied': 'Blocked an action'
});
