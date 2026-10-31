// @ts-check
import { scrub } from './security.mjs';

/**
 * Append-only audit trail. Details are scrubbed of secret-looking keys and
 * long strings; record content is never written here.
 */
export class AuditLog {
  /** @param {import('./db.mjs').Database} db */
  constructor(db) { this.db = db; }

  /**
   * @param {{tenantId?: string | null, userId?: string | null, action: string, targetType?: string, targetId?: string | null,
   *   outcome?: 'success' | 'failure' | 'denied', ipHash?: string | null, details?: Record<string, unknown>}} e
   */
  write(e) {
    this.db.run(
      'INSERT INTO audit_events (tenant_id, user_id, action, target_type, target_id, outcome, ip_hash, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      e.tenantId ?? null, e.userId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.outcome ?? 'success',
      e.ipHash ?? null, JSON.stringify(scrub(e.details ?? {})), new Date().toISOString()
    );
  }
}

/** Human-readable names for audit actions, shown in the Audit Logs page. */
export const AUDIT_ACTIONS = Object.freeze({
  'auth.setup': 'Created the first administrator',
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'user.created': 'Created a user',
  'user.updated': 'Changed a user',
  'search.planned': 'Drafted a search plan',
  'search.run': 'Ran a search',
  'search.summarized': 'Summarized results',
  'record.viewed': 'Opened a record',
  'export.created': 'Exported results',
  'source.connected': 'Connected a source',
  'source.updated': 'Changed source access',
  'source.synced': 'Synchronized a source',
  'source.disconnected': 'Disconnected a source',
  'source.oauth_started': 'Started an account connection',
  'upload.ingested': 'Uploaded a file',
  'upload.deleted': 'Deleted an uploaded file',
  'evaluation.saved': 'Recorded a relevance decision',
  'settings.updated': 'Changed settings',
  'consent.granted': 'Gave search permission',
  'consent.changed': 'Changed search permission',
  'consent.withdrawn': 'Withdrew search permission',
  'retention.applied': 'Applied retention policy',
  'access.denied': 'Blocked an action'
});
