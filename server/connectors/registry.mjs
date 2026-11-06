// @ts-check
/**
 * Connector registry: one place that knows every source type, how it authenticates, whether it synchronizes,
 * which connector object does the work, and what lifecycle state a source is in.
 *
 * Every syncing connector exposes the same surface: sync(source, {full, diag}) → counts, and disconnect(source)
 * → {revoked}. Uploads, message imports and public documents are written by explicit imports instead.
 *
 * Lifecycle (shown on Connected Sources):
 *   authorization_required → pending_approval → connected → syncing → indexed
 *   plus reauthorization_required, error, disconnected, and (for connector types) needs_setup and unsupported.
 */
import { parseJson } from '../db.mjs';
import { switches } from '../packs.mjs';
import { isPhoneLink } from './phonelink.mjs';

/** @typedef {'oauth' | 'credentials' | 'local' | 'import' | 'none'} AuthKind */
/** @type {Record<string, {category: string, auth: AuthKind, syncs: boolean}>} */
export const SOURCE_TYPES = Object.freeze({
  gmail: { category: 'email', auth: 'oauth', syncs: true },
  outlook: { category: 'email', auth: 'oauth', syncs: true },
  gdrive: { category: 'files', auth: 'oauth', syncs: true },
  onedrive: { category: 'files', auth: 'oauth', syncs: true },
  sharepoint: { category: 'files', auth: 'oauth', syncs: true },
  teams: { category: 'messages', auth: 'oauth', syncs: true },
  database: { category: 'databases', auth: 'credentials', syncs: true },
  uploads: { category: 'imports', auth: 'import', syncs: false },
  messages: { category: 'messages', auth: 'import', syncs: false },
  synthetic: { category: 'demo', auth: 'none', syncs: false }
});

export const CATEGORY_LABEL = Object.freeze({
  email: 'Email', files: 'Files and documents', messages: 'Text messages', databases: 'Databases', imports: 'Uploads and imports', demo: 'Demo data', planned: 'Not available yet'
});


/**
 * Who can search a newly connected source. Private to the person who connected it ("Only me") unless they
 * explicitly choose otherwise: "org" shares with everyone in the organization who can search, "roles" with the
 * listed roles. Older clients that send only a non-empty shareWithRoles list mean those roles.
 * Existing sources keep whatever sharing they already have; this only decides the start for new ones.
 * @param {{visibility?: string, shareWithRoles?: string[]}} opts
 * @returns {{visibility: 'owner' | 'roles', allowedRoles: string[]}}
 */
export function initialSharing({ visibility, shareWithRoles } = {}) {
  const roles = Array.isArray(shareWithRoles) ? shareWithRoles : [];
  if (visibility === 'org') return { visibility: 'roles', allowedRoles: [] };
  if ((visibility === 'roles' || visibility === undefined) && roles.length) return { visibility: 'roles', allowedRoles: roles };
  return { visibility: 'owner', allowedRoles: [] };
}

/**
 * Turn an OAuth error a provider sent back to the redirect URI into the actual reason and what to do about it.
 * @param {'google' | 'microsoft'} provider @param {string} error @param {string} [description]
 */
export function explainOAuthError(provider, error, description = '') {
  const d = String(description || '').split(/\r?\n/)[0].slice(0, 220);
  const aad = /AADSTS(\d+)/.exec(d)?.[1];
  if (provider === 'microsoft' && aad) {
    const known = {
      '65001': 'The app needs consent that has not been given. In a work tenant an administrator may have to grant it (Entra admin center: Enterprise applications, Permissions, Grant admin consent).',
      '90094': 'An administrator has to approve these permissions for your organization before you can connect.',
      '90008': 'An administrator has to approve these permissions for your organization before you can connect.',
      '50011': 'The redirect URI does not match the app registration. Add the exact address shown in Settings under Server configuration to Authentication in the app registration.',
      '700016': 'Microsoft does not know this app in that directory. Check MICROSOFT_CLIENT_ID and that Supported account types include this kind of account.',
      '50020': 'This kind of account is not allowed by the app registration. Set Supported account types to include personal Microsoft accounts and organizational accounts.',
      '50194': 'The app registration is single-tenant. Set MICROSOFT_TENANT to that tenant, or allow other account types.',
      '7000215': 'MICROSOFT_CLIENT_SECRET is wrong. Create a new client secret and copy its Value (not its ID).',
      '7000222': 'MICROSOFT_CLIENT_SECRET has expired. Create a new client secret and copy its Value.',
      '70011': 'Microsoft refused a requested permission (invalid scope).'
    };
    return `${known[aad] || 'Microsoft refused the sign-in.'} (AADSTS${aad}: ${d})`;
  }
  const g = {
    access_denied: provider === 'google'
      ? 'Access was not granted on Google’s consent screen, so nothing was connected. If you did not cancel, check that your Google account is on the app’s test-user list (OAuth consent screen, Audience).'
      : 'Access was not granted on Microsoft’s sign-in page, so nothing was connected.',
    consent_required: 'Consent is required before this can connect. An administrator may have to grant it.',
    invalid_scope: provider === 'google'
      ? 'Google refused a requested permission (invalid_scope). Add gmail.readonly and drive.readonly under Data access on the OAuth consent screen.'
      : 'Microsoft refused a requested permission (invalid_scope). Add Mail.Read, Files.Read, Sites.Read.All and User.Read as delegated Microsoft Graph permissions.',
    redirect_uri_mismatch: 'The redirect URI does not match the OAuth client. Register the exact address shown in Settings under Server configuration.',
    admin_policy_enforced: 'Your Google Workspace administrator blocks this app. They can allow it under Security, API controls.',
    unauthorized_client: 'The OAuth client is not allowed to use this flow. Check the client type (Web application) and its credentials.'
  };
  return g[error] ?? `${provider === 'google' ? 'Google' : 'Microsoft'} returned an error: ${d || error}.`;
}

/** Sync error codes that mean the person has to sign in again. */
const REAUTH_CODES = new Set(['reconnect_required', 'no_credentials', 'gmail_scope_missing']);
/** Sync error codes where signing in again would not help: an API is off, a policy blocks it, or access is refused. */
const DENIED_CODES = new Set(['gmail_api_disabled', 'gmail_forbidden', 'gmail_account_policy', 'microsoft_access_denied', 'microsoft_no_mailbox', 'sharepoint_site_not_found']);

/** @param {any} s the app services */
export function createRegistry(s) {
  /** @returns {{sync: Function, disconnect: Function} | null} */
  function handlerFor(row) {
    switch (row.type) {
      case 'gmail': return s.gmail;
      case 'gdrive': return s.gdrive ?? null;
      case 'outlook': case 'onedrive': case 'sharepoint': case 'teams': return s.microsoft;
      case 'database': return { sync: (src) => s.database.sync(src), disconnect: async () => ({ revoked: null }) };
      case 'messages': return isPhoneLink(row) ? { sync: (src) => s.phonelink.sync(src), disconnect: async () => ({ revoked: null }) } : null;
      default: return null;
    }
  }

  /** Whether sources connected by this person wait for a Supervisor before they are synced or searched. */
  function needsApproval(user) {
    return Boolean(user) && user.role !== 'admin' && switches(s.db, user.tenantId, s.config).sourceApproval;
  }

  /**
   * Lifecycle state of one source row. Expects the extra columns visibleSources() selects
   * (record_count, last_job_code); `running` says whether a sync is in progress right now.
   */
  function lifecycle(row, running) {
    if (row.status === 'disconnected') return 'disconnected';
    if (row.status === 'pending_approval') return 'pending_approval';
    if (running || row.status === 'syncing') return 'syncing';
    if (row.status === 'needs_attention') return REAUTH_CODES.has(row.last_job_code) ? 'reauthorization_required' : DENIED_CODES.has(row.last_job_code) ? 'permission_denied' : 'error';
    const type = SOURCE_TYPES[row.type];
    if (type?.syncs && !row.last_sync_at && !isPhoneLink(row)) return 'connected';
    return Number(row.record_count) > 0 ? 'indexed' : 'connected';
  }

  /**
   * Check what a source can actually do right now, without reading any content: is the stored access accepted,
   * which permissions did the provider grant, and does each API answer. Each check is {label, ok, detail}.
   * @returns {Promise<{checks: {label: string, ok: boolean, detail: string}[], granted: string[]}>}
   */
  async function verify(row) {
    const checks = [];
    const check = async (label, fn) => {
      try { checks.push({ label, ok: true, detail: String(await fn() ?? 'OK') }); }
      catch (err) { checks.push({ label, ok: false, detail: err instanceof Error ? err.message : 'Failed.' }); }
    };
    let granted = parseJson(row.scopes, []);
    if (row.type === 'gmail' || row.type === 'gdrive') {
      let token = null;
      await check('Stored Google access accepted', async () => { token = await s.gmail.accessToken(row); return 'Access token issued from the stored refresh token.'; });
      if (token) {
        await check('Permissions Google granted', async () => {
          const res = await s.gmail.fetch(s.config.google.tokenInfoUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ access_token: token }), signal: AbortSignal.timeout(15000) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(`Google could not describe the token (HTTP ${res.status}).`);
          granted = String(j.scope || '').split(/\s+/).filter(Boolean);
          const need = row.type === 'gmail' ? 'gmail.readonly' : 'drive.readonly';
          if (!granted.some(g => g.endsWith(need))) throw new Error(`${need} is not among the granted permissions. Reconnect and allow it.`);
          return granted.join(' ');
        });
        if (row.type === 'gmail') await check('Gmail API answers', async () => { const p = await s.gmail.api(token, '/users/me/profile'); return `Mailbox ${p.emailAddress}, ${p.messagesTotal ?? '?'} messages in total.`; });
        else await check('Google Drive API answers', async () => { const a = await s.gdrive.api(token, '/about?fields=user(emailAddress)'); return `Drive of ${a.user?.emailAddress ?? 'this account'}.`; });
      }
    } else if (row.type === 'outlook' || row.type === 'onedrive' || row.type === 'sharepoint' || row.type === 'teams') {
      let token = null;
      await check('Stored Microsoft access accepted', async () => { token = await s.microsoft.accessToken(row); return 'Access token issued from the stored refresh token.'; });
      if (token) {
        const cfg = parseJson(row.config, {});
        if (row.type === 'outlook') await check('Outlook mail answers', async () => { const f = await s.microsoft.api(token, '/me/mailFolders/inbox?$select=totalItemCount', { prefer: 'IdType="ImmutableId"' }); return `Inbox reachable, ${f.totalItemCount ?? '?'} messages.`; });
        if (row.type === 'onedrive') await check('OneDrive answers', async () => { const d = await s.microsoft.api(token, '/me/drive?$select=id,driveType'); return `OneDrive (${d.driveType || 'drive'}) reachable.`; });
        if (row.type === 'teams') await check('Teams chats answer', async () => { const c = await s.microsoft.api(token, '/me/chats?$top=1&$select=id'); return `Chats reachable${(c.value || []).length ? '' : ' (none yet)'}.`; });
        if (row.type === 'sharepoint') await check('SharePoint library answers', async () => { await s.microsoft.api(token, `/drives/${encodeURIComponent(cfg.driveId || '')}?$select=id,name`); return `Document library of ${cfg.siteUrl || 'the site'} reachable.`; });
      }
    } else if (row.type === 'database') {
      await check('Read-only connection', async () => { const cols = await s.database.inspect(parseJson(row.config, {}), s.database.secretFor(row.id)); return `Connected; ${new Set(cols.map(c => c.table)).size} tables visible.`; });
    } else if (isPhoneLink(row)) {
      await check('Phone Link data on this PC', async () => { const c = s.phonelink.check(); if (!c.found || !c.recognized) throw new Error(c.reason || 'Phone Link data was not found.'); return `${c.messages ?? '?'} texts available.`; });
    } else {
      checks.push({ label: 'Nothing to check', ok: true, detail: 'This source is filled by uploads or imports, not a connection.' });
    }
    return { checks, granted };
  }

  return { types: SOURCE_TYPES, handlerFor, needsApproval, lifecycle, verify, syncs: (row) => Boolean(handlerFor(row)) };
}
