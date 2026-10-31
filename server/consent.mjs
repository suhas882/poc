// @ts-check
/**
 * Search permission: after signing in, people who can search must choose what the app may search for them
 * (everything they can access, or only sources they pick). Real data searches are blocked until they answer.
 * Bump CONSENT_VERSION when the wording of the permission screen changes; everyone is asked again.
 */
import { parseJson } from './db.mjs';
import { can } from './auth.mjs';

export const CONSENT_VERSION = 1;

/** @param {import('./db.mjs').Database} db */
export function getConsent(db, userId) {
  const row = db.get('SELECT * FROM user_consents WHERE user_id = ?', userId);
  if (!row || row.version < CONSENT_VERSION) return null;
  return { scope: row.scope, sourceIds: parseJson(row.source_ids, []), grantedAt: row.granted_at, updatedAt: row.updated_at, version: row.version };
}

/** True when this user must answer the permission screen before searching real data. */
export function consentRequired(db, user) {
  return Boolean(user && can(user, 'search.run') && !getConsent(db, user.id));
}

/** Narrow a list of searchable sources to what the user allowed. Synthetic (demo) sources are never affected. */
export function applyConsent(db, user, sources) {
  const c = getConsent(db, user.id);
  if (!c) return [];
  if (c.scope === 'all') return sources;
  const allowed = new Set(c.sourceIds);
  return sources.filter(s => s.type === 'synthetic' || allowed.has(s.id));
}
