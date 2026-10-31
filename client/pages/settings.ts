// Screen 9: Settings. Search permission, holidays, admin switches, roles. Screen 14: city packs.
import { ApiError, can, get, patch, post, put, signOut, type AuthStatus } from '../api.js';
import { currentMode, initShell } from '../shell.js';
import { $, alertBox, busy, field, fmtDate, fmtNum, h, openDialog, pill, replace, ROLE_LABEL, toast } from '../ui.js';

interface Workflow { pack: { id: string; name: string; label: string; departments: string[]; recordTypes: string[]; holidays: string[]; holidayNote: string; holidaysAdded: string[]; holidaysRemoved: string[];
  wording: Record<string, string>; reviewRules: { arguablyBelow: number }; threshold: number; thresholdNote: string; sources: { name: string }[]; sourceMap: { department: string; custodian: string }[]; knownGaps: string[]; responseDays: number; timezone: string };
  packs: { id: string; name: string; label: string }[]; switches: { realSources: boolean; phoneLink: boolean; secondApproval: boolean }; example: { receivedToday: string; dueIfReceivedToday: string }; reuseNote: string }

let status: AuthStatus;
const root = $('#root')!;
const cardHead = (_n: string, title: string, micro = '') => h('div', { class: 'card-heading' }, h('h2', null, title), micro ? h('span', { class: 'micro' }, micro) : null);

async function main() {
  status = await initShell({ title: 'Settings' });
  await draw();
}

async function draw() {
  const u = status.user!;
  const admin = can(status, 'settings.manage');
  const [wf, sys, usage, consent, settings] = await Promise.all([
    get<Workflow>('/api/settings/workflow').then(r => r.data).catch(() => null),
    can(status, 'sources.read') ? get<any>('/api/system/status').then(r => r.data).catch(() => null) : null,
    can(status, 'usage.read') ? get<any>('/api/usage').then(r => r.data).catch(() => null) : null,
    status.realSources && !u.isDemo && can(status, 'search.run') ? get<any>('/api/consent').then(r => r.data).catch(() => null) : null,
    get<any>('/api/settings').then(r => r.data).catch(() => null)
  ]);
  replace(root,
    h('div', { class: 'cols-2' },
      h('div', { class: 'stack' },
        accountCard(),
        permissionCard(consent),
        wf ? switchesCard(wf, admin) : null,
        rolesCard(),
        h('section', { class: 'card' }, cardHead('', 'Bellevue AI review package'), h('p', { class: 'helper' }, 'Data flow, what the model sees, human review steps, logging, and open items for the AI Questionnaire.'),
          h('div', { class: 'form-row' }, h('a', { class: 'button secondary link-button', href: '/ai-review.html' }, 'Open the package')))),
      h('div', { class: 'stack' },
        wf ? holidaysCard(wf, admin) : null,
        wf ? packsCard(wf, admin) : null)),
    sys ? systemCard(sys) : null,
    usage ? usageCard(usage) : null,
    can(status, 'users.manage') ? h('section', { class: 'card', id: 'users-card' }, cardHead('', 'Users and roles'), h('div', { id: 'users-body' })) : null,
    settings && admin ? retentionCard(settings.retention) : null);
  if (can(status, 'users.manage')) loadUsers();
}

function accountCard() {
  const u = status.user!;
  const PERM: Record<string, string> = { 'search.run': 'Log requests and run searches', 'records.read': 'Open records', 'sources.read': 'See sources', 'sources.manage': 'Connect sources', 'uploads.create': 'Add documents', 'export.create': 'Export', 'evaluate.write': 'Mark candidates', 'history.read_own': 'See own history', 'history.read_all': 'See all history', 'audit.read': 'Read the audit log', 'users.manage': 'Manage users', 'settings.manage': 'Change settings', 'usage.read': 'See AI usage' };
  return h('section', { class: 'card' }, cardHead('', 'Your account'),
    h('dl', { class: 'meta-list' }, h('dt', null, 'Name'), h('dd', null, u.name), h('dt', null, 'Role'), h('dd', null, ROLE_LABEL[u.role] || u.role), h('dt', null, 'Organization'), h('dd', null, u.organization || ''),
      h('dt', null, 'Data'), h('dd', null, u.isDemo ? 'Demo account: Tier 0 data only' : currentMode() === 'real' ? 'Real sources' : 'Demo corpus')),
    h('p', { class: 'label' }, 'What your role can do'), h('ul', { class: 'perm-list' }, u.permissions.map(p => h('li', null, PERM[p] || p))),
    h('div', { class: 'form-row' }, h('button', { type: 'button', class: 'button secondary', on: { click: () => signOut() } }, 'Sign out')));
}

function permissionCard(d: any) {
  if (!status.realSources || status.user!.isDemo) {
    return h('section', { class: 'card' }, cardHead('', 'Search permission'),
      h('p', null, 'Real sources are off on this server, so there is nothing to allow. Demo searches use invented records and public documents only.'),
      h('p', { class: 'hint' }, 'When real sources are on, staff choose after sign-in: “Only the sources I choose” (the default) or “Everything I can access”. Every change is logged with the old and new value.'));
  }
  if (!d) return null;
  return consentCard(d);
}

function switchesCard(wf: Workflow, admin: boolean) {
  const sw = wf.switches;
  const row = (label: string, on: boolean, hint: string, key: string | null, disabledReason?: string) => {
    const box = h('input', { type: 'checkbox', class: 'switch', checked: on, disabled: !admin || !key || Boolean(disabledReason), 'aria-label': label, 'aria-describedby': `sw-${label.replace(/\W+/g, '')}` }) as HTMLInputElement;
    if (key) box.addEventListener('change', async () => {
      try { await put('/api/settings/switches', { [key]: box.checked }); toast('Saved. The change is in the audit log.'); location.reload(); }
      catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change.', 'error'); box.checked = !box.checked; }
    });
    return h('div', { class: 'toggle-card' }, box, h('span', null, h('b', null, label, ' ', on ? pill('ok', 'On') : pill('gray', 'Off')), h('small', { id: `sw-${label.replace(/\W+/g, '')}` }, disabledReason || hint)));
  };
  return h('section', { class: 'card' }, cardHead('', 'Admin switches', 'OFF BY DEFAULT'),
    h('div', { class: 'stack' },
      row('Real sources', sw.realSources, '', null, sw.realSources ? 'Set on the server (REAL_SOURCES=true). It cannot be changed here.' : 'Off on this server. Only the server setting REAL_SOURCES can change it; this page cannot.'),
      row('Phone Link texts (experimental)', sw.phoneLink, 'Employee self-review of their own Android texts before anything reaches a clerk.', 'phoneLink', sw.realSources ? undefined : 'Needs real sources, which are off here.'),
      row('Second-person approval', sw.secondApproval, 'A Supervisor other than the clerk approves the search record before handoff.', 'secondApproval')),
    admin ? null : h('p', { class: 'hint' }, 'Only a Supervisor can change these.'));
}

function rolesCard() {
  const rows: [string, string][] = [['records_officer', 'Logs requests, edits and confirms plans, searches, marks, exports and hands off.'], ['reviewer', 'Searches and marks candidates routed to their department. Cannot change settings.'],
    ['admin', 'Everything a clerk can do, plus users, settings, city packs, settling label differences and second-person approval.'], ['auditor', 'Reads search history and the audit log. Cannot search or change anything.']];
  return h('section', { class: 'card' }, cardHead('', 'Roles'), h('dl', { class: 'meta-list' }, rows.flatMap(([id, text]) => [h('dt', null, ROLE_LABEL[id]), h('dd', null, text)])),
    h('p', { class: 'hint' }, 'Each role changes what can be clicked. The server checks every action too.'));
}

function holidaysCard(wf: Workflow, admin: boolean) {
  const add = h('input', { type: 'date', id: 'hol-add' }) as HTMLInputElement;
  const addBtn = h('button', { type: 'button', class: 'button secondary small' }, 'Add holiday');
  const change = async (body: object) => { try { await put('/api/settings/holidays', body); toast('Holidays updated. Due dates for open requests moved with them.'); draw(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); } };
  addBtn.addEventListener('click', () => { if (add.value) change({ add: add.value }); });
  const upcoming = wf.pack.holidays.filter(d => d >= wf.example.receivedToday).slice(0, 14);
  return h('section', { class: 'card' }, cardHead('', 'Holidays and the response clock'),
    h('p', null, `${wf.pack.wording.clock} Weekends and these holidays are skipped. A request received today (${fmtDate(wf.example.receivedToday)}) is due ${fmtDate(wf.example.dueIfReceivedToday)}.`),
    h('p', { class: 'hint' }, wf.pack.holidayNote),
    h('ul', { class: 'plain-list' }, upcoming.map(d => h('li', null, `${fmtDate(d)} `, wf.pack.holidaysAdded.includes(d) ? pill('info', 'Added here') : null,
      admin ? h('button', { type: 'button', class: 'text-link', 'aria-label': `Remove holiday ${d}`, on: { click: () => change({ remove: d }) } }, 'Remove') : null))),
    admin ? h('div', { class: 'form-row' }, h('label', { class: 'visually-hidden', for: 'hol-add' }, 'Holiday date'), add, addBtn) : null);
}

function packsCard(wf: Workflow, admin: boolean) {
  const sel = h('select', { id: 'pack-sel', disabled: !admin }, wf.packs.map(p => h('option', { value: p.id, selected: p.id === wf.pack.id }, p.label))) as HTMLSelectElement;
  const threshold = h('input', { type: 'number', id: 'pack-th', min: 1, value: String(wf.pack.threshold), disabled: !admin }) as HTMLInputElement;
  threshold.value = String(wf.pack.threshold);
  const save = h('button', { type: 'button', class: 'button primary' }, 'Save pack settings');
  save.addEventListener('click', async () => {
    try { await busy(save, 'Saving…', () => put('/api/settings/pack', { pack: sel.value, threshold: Number(threshold.value) })); toast('Saved and logged.'); location.reload(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
  });
  const p = wf.pack;
  return h('section', { class: 'card' }, cardHead('', 'City pack'),
    h('p', { class: 'helper' }, 'Everything city-specific lives in a pack, so nothing is hard-coded to one city. Switching packs is an admin action and is logged.'),
    h('div', { class: 'field-grid' }, field('Active pack', sel), field('Broad plan warning level', threshold, p.thresholdNote)),
    admin ? h('div', { class: 'form-row' }, save) : h('p', { class: 'hint' }, 'Only a Supervisor can switch packs.'),
    h('details', null, h('summary', null, `What the ${p.name} pack contains`),
      h('dl', { class: 'meta-list' },
        h('dt', null, 'Departments'), h('dd', null, p.departments.join(', ')),
        h('dt', null, 'Record types'), h('dd', null, p.recordTypes.join(', ')),
        h('dt', null, 'Unconnected sources'), h('dd', null, p.sources.map(x => x.name).join(', ')),
        h('dt', null, 'Holidays'), h('dd', null, `${p.holidays.length} dates. ${p.holidayNote}`),
        h('dt', null, 'Response wording'), h('dd', null, `${p.wording.clock} ${p.wording.handoff}`),
        h('dt', null, 'Review rules'), h('dd', null, `Match scores below ${p.reviewRules.arguablyBelow} are labeled “arguably responsive”.`),
        h('dt', null, 'Source map'), h('dd', null, `${p.sourceMap.length} departments with custodians`),
        h('dt', null, 'Time zone'), h('dd', null, p.timezone))),
    h('p', { class: 'hint' }, wf.reuseNote));
}

function systemCard(s: any) {
  const row = (name: string, ok: boolean, state: string, how: string) => h('tr', null, h('th', { scope: 'row' }, name), h('td', null, h('span', { class: `status-pill ${ok ? 'st-connected' : 'st-needs_attention'}` }, state)), h('td', null, how));
  return h('section', { class: 'card' }, cardHead('', 'Server configuration', 'SET ON THE SERVER'),
    h('p', { class: 'helper' }, 'These are configured on the server, not here, so keys never pass through the browser. See docs/SETUP.md for each setting.'),
    h('table', { class: 'data-table' }, h('tbody', null,
      row('AI model for plans and clarification drafts', s.ai.configured, s.ai.configured ? `On \u00B7 ${s.ai.model}` : 'Off: local rules draft plans', 'ANTHROPIC_API_KEY, ANTHROPIC_MODEL. Receives request text and plans only.'),
      row('Outside embedding service', s.embeddings.configured, s.embeddings.configured ? `On \u00B7 ${s.embeddings.provider}` : 'Off: record text stays on this server', 'Needs EMBEDDINGS_RECORD_CONTENT_APPROVED=true after an approved model and hosting are named.'),
      row('Gmail connector', s.gmail.configured, s.gmail.configured ? 'Configured' : 'Not configured', `GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET · redirect URI ${s.gmail.redirectUri}`),
      row('Credential encryption', s.encryption.configured, s.encryption.configured ? `On (${s.encryption.source})` : 'Missing', 'CREDENTIAL_ENCRYPTION_KEY (32 bytes, base64)'),
      row('OCR for images', s.ocr.enabled && s.ocr.installed, s.ocr.installed ? (s.ocr.enabled ? 'Available' : 'Switched off') : 'Not installed', 'npm install tesseract.js · OCR_ENABLED, OCR_LANG_PATH'),
      row('PostgreSQL driver', s.drivers.postgres, s.drivers.postgres ? 'Installed' : 'Not installed', 'npm install pg'),
      row('MySQL driver', s.drivers.mysql, s.drivers.mysql ? 'Installed' : 'Not installed', 'npm install mysql2'))));
}

function usageCard(u: any) {
  const t = u.totals;
  return h('section', { class: 'card' }, cardHead('', 'AI model usage, last 30 days'),
    h('div', { class: 'metrics' },
      h('div', { class: 'metric' }, h('span', null, 'Calls'), h('b', null, fmtNum(t.calls)), h('small', null, `${t.failures || 0} failed`)),
      h('div', { class: 'metric' }, h('span', null, 'Input tokens'), h('b', null, fmtNum(t.inputTokens))),
      h('div', { class: 'metric' }, h('span', null, 'Output tokens'), h('b', null, fmtNum(t.outputTokens))),
      h('div', { class: 'metric' }, h('span', null, 'Estimated cost'), h('b', null, t.costUsd == null ? '–' : `$${Number(t.costUsd).toFixed(2)}`), h('small', null, u.pricingConfigured ? 'From configured prices' : 'Set ANTHROPIC_PRICE_* to estimate'))),
    u.byPurpose.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Purpose', 'Model', 'Calls', 'Input', 'Output'].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, u.byPurpose.map((r: any) => h('tr', null, h('td', null, r.purpose === 'search_plan' ? 'Search plans' : r.purpose === 'clarification' ? 'Clarification drafts' : r.purpose), h('td', null, r.model), h('td', null, fmtNum(r.calls)), h('td', null, fmtNum(r.inputTokens)), h('td', null, fmtNum(r.outputTokens)))))) : null);
}

function retentionCard(r: { searchHistoryDays: number; auditDays: number; aiUsageDays: number }) {
  const apply = h('button', { type: 'button', class: 'button secondary' }, 'Apply retention now');
  apply.addEventListener('click', async () => {
    try { const res = await busy(apply, 'Applying…', () => post<any>('/api/settings/retention/apply')); toast(`Removed ${res.data.searches} searches, ${res.data.auditEvents} audit events`); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not apply.', 'error'); }
  });
  return h('section', { class: 'card' }, cardHead('', 'Retention'),
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
  const dlg = openDialog('Add a user', h('div', null, field('Name', name), field('Email', email), field('Role', role, 'Clerks run requests and connect sources. Records Coordinators search and mark. Supervisors also manage users and settings. Auditors only read logs and history.'), field('Temporary password', pw, 'At least 12 characters. Share it securely.'), out, h('div', { class: 'form-row' }, save)));
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
  return h('section', { class: 'card' }, cardHead('', 'Search permission'),
    h('p', null, !c ? 'You have not allowed real-data searches yet. Searches on real records stay blocked until you choose.'
      : c.scope === 'all' ? 'The app may search everything you can access, including sources added later.'
      : names.length ? `The app may search only: ${names.join(', ')}.` : 'The app may search only the sources you chose (none are selected right now).'),
    c ? h('p', { class: 'helper' }, `Last changed ${new Date(c.updatedAt).toLocaleString()}.`) : null,
    h('div', { class: 'form-row' }, h('a', { class: 'button secondary link-button', href: '/consent.html?next=%2Fsettings.html' }, c ? 'Change or withdraw' : 'Choose now')));
}
