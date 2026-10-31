import { ApiError, can, get, patch, post, signOut, type AuthStatus } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, field, fmtDate, fmtNum, h, openDialog, replace, ROLE_LABEL, toast } from '../ui.js';

let status: AuthStatus;
const PERM_LABEL: Record<string, string> = { 'search.run': 'Run searches', 'records.read': 'Open records', 'sources.read': 'See connected sources', 'sources.manage': 'Connect and manage sources', 'uploads.create': 'Upload files', 'export.create': 'Export results', 'evaluate.write': 'Record relevance decisions', 'history.read_own': 'See own search history', 'history.read_all': 'See everyone’s search history', 'audit.read': 'Read the audit log', 'users.manage': 'Manage users', 'settings.manage': 'Change settings', 'usage.read': 'See AI usage' };

async function main() {
  status = await initShell({ realOnly: true });
  if (!status.user) return;
  const root = $('#settings-root')!;
  const [settings, sys, usage, consent] = await Promise.all([
    get<any>('/api/settings').catch(() => null),
    can(status, 'sources.read') ? get<any>('/api/system/status').catch(() => null) : null,
    can(status, 'usage.read') ? get<any>('/api/usage').catch(() => null) : null,
    can(status, 'search.run') ? get<any>('/api/consent').catch(() => null) : null
  ]);
  const u = status.user;
  replace(root,
    h('section', { class: 'card' }, cardHead('01', 'Your account'),
      h('dl', { class: 'meta-list' }, h('dt', null, 'Name'), h('dd', null, u.name), h('dt', null, 'Email'), h('dd', null, u.email), h('dt', null, 'Role'), h('dd', null, ROLE_LABEL[u.role] || u.role), h('dt', null, 'Organization'), h('dd', null, settings?.data.tenant || '')),
      h('p', { class: 'helper' }, 'What your role allows:'), h('ul', { class: 'perm-list' }, u.permissions.map(p => h('li', null, PERM_LABEL[p] || p))),
      h('div', { class: 'form-row' }, h('button', { type: 'button', class: 'button secondary', on: { click: () => signOut() } }, 'Sign out'))),
    consent ? consentCard(consent.data) : null,
    settings ? defaultsCard(settings.data) : null,
    sys ? systemCard(sys.data) : null,
    usage ? usageCard(usage.data) : null,
    can(status, 'users.manage') ? h('section', { class: 'card', id: 'users-card' }, cardHead('05', 'Users and roles'), h('div', { id: 'users-body' })) : null,
    settings ? retentionCard(settings.data.retention) : null);
  if (can(status, 'users.manage')) loadUsers();
}

const cardHead = (n: string, title: string, micro = '') => h('div', { class: 'card-heading' }, h('div', null, h('span', { class: 'step' }, n), h('h2', null, title)), micro ? h('span', { class: 'micro' }, micro) : null);

function defaultsCard(s: { defaultMode: string; summariesEnabled: boolean; resultsPerPage: number }) {
  const editable = can(status, 'settings.manage');
  const mode = h('select', { disabled: !editable }, h('option', { value: 'demo', selected: s.defaultMode === 'demo' }, 'Demo mode'), h('option', { value: 'real', selected: s.defaultMode === 'real' }, 'Real data mode')) as HTMLSelectElement;
  const perPage = h('input', { type: 'number', min: 10, max: 100, value: String(s.resultsPerPage), disabled: !editable }) as HTMLInputElement;
  const save = h('button', { type: 'button', class: 'button primary' }, 'Save');
  save.addEventListener('click', async () => {
    try { await busy(save, 'Saving…', () => patch('/api/settings', { defaultMode: mode.value, resultsPerPage: Number(perPage.value) })); toast('Settings saved'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
  });
  return h('section', { class: 'card' }, cardHead('02', 'Organization defaults'),
    h('div', { class: 'plan-grid' }, field('Mode for new staff', mode), field('Results per page', perPage)),
    editable ? h('div', { class: 'form-row' }, save) : h('p', { class: 'helper' }, 'Only administrators can change these.'));
}

function systemCard(s: any) {
  const row = (name: string, ok: boolean, state: string, how: string) => h('tr', null, h('th', { scope: 'row' }, name), h('td', null, h('span', { class: `status-pill ${ok ? 'st-connected' : 'st-needs_attention'}` }, state)), h('td', null, how));
  return h('section', { class: 'card' }, cardHead('03', 'AI, search and connector configuration', 'SET BY ENVIRONMENT VARIABLES'),
    h('p', { class: 'helper' }, 'These are configured on the server, not here, so keys never pass through the browser. See docs/SETUP.md for each setting.'),
    h('table', { class: 'data-table' }, h('tbody', null,
      row('Claude (planning and summaries)', s.ai.configured, s.ai.configured ? `On · ${s.ai.model}` : 'Off', 'ANTHROPIC_API_KEY, ANTHROPIC_MODEL'),
      row('Semantic search (embeddings)', s.embeddings.configured, s.embeddings.configured ? `On · ${s.embeddings.provider} / ${s.embeddings.model}` : s.embeddings.error || 'Off', 'EMBEDDINGS_PROVIDER, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY'),
      row('Gmail connector', s.gmail.configured, s.gmail.configured ? 'Configured' : 'Not configured', `GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET · redirect URI ${s.gmail.redirectUri}`),
      row('Credential encryption', s.encryption.configured, s.encryption.configured ? `On (${s.encryption.source})` : 'Missing', 'CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64)'),
      row('OCR for images', s.ocr.enabled && s.ocr.installed, s.ocr.installed ? (s.ocr.enabled ? 'Available' : 'Switched off') : 'Not installed', 'npm install tesseract.js · OCR_ENABLED, OCR_LANG_PATH'),
      row('PostgreSQL driver', s.drivers.postgres, s.drivers.postgres ? 'Installed' : 'Not installed', 'npm install pg'),
      row('MySQL driver', s.drivers.mysql, s.drivers.mysql ? 'Installed' : 'Not installed', 'npm install mysql2'))));
}

function usageCard(u: any) {
  const t = u.totals;
  return h('section', { class: 'card' }, cardHead('04', 'Claude usage, last 30 days'),
    h('div', { class: 'metrics' },
      h('div', { class: 'metric' }, h('span', null, 'Calls'), h('b', null, fmtNum(t.calls)), h('small', null, `${t.failures || 0} failed`)),
      h('div', { class: 'metric' }, h('span', null, 'Input tokens'), h('b', null, fmtNum(t.inputTokens))),
      h('div', { class: 'metric' }, h('span', null, 'Output tokens'), h('b', null, fmtNum(t.outputTokens))),
      h('div', { class: 'metric' }, h('span', null, 'Estimated cost'), h('b', null, t.costUsd == null ? '–' : `$${Number(t.costUsd).toFixed(2)}`), h('small', null, u.pricingConfigured ? 'From configured prices' : 'Set ANTHROPIC_PRICE_* to estimate'))),
    u.byPurpose.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Purpose', 'Model', 'Calls', 'Input', 'Output'].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, u.byPurpose.map((r: any) => h('tr', null, h('td', null, r.purpose === 'search_plan' ? 'Search plans' : r.purpose === 'summary' ? 'Summaries' : r.purpose), h('td', null, r.model), h('td', null, fmtNum(r.calls)), h('td', null, fmtNum(r.inputTokens)), h('td', null, fmtNum(r.outputTokens)))))) : null);
}

function retentionCard(r: { searchHistoryDays: number; auditDays: number; aiUsageDays: number }) {
  const apply = h('button', { type: 'button', class: 'button secondary' }, 'Apply retention now');
  apply.addEventListener('click', async () => {
    try { const res = await busy(apply, 'Applying…', () => post<any>('/api/settings/retention/apply')); toast(`Removed ${res.data.searches} searches, ${res.data.auditEvents} audit events`); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not apply.', 'error'); }
  });
  return h('section', { class: 'card' }, cardHead('06', 'Retention'),
    h('p', { class: 'helper' }, `Search history is kept ${r.searchHistoryDays} days, audit events ${r.auditDays} days and AI usage ${r.aiUsageDays} days, then deleted automatically each day. Indexed records are kept until their source deletes them or the source is disconnected. Change these with the RETENTION_* environment variables.`),
    can(status, 'settings.manage') ? h('div', { class: 'form-row' }, apply) : null);
}

async function loadUsers() {
  const body = $('#users-body')!;
  try {
    const users = (await get<any[]>('/api/users')).data;
    const addBtn = h('button', { type: 'button', class: 'button primary', on: { click: addUser } }, 'Add a user');
    replace(body, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Name', 'Email', 'Role', 'Last sign-in', 'Status', ''].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, users.map(u => {
        const self = u.id === status.user!.id;
        const role = h('select', { 'aria-label': `Role for ${u.name}`, disabled: self }, ...Object.entries(ROLE_LABEL).map(([v, t]) => h('option', { value: v, selected: u.role === v }, t))) as HTMLSelectElement;
        role.addEventListener('change', async () => { try { await patch(`/api/users/${u.id}`, { role: role.value }); toast(`${u.name} is now ${ROLE_LABEL[role.value]}. Their sessions were ended.`); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change.', 'error'); loadUsers(); } });
        return h('tr', null, h('td', null, u.name), h('td', null, u.email), h('td', null, role), h('td', null, u.lastLoginAt ? fmtDate(u.lastLoginAt, true) : 'Never'),
          h('td', null, h('span', { class: `status-pill ${u.disabled ? 'st-needs_attention' : 'st-connected'}` }, u.disabled ? 'Disabled' : 'Active')),
          h('td', null, self ? h('span', { class: 'helper' }, 'You') : h('span', { class: 'row-actions' },
            h('button', { type: 'button', class: 'button secondary small', on: { click: async () => { try { await patch(`/api/users/${u.id}`, { disabled: !u.disabled }); toast(u.disabled ? 'User enabled' : 'User disabled and signed out'); loadUsers(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Failed.', 'error'); } } } }, u.disabled ? 'Enable' : 'Disable'),
            h('button', { type: 'button', class: 'button secondary small', on: { click: () => resetPassword(u) } }, 'Reset password'))));
      }))), h('div', { class: 'form-row' }, addBtn));
  } catch (e) { replace(body, alertBox(e instanceof ApiError ? e.message : 'Users could not be loaded.')); }
}

function addUser() {
  const name = h('input', { autocomplete: 'off' }) as HTMLInputElement, email = h('input', { type: 'email', autocomplete: 'off' }) as HTMLInputElement, pw = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const role = h('select', null, ...Object.entries(ROLE_LABEL).map(([v, t]) => h('option', { value: v, selected: v === 'reviewer' }, t))) as HTMLSelectElement;
  const save = h('button', { type: 'button', class: 'button primary' }, 'Create user');
  const out = h('div');
  const dlg = openDialog('Add a user', h('div', null, field('Name', name), field('Email', email), field('Role', role, 'Reviewers search shared sources. Records officers also connect sources. Auditors only read logs and history.'), field('Temporary password', pw, 'At least 12 characters. Share it securely.'), out, h('div', { class: 'form-row' }, save)));
  save.addEventListener('click', async () => {
    try { await busy(save, 'Creating…', () => post('/api/users', { name: name.value, email: email.value, role: role.value, password: pw.value })); toast('User created'); dlg.close(); loadUsers(); }
    catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not create.')); }
  });
}

function resetPassword(u: any) {
  const pw = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const save = h('button', { type: 'button', class: 'button primary' }, 'Set password');
  const out = h('div');
  const dlg = openDialog(`New password for ${u.name}`, h('div', null, field('New password', pw, 'At least 12 characters. Their current sessions will end.'), out, h('div', { class: 'form-row' }, save)));
  save.addEventListener('click', async () => {
    try { await busy(save, 'Saving…', () => patch(`/api/users/${u.id}`, { password: pw.value })); toast('Password changed'); dlg.close(); }
    catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not change.')); }
  });
}

main();

function consentCard(d: { consent: { scope: string; sourceIds: string[]; updatedAt: string } | null; sources: { id: string; name: string }[] }) {
  const c = d.consent;
  const names = c?.scope === 'selected' ? d.sources.filter(s => c.sourceIds.includes(s.id)).map(s => s.name) : [];
  return h('section', { class: 'card' }, cardHead('01b', 'Search permission'),
    h('p', null, !c ? 'You have not allowed real-data searches yet. Searches stay blocked until you choose.'
      : c.scope === 'all' ? 'The app may search everything you can access, including sources added later.'
      : names.length ? `The app may search only: ${names.join(', ')}.` : 'The app may search only the sources you chose (none are selected right now).'),
    c ? h('p', { class: 'helper' }, `Last changed ${new Date(c.updatedAt).toLocaleString()}.`) : null,
    h('div', { class: 'form-row' }, h('a', { class: 'button secondary link-button', href: '/consent.html?next=%2Fsettings.html' }, c ? 'Change or withdraw' : 'Choose now')));
}
