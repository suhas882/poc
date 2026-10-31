import { api, ApiError, can, del, get, patch, post, uploadFile, type AuthStatus } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, empty, field, fmtBytes, fmtDate, fmtNum, h, openDialog, replace, ROLE_LABEL, toast } from '../ui.js';

interface Source { id: string; type: string; name: string; status: string; accountLabel: string | null; owner: { id: string; name: string } | null; isOwner: boolean; canManage: boolean; visibility: 'owner' | 'roles'; allowedRoles: string[]; scopes: string[]; driver: string | null; provider?: string | null; repositories: { name: string; kind: string; columns?: string[] }[]; recordCount: number; duplicateCount: number; lastSyncAt: string | null; lastSyncStatus: string | null; lastError: string | null; isSynthetic: boolean; publicDocs?: boolean; experimental?: boolean }
interface Connector { type: string; driver?: string; name: string; description: string; permissions: string[]; status: 'available' | 'needs_configuration' | 'planned' | 'not_connected'; reason?: string; note?: string; local?: boolean; experimental?: boolean; key?: string }
interface SystemStatus { ai: { configured: boolean; model: string | null }; embeddings: { configured: boolean; provider: string | null; model: string | null; error: string | null }; gmail: { configured: boolean; redirectUri: string }; encryption: { configured: boolean; source: string }; ocr: { enabled: boolean; installed: boolean }; limits: { uploadMaxBytes: number } }

const ROLES = ['admin', 'records_officer', 'reviewer', 'auditor'];
const STATUS_LABEL: Record<string, string> = { connected: 'Connected', syncing: 'Synchronizing', needs_attention: 'Needs attention', disconnected: 'Disconnected' };
const ICON: Record<string, string> = { public: 'P', stub: '\u25CC', phonelink: '✆', gmail: '✉', uploads: '⇪', messages: '✆', database: '⛁', synthetic: '◇', google_drive: '△', onedrive: '☁', sharepoint: '▦', outlook: '✉' };
let status: AuthStatus;
let sys: SystemStatus | null = null;
let pollTimer = 0;

async function main() {
  status = await initShell({ title: 'Connected Sources' });
  replace($('#root')!,
    h('div', { class: 'banner info', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '\u2139'), h('span', null, 'Every source is read-only. The tool never writes to, sends from, or deletes in a source system.')),
    h('div', { id: 'flash' }),
    h('div', { class: 'tiles', id: 'system-status' }),
    h('section', { class: 'card', 'aria-labelledby': 'cs-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'cs-h' }, 'Connected sources'), h('span', { class: 'micro', id: 'source-count' })), h('div', { class: 'grid-cards', id: 'source-list' })),
    h('section', { class: 'card', 'aria-labelledby': 'as-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'as-h' }, 'Add or request a source')), h('div', { class: 'grid-cards', id: 'connector-list' })),
    h('section', { class: 'card', id: 'known-gaps', 'aria-labelledby': 'kg-h' }, h('h2', { id: 'kg-h' }, 'Known gaps'), h('p', { class: 'helper' }, 'Loading\u2026')));
  loadGaps();
  const q = new URLSearchParams(location.search);
  if (q.get('connected')) replace($('#flash')!, alertBox('Gmail is connected. The first synchronization has started; it can take a few minutes for a large mailbox.', 'ok'));
  if (q.get('error')) replace($('#flash')!, alertBox(q.get('error')!.slice(0, 300)));
  if (q.has('connected') || q.has('error')) history.replaceState(null, '', '/sources.html');
  sys = (await get<SystemStatus>('/api/system/status').catch(() => null))?.data ?? null;
  renderStatus();
  await Promise.all([loadSources(), loadConnectors()]);
}

function renderStatus() {
  if (!sys) return;
  const item = (label: string, ok: boolean, text: string) => h('div', { class: 'tile' }, h('span', null, label), h('p', null, h('span', { class: `pill ${ok ? 'ok' : 'gray'}` }, ok ? 'On' : 'Off'), ' ', text));
  replace($('#system-status')!,
    item('AI plan drafts', sys.ai.configured, sys.ai.configured ? `${sys.ai.model}. Sees request text and plans only.` : 'Local rules draft plans.'),
    item('Meaning matching', true, 'Related wording from the city pack, matched on this server.'),
    item('Real sources', Boolean(status.realSources), status.realSources ? 'Allowed on this server.' : 'Off. Tier 0 data only.'),
    item('OCR for scans', sys.ocr.enabled && sys.ocr.installed, sys.ocr.enabled && sys.ocr.installed ? 'Available.' : 'Not installed.'));
}

async function loadGaps() {
  const wf = await get<{ pack: { knownGaps: string[]; name: string } }>('/api/settings/workflow').then(r => r.data).catch(() => null);
  if (!wf) return;
  replace($('#known-gaps')!, h('h2', { id: 'kg-h' }, 'Known gaps'), h('ul', { class: 'plain-list' }, wf.pack.knownGaps.map(g => h('li', null, g))),
    h('p', { class: 'hint' }, 'This text is copied into every search record.'));
}

function publicDocDialog() {
  const url = h('input', { type: 'url', id: 'pd-url', placeholder: 'https://' }) as HTMLInputElement;
  const date = h('input', { type: 'date', id: 'pd-date' }) as HTMLInputElement;
  const terms = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const file = h('input', { type: 'file', id: 'pd-file', accept: '.pdf,.docx,.xlsx,.csv,.txt,.md' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'button primary' }, 'Add document');
  const out = h('div');
  const dlg = openDialog('Add a public document', h('div', null,
    h('p', { class: 'helper' }, 'Only openly published documents belong here (Tier 0). Record where each file came from.'),
    field('File', file), field('Public web address it came from', url), field('Date you downloaded it', date),
    h('label', { class: 'inline-check consent-ack' }, terms, 'I checked that the site\u2019s terms of use allow this use.'), out, h('div', { class: 'form-row' }, go)));
  go.addEventListener('click', async () => {
    replace(out);
    const f = file.files?.[0];
    if (!f) { replace(out, alertBox('Choose a file.')); return; }
    try {
      const res = await busy(go, 'Adding\u2026', () => api('POST', '/api/uploads?kind=public', undefined, { raw: f, headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream', 'x-source-url': url.value.trim(), 'x-retrieved-at': date.value, 'x-terms-checked': terms.checked ? 'yes' : 'no' } }));
      void res; toast('Document added with its provenance'); dlg.close(); loadSources();
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not add the document.')); }
  });
}

function requestAccess(c: Connector) {
  openDialog(`${c.name}: not connected`, h('div', null,
    h('p', null, c.description), c.note ? h('p', { class: 'hint' }, c.note) : null,
    h('h3', null, 'To connect it later'),
    h('ol', { class: 'guide-steps' }, h('li', null, 'City IT grants read-only access scoped to named sites or mailboxes.'), h('li', null, 'The connector is built against that access and tested on Tier 1 data first.'), h('li', null, 'Until then, every search lists this source as NOT searched.')),
    h('p', { class: 'hint' }, 'This page does not send a request to anyone. Ask city IT directly.')));
}

async function loadSources() {
  const list = $('#source-list')!;
  let sources: Source[];
  try { sources = (await get<Source[]>('/api/sources')).data; }
  catch (e) { replace(list, alertBox(e instanceof ApiError ? e.message : 'Sources could not be loaded.')); return; }
  $('#source-count')!.textContent = `${sources.length} CONNECTED \u00B7 ${fmtNum(sources.reduce((a, s) => a + s.recordCount, 0))} RECORDS`;
  replace(list, ...(sources.length ? sources.map(sourceCard) : [empty('No sources yet', 'Add one below.')]));
  clearTimeout(pollTimer);
  if (sources.some(s => s.status === 'syncing')) pollTimer = window.setTimeout(loadSources, 2500);
}

function sourceCard(s: Source) {
  const pill = h('span', { class: `status-pill st-${s.status}` }, STATUS_LABEL[s.status] || s.status);
  const sharing = s.visibility === 'owner' ? `Only ${s.isOwner ? 'you' : s.owner?.name || 'the owner'}` : s.allowedRoles.length ? s.allowedRoles.map(r => ROLE_LABEL[r]).join(', ') : 'Every role that can search';
  const cardEl = h('article', { class: `source-card src-${s.type}`, 'aria-labelledby': `s-${s.id}` },
    h('header', { class: 'source-head' },
      h('span', { class: 'source-icon', 'aria-hidden': 'true' }, ICON[s.type] || '•'),
      h('div', null, h('h3', { id: `s-${s.id}` }, s.name), h('p', { class: 'helper' }, s.accountLabel || '')),
      pill),
    h('dl', { class: 'source-facts' },
      h('dt', null, 'Indexed records'), h('dd', null, fmtNum(s.recordCount), s.duplicateCount ? ` (${s.duplicateCount} duplicates)` : ''),
      h('dt', null, 'Last synchronized'), h('dd', null, s.lastSyncAt ? `${fmtDate(s.lastSyncAt, true)}${s.lastSyncStatus === 'failed' ? ' (failed)' : ''}` : 'Never'),
      h('dt', null, 'Who can search it'), h('dd', null, sharing),
      s.owner ? [h('dt', null, 'Connected by'), h('dd', null, s.owner.name)] : null,
      s.scopes.length ? [h('dt', null, 'Access granted'), h('dd', null, h('ul', { class: 'plain-list' }, s.scopes.map(x => h('li', null, h('code', null, x)))))] : null,
      s.repositories.length ? [h('dt', null, s.type === 'database' ? 'Tables' : 'Scope'), h('dd', null, s.repositories.map(r => r.name).join(', '))] : null),
    s.lastError ? alertBox(s.lastError, 'error', s.type === 'gmail' && s.canManage ? h('button', { type: 'button', class: 'button secondary', on: { click: () => startGmail() } }, 'Reconnect Gmail') : undefined) : null,
    s.isSynthetic ? h('p', { class: 'helper' }, 'Invented records for Tier 0 demo searches. They never appear in real-source results.') : s.publicDocs ? h('p', { class: 'helper' }, 'Openly published documents. Each one keeps its web address and retrieval date.') : null,
    s.experimental ? h('p', null, h('span', { class: 'pill warn' }, 'Experimental'), ' ', h('a', { href: '/phone-review.html' }, 'Review your matches')) : null);

  if (s.canManage) {
    const actions = h('div', { class: 'card-actions' });
    const phone = s.provider === 'phonelink', helper = s.provider === 'phonelink-agent';
    if (s.type === 'gmail' || s.type === 'database' || phone) {
      actions.append(h('button', { type: 'button', class: 'button primary', disabled: s.status === 'syncing', on: { click: async (e: Event) => {
        try { await busy(e.currentTarget as HTMLButtonElement, 'Starting…', () => post(`/api/sources/${s.id}/sync`)); toast('Synchronization started'); loadSources(); }
        catch (err) { toast(err instanceof ApiError ? err.message : 'Could not start.', 'error'); }
      } } }, s.status === 'syncing' ? 'Synchronizing…' : 'Sync now'));
      actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showJobs(s) } }, 'Sync history'));
    }
    if (phone || helper) actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showRecords(s) } }, 'View conversations'));
    if (helper) actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => syncHelper() } }, 'Helper keys'));
    if ((s.type === 'uploads' || s.type === 'messages') && !phone && !helper) {
      actions.append(fileButton(s.type === 'uploads' ? 'Upload more files' : 'Import more messages', s.type, s.id));
      actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showRecords(s) } }, 'Manage files'));
    }
    if (s.type === 'database') actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => previewDb(s) } }, 'Preview rows'));
    actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => editSharing(s) } }, 'Sharing'));
    actions.append(h('button', { type: 'button', class: 'button danger', on: { click: () => disconnect(s) } }, s.type === 'gmail' ? 'Disconnect' : 'Remove'));
    cardEl.append(actions);
  }
  return cardEl;
}

async function loadConnectors() {
  let list: Connector[];
  try { list = (await get<Connector[]>('/api/connectors')).data; } catch { return; }
  const manage = can(status, 'sources.manage'), upload = can(status, 'uploads.create');
  replace($('#connector-list')!, ...list.map(c => {
    let action: Node | null = null;
    if (c.status === 'not_connected') action = h('div', { class: 'card-actions' }, h('span', { class: 'pill bad' }, '\u2715 Not connected'), h('button', { type: 'button', class: 'button small secondary', on: { click: () => requestAccess(c) } }, 'Request access'));
    else if (c.type === 'public') action = upload ? h('button', { type: 'button', class: 'button primary', on: { click: publicDocDialog } }, 'Add public document') : h('p', { class: 'helper' }, 'Your role cannot add documents.');
    else if (c.status === 'planned') action = h('span', { class: 'status-pill st-planned' }, 'Planned');
    else if (c.status === 'needs_configuration') action = h('p', { class: 'helper' }, c.reason || 'Needs configuration.');
    else if (c.type === 'phonelink' && manage) action = h('div', { class: 'card-actions' },
      c.local ? h('button', { type: 'button', class: 'button primary', on: { click: () => phoneLink() } }, 'Check this PC') : null,
      h('button', { type: 'button', class: c.local ? 'button secondary' : 'button primary', on: { click: () => syncHelper() } }, 'PC sync helper'));
    else if (c.type === 'gmail' && manage) action = h('button', { type: 'button', class: 'button primary', on: { click: () => startGmail() } }, 'Connect Gmail');
    else if (c.type === 'uploads' && upload) action = fileButton('Choose files', 'uploads');
    else if (c.type === 'messages' && upload) action = h('div', { class: 'card-actions' }, fileButton('Choose export files', 'messages'), h('button', { type: 'button', class: 'button secondary', on: { click: exportGuide } }, 'How to export messages'));
    else if (c.type === 'database' && manage) action = h('button', { type: 'button', class: 'button primary', on: { click: () => dbWizard(c.driver!) } }, `Connect ${c.name}`);
    else action = h('p', { class: 'helper' }, 'Your role can’t add sources.');
    return h('div', { class: `connector-card is-${c.status}` },
      h('div', { class: 'source-head' }, h('span', { class: 'source-icon', 'aria-hidden': 'true' }, ICON[c.type] || '•'), h('h3', null, c.name), c.experimental ? h('span', { class: 'pill warn' }, 'Experimental') : null),
      h('p', null, c.description),
      c.permissions.length ? h('p', { class: 'helper' }, h('b', null, 'Access: '), c.permissions.join('; ')) : null,
      c.note ? h('p', { class: 'helper' }, c.note) : null,
      action);
  }));
}

/* ---------------- Phone Link: Android texts without exports ---------------- */
interface PhoneCheck { found: boolean; recognized?: boolean; reason?: string; file?: { modifiedAt: string }; tables?: string[]; table?: string; messages?: number; conversations?: number | null; oldest?: string | null; newest?: string | null; contactNames?: boolean }

async function phoneLink() {
  const body = h('div', { class: 'consent' }, h('p', { class: 'helper' }, 'Looking for Phone Link on this PC…'));
  const dlg = openDialog('Android texts through Phone Link', body);
  let chk: PhoneCheck;
  try { chk = (await get<PhoneCheck>('/api/connectors/phonelink/check')).data; }
  catch (e) { replace(body, alertBox(e instanceof ApiError ? e.message : 'Could not check this PC.'), setupSteps()); return; }
  if (!chk.found) { replace(body, alertBox(chk.reason || 'Phone Link was not found.'), setupSteps()); return; }
  if (!chk.recognized) {
    replace(body, alertBox(chk.reason || 'The message table was not recognized.'), h('p', { class: 'helper' }, `Tables found: ${(chk.tables || []).join(', ') || 'none'}`));
    return;
  }
  const ack = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'button primary' }, 'Connect and index my texts');
  const out = h('div');
  replace(body,
    alertBox(`Found ${fmtNum(chk.messages || 0)} text${chk.messages === 1 ? '' : 's'}${chk.conversations != null ? ` in ${fmtNum(chk.conversations)} conversation${chk.conversations === 1 ? '' : 's'}` : ''}${chk.oldest ? `, from ${fmtDate(chk.oldest)} to ${fmtDate(chk.newest || chk.oldest)}` : ''}.`, 'ok'),
    h('h3', null, 'What happens'),
    h('ul', null,
      h('li', null, 'The app reads the copy of your texts that Phone Link keeps on this PC. No export, and nothing on your phone is changed.'),
      h('li', null, 'New texts are picked up automatically every few minutes and again right before each search.'),
      h('li', null, `Texts are grouped into one record per conversation per day${chk.contactNames ? ', with contact names' : ''}. Only you can search them unless you share the source.`),
      h('li', null, 'Phone Link keeps only recent texts, so older ones may be missing. Remove the source at any time to delete everything indexed.')),
    h('label', { class: 'inline-check consent-ack' }, ack, 'These are my own texts (or I am authorized to index them) and I want them searchable here.'),
    out, h('div', { class: 'form-row' }, go));
  go.addEventListener('click', async () => {
    replace(out);
    if (!ack.checked) { replace(out, alertBox('Tick the box to confirm.')); return; }
    try {
      await busy(go, 'Connecting…', () => post('/api/connectors/phonelink/connect', { acknowledged: true }));
      dlg.close?.(); toast('Phone Link connected. Indexing your texts…'); location.reload();
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not connect.')); }
  });
}

/* ---------------- PC sync helper: texts from a Windows PC to a hosted server ---------------- */
interface HelperKey { id: string; name: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; sourceName: string | null; records: number }

async function syncHelper() {
  const body = h('div', { class: 'consent' });
  openDialog('PC sync helper for Android texts', body, { wide: true });
  const list = h('div');
  const name = h('input', { value: 'My PC', maxlength: 60 }) as HTMLInputElement;
  name.value = 'My PC';
  const ack = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const create = h('button', { type: 'button', class: 'button primary' }, 'Create helper key');
  const out = h('div');
  replace(body,
    h('p', null, 'This website runs on a server, so it cannot read files on your PC. The helper is a small program on your Windows PC that reads the texts Phone Link keeps there and sends new ones here every few minutes, over HTTPS. No exporting.'),
    h('ul', null,
      h('li', null, 'It only reads Phone Link’s copy of your texts. Nothing on your phone is changed.'),
      h('li', null, 'Its key can only add texts to your own private source. It cannot search or read anything here.'),
      h('li', null, 'Your PC must be on, with Phone Link running, for new texts to arrive. Revoke the key at any time to stop it.')),
    list,
    h('h3', null, 'Create a key'),
    field('Name for this PC', name),
    h('label', { class: 'inline-check consent-ack' }, ack, 'These are my own texts (or I am authorized to index them) and I want them sent to this site.'),
    out, h('div', { class: 'form-row' }, create));
  const loadKeys = async () => {
    try {
      const keys = (await get<HelperKey[]>('/api/agent-tokens')).data;
      replace(list, keys.length ? h('div', null, h('h3', null, 'Your helper keys'), h('table', { class: 'data-table' },
        h('thead', null, h('tr', null, h('th', null, 'PC'), h('th', null, 'Texts indexed'), h('th', null, 'Last contact'), h('th', null, ''))),
        h('tbody', null, keys.map(k => h('tr', null, h('td', null, k.name), h('td', null, fmtNum(k.records)),
          h('td', null, k.revokedAt ? 'Revoked' : k.lastUsedAt ? fmtDate(k.lastUsedAt, true) : 'Never'),
          h('td', null, k.revokedAt ? null : h('button', { type: 'button', class: 'button danger small', on: { click: async () => {
            if (!confirm(`Revoke the key for ${k.name}? The helper on that PC stops sending texts. Texts already here stay until you remove the source.`)) return;
            try { await del(`/api/agent-tokens/${k.id}`); toast('Key revoked'); loadKeys(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not revoke.', 'error'); }
          } } }, 'Revoke'))))))) : null);
    } catch { replace(list); }
  };
  loadKeys();
  create.addEventListener('click', async () => {
    replace(out);
    if (!ack.checked) { replace(out, alertBox('Tick the box to confirm.')); return; }
    try {
      const res = await busy(create, 'Creating…', () => post<{ token: string }>('/api/agent-tokens', { name: name.value.trim() || 'My PC', acknowledged: true }));
      const keyBox = h('input', { readonly: true, value: res.data.token, class: 'mono-input' }) as HTMLInputElement;
      keyBox.value = res.data.token;
      const copy = h('button', { type: 'button', class: 'button secondary', on: { click: async () => { try { await navigator.clipboard.writeText(res.data.token); toast('Key copied'); } catch { keyBox.select(); } } } }, 'Copy key');
      replace(out, alertBox('Key created. Copy it now: it is shown only once.', 'ok'),
        h('div', { class: 'form-row' }, keyBox, copy),
        h('h3', null, 'Set up the helper on your Windows PC'),
        h('ol', { class: 'guide-steps' },
          h('li', null, 'Make sure Phone Link is set up and your texts appear in its Messages tab.'),
          h('li', null, 'On that PC, open the project folder (the one with start.bat) and double-click ', h('b', null, 'phonelink-sync.bat'), '.'),
          h('li', null, 'When asked, paste this website’s address: ', h('code', null, location.origin), '.'),
          h('li', null, 'Paste the key above. The helper sends your texts and then keeps checking for new ones.'),
          h('li', null, 'To start it automatically, press Win+R, type ', h('code', null, 'shell:startup'), ', and put a shortcut to phonelink-sync.bat in that folder.')));
      create.hidden = true;
      loadKeys(); loadSources();
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not create the key.')); }
  });
}

function setupSteps() {
  return h('div', null, h('h3', null, 'Set up Phone Link first'),
    h('ol', { class: 'guide-steps' },
      h('li', null, 'On this Windows PC, open ', h('b', null, 'Phone Link'), ' from the Start menu.'),
      h('li', null, 'Pair your Android phone (install ', h('b', null, 'Link to Windows'), ' on the phone and scan the QR code).'),
      h('li', null, 'On the phone, allow Messages access, and open the Messages tab in Phone Link once so it syncs.'),
      h('li', null, 'Come back here and choose Check this PC again.')),
    h('p', { class: 'helper' }, 'This app must be running on that same PC and opened at http://localhost. iPhone texts are not stored this way, so they still need an export.'));
}

/* ---------------- message export guide ---------------- */

function exportGuide() {
  const step = (title: string, items: (string | Node)[]) => h('section', { class: 'guide-step' }, h('h3', null, title), h('ol', null, items.map(i => h('li', null, i))));
  openDialog('How to export messages as files', h('div', { class: 'guide' },
    h('p', null, 'Phones only let the owner export their messages. Ask the person who holds the phone to make the export, then upload the file here with “Choose export files”.'),
    step('Android text messages (SMS)', [
      'Install “SMS Backup & Restore” by SyncTech from the Google Play Store.',
      'Open it, tap “Set up a backup”, turn on Messages only, and choose where to save (phone storage, Google Drive or email).',
      'Tap “Back up now”. It creates a file named like sms-20250120.xml.',
      'Copy that .xml file to this computer (USB cable, Google Drive or email) and upload it.'
    ]),
    step('WhatsApp (Android or iPhone)', [
      'Open the chat, tap the contact or group name (iPhone) or the ⋮ menu → More (Android).',
      'Tap “Export chat”, then “Without media”.',
      'Send it to yourself by email or save it to Files or Drive.',
      'Android gives a .txt file; upload it as is. iPhone gives a .zip: open it and upload the _chat.txt inside.'
    ]),
    step('iPhone text messages and iMessage', [
      'iPhone has no built-in export. Use a desktop tool that exports messages to CSV (for example iMazing, connected by cable).',
      'Make sure the CSV has columns named date, from, to and body (optionally conversation).',
      'Upload the .csv file.'
    ]),
    step('Any other app', ['Save the messages as a CSV with date, from, to and body columns, and upload it.']),
    h('p', { class: 'helper' }, 'Only import messages your organization is entitled to hold as records, and follow your policy on telling the people involved. Imports are private to you unless you share the source, and every import is written to the audit log.')), { wide: true });
}

/* ---------------- Gmail consent ---------------- */

function startGmail() {
  const query = h('input', { id: 'g-query', value: 'newer_than:2y' }) as HTMLInputElement;
  query.value = 'newer_than:2y';
  const share = roleChecks([]);
  const go = h('button', { type: 'button', class: 'button primary' }, 'Continue to Google');
  const dlg = openDialog('Connect a Gmail account', h('div', { class: 'consent' },
    h('p', null, 'You’ll be sent to Google to sign in and approve access. This app never sees or stores your Google password.'),
    h('h3', null, 'What this app will ask Google for'),
    h('ul', null, h('li', null, h('b', null, 'Read your email messages and settings'), ' (', h('code', null, 'gmail.readonly'), '). It cannot send, delete, or change anything in your mailbox.')),
    h('h3', null, 'What happens next'),
    h('ul', null,
      h('li', null, 'Messages matching the filter below, and their attachments in supported formats, are copied into this app’s search index.'),
      h('li', null, 'The access token is stored encrypted. Every sync and record view is written to the audit log.'),
      h('li', null, 'Disconnecting revokes the access at Google and deletes every copied message and attachment.')),
    field('Which messages to include (Gmail search syntax)', query, 'For example: newer_than:1y, label:records, from:contractor.com. Leave empty for all mail except spam and trash.'),
    h('fieldset', { class: 'source-pick' }, h('legend', null, 'Who else can search this mailbox?'), h('p', { class: 'hint' }, 'Leave all unticked to keep it private to you.'), share.el),
    h('div', { class: 'form-row' }, go)));
  go.addEventListener('click', async () => {
    try {
      const res = await busy(go, 'Opening Google…', () => post<{ url: string }>('/api/connectors/gmail/authorize', { query: query.value.trim(), shareWithRoles: share.value() }));
      location.href = res.data.url;
    } catch (e) { dlg.querySelector('.modal-body')!.append(alertBox(e instanceof ApiError ? e.message : 'Could not start the connection.')); }
  });
}

function roleChecks(selected: string[]) {
  const boxes = ROLES.map(r => h('input', { type: 'checkbox', value: r, checked: selected.includes(r) }) as HTMLInputElement);
  return { el: h('div', { class: 'role-checks' }, ...boxes.map((b, i) => h('label', { class: 'inline-check' }, b, ROLE_LABEL[ROLES[i]]))), value: () => boxes.filter(b => b.checked).map(b => b.value) };
}

/* ---------------- uploads ---------------- */

function fileButton(label: string, kind: 'uploads' | 'messages', sourceId?: string) {
  const inputEl = h('input', { type: 'file', multiple: true, class: 'visually-hidden', accept: kind === 'uploads' ? '.pdf,.docx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.tif,.tiff,.webp' : '.xml,.txt,.csv' }) as HTMLInputElement;
  const btn = h('button', { type: 'button', class: 'button secondary', on: { click: () => inputEl.click() } }, label);
  inputEl.addEventListener('change', () => { if (inputEl.files?.length) uploadAll([...inputEl.files], kind, sourceId); inputEl.value = ''; });
  return h('span', null, btn, inputEl);
}

async function uploadAll(files: File[], kind: 'uploads' | 'messages', sourceId?: string) {
  const max = sys?.limits.uploadMaxBytes ?? 25 * 1048576;
  const rows = files.map(f => ({ f, li: h('li', null, `${f.name} (${fmtBytes(f.size)}) `, h('span', { class: 'helper' }, 'Waiting…')) }));
  const dlg = openDialog(kind === 'uploads' ? 'Uploading files' : 'Importing messages', h('ul', { class: 'upload-list' }, rows.map(r => r.li)), { onClose: () => loadSources() });
  for (const { f, li } of rows) {
    const out = li.querySelector('span')!;
    if (f.size > max) { out.textContent = `Too large (limit ${fmtBytes(max)}).`; li.dataset.state = 'error'; continue; }
    out.textContent = 'Uploading…';
    try {
      const q = new URLSearchParams({ ...(kind === 'messages' ? { kind: 'messages' } : {}), ...(sourceId ? { sourceId } : {}) });
      const res = await uploadFile<any>(f, q.toString() ? `?${q}` : '');
      const d = res.data;
      out.textContent = kind === 'messages'
        ? `Imported ${d.messages} messages into ${d.conversationDays} conversation days.`
        : d.result === 'unchanged' ? 'Already uploaded.' : d.extraction === 'ok' ? `Indexed (${fmtNum(d.characters)} characters).` : (d.notes?.[0] || 'Stored, but no text could be read.');
      li.dataset.state = d.extraction === 'ok' || kind === 'messages' || d.result === 'unchanged' ? 'ok' : 'warn';
    } catch (e) { out.textContent = e instanceof ApiError ? e.message : 'Failed.'; li.dataset.state = 'error'; }
  }
  dlg.querySelector('.modal-body')!.append(h('div', { class: 'form-row' }, h('button', { type: 'button', class: 'button primary', on: { click: () => dlg.close() } }, 'Done')));
}

async function showRecords(s: Source, page = 1) {
  const res = await get<any[]>(`/api/sources/${s.id}/records?page=${page}&pageSize=25`).catch(() => null);
  if (!res) return;
  const body = h('div', null,
    res.data.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Title'), h('th', null, 'Type'), h('th', null, 'Added'), h('th', null, h('span', { class: 'visually-hidden' }, 'Actions')))),
      h('tbody', null, res.data.map(r => h('tr', null, h('td', null, r.title), h('td', null, r.documentType || ''), h('td', null, fmtDate(r.ingestedAt)),
        h('td', null, h('button', { type: 'button', class: 'button danger small', on: { click: async () => {
          if (!confirm(`Delete “${r.title}” from the index? The stored original is deleted too.`)) return;
          try { await del(`/api/records/${r.id}`); toast('Deleted'); dlg.close(); showRecords(s, page); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
        } } }, 'Delete')))))) : empty('Nothing here yet', 'Upload files to add them.'),
    res.meta && res.meta.total > 25 ? h('p', { class: 'helper' }, `Showing ${res.data.length} of ${res.meta.total}.`) : null);
  const dlg = openDialog(s.name, body, { wide: true, onClose: () => loadSources() });
}

async function showJobs(s: Source) {
  const res = await get<any[]>(`/api/sources/${s.id}/jobs`).catch(() => null);
  openDialog(`Sync history: ${s.name}`, res?.data.length
    ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Started', 'Trigger', 'Result', 'Added', 'Updated', 'Removed', 'Details'].map(x => h('th', null, x)))),
      h('tbody', null, res.data.map(j => h('tr', null, h('td', null, fmtDate(j.startedAt, true)), h('td', null, j.trigger), h('td', null, h('span', { class: `status-pill st-${j.status === 'succeeded' ? 'connected' : j.status === 'running' ? 'syncing' : 'needs_attention'}` }, j.status)), h('td', null, j.added), h('td', null, j.updated), h('td', null, j.deleted), h('td', null, j.error || '')))))
    : empty('No synchronizations yet', 'Use Sync now to start one.'), { wide: true });
}

function editSharing(s: Source) {
  const vis = h('select', { id: 'vis' }, h('option', { value: 'owner', selected: s.visibility === 'owner' }, 'Only the person who connected it'), h('option', { value: 'roles', selected: s.visibility === 'roles' }, 'People with the roles below')) as HTMLSelectElement;
  const roles = roleChecks(s.allowedRoles);
  const save = h('button', { type: 'button', class: 'button primary' }, 'Save sharing');
  const dlg = openDialog(`Sharing: ${s.name}`, h('div', null,
    h('p', null, 'Sharing decides who can find this source’s records in searches. Changes apply immediately, including to existing result lists.'),
    field('Who can search it', vis),
    h('fieldset', { class: 'source-pick' }, h('legend', null, 'Roles (if shared by role)'), h('p', { class: 'hint' }, 'Leave all unticked to share with every role that can search.'), roles.el),
    h('div', { class: 'form-row' }, save)));
  save.addEventListener('click', async () => {
    try { await busy(save, 'Saving…', () => patch(`/api/sources/${s.id}`, { visibility: vis.value, allowedRoles: roles.value() })); toast('Sharing updated'); dlg.close(); loadSources(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
  });
}

function disconnect(s: Source) {
  const yes = h('button', { type: 'button', class: 'button danger' }, s.type === 'gmail' ? 'Disconnect and delete' : 'Remove and delete');
  const dlg = openDialog(s.type === 'gmail' ? 'Disconnect Gmail?' : `Remove ${s.name}?`, h('div', null,
    h('p', null, `This deletes all ${fmtNum(s.recordCount)} indexed records from this source, along with any stored credentials${s.type === 'uploads' ? ' and uploaded originals' : ''}.`),
    s.type === 'gmail' ? h('p', null, 'Access is also revoked at Google. Nothing in the mailbox itself is changed.') : null,
    h('p', null, 'Past search results will no longer show these records. The audit log keeps a record of the disconnection.'),
    h('div', { class: 'form-row' }, yes, h('button', { type: 'button', class: 'button secondary', on: { click: () => dlg.close() } }, 'Cancel'))));
  yes.addEventListener('click', async () => {
    try {
      const r = await busy(yes, 'Deleting…', () => del<{ recordsDeleted: number; revokedAtProvider: boolean | null }>(`/api/sources/${s.id}`));
      toast(`Removed ${r.data.recordsDeleted} records${r.data.revokedAtProvider === false ? '. Google did not confirm the revocation; remove the app at myaccount.google.com/permissions.' : ''}`);
      dlg.close(); loadSources();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove.', 'error'); }
  });
}

/* ---------------- database wizard ---------------- */

function dbWizard(driver: string) {
  const inp = (id: string, attrs: Record<string, unknown> = {}) => h('input', { id, ...attrs }) as HTMLInputElement;
  const name = inp('db-name', { value: driver === 'sqlite' ? 'Records database' : '' });
  const host = inp('db-host'), port = inp('db-port', { type: 'number', min: 1, max: 65535 }), database = inp('db-database'), user = inp('db-user'), password = inp('db-password', { type: 'password', autocomplete: 'new-password' });
  const file = inp('db-file', { placeholder: 'records.sqlite' });
  const ssl = inp('db-ssl', { type: 'checkbox' });
  const tenantCol = inp('db-tenant-col'), tenantVal = inp('db-tenant-val');
  const mapping = h('div', { id: 'db-mapping' });
  const share = roleChecks([]);
  const test = h('button', { type: 'button', class: 'button secondary' }, 'Test connection and list tables');
  const save = h('button', { type: 'button', class: 'button primary', disabled: true }, 'Save and index');
  const out = h('div');
  let columns: { table: string; column: string; type: string }[] = [];
  const conn = () => ({ driver, ...(driver === 'sqlite' ? { file: file.value.trim() } : { host: host.value.trim(), port: port.value ? Number(port.value) : undefined, database: database.value.trim(), user: user.value.trim(), password: password.value || undefined, ssl: ssl.checked }) });

  const tableRows: { table: HTMLSelectElement; id: HTMLSelectElement; title: HTMLSelectElement; content: HTMLSelectElement; date: HTMLSelectElement; dept: HTMLSelectElement; url: HTMLInputElement }[] = [];
  const colSelect = (table: string, optional: boolean, multiple = false) => {
    const s = h('select', { multiple }, optional && !multiple ? h('option', { value: '' }, '(none)') : null, ...columns.filter(c => c.table === table).map(c => h('option', { value: c.column }, `${c.column} (${c.type})`))) as HTMLSelectElement;
    return s;
  };
  const addTable = () => {
    const tables = [...new Set(columns.map(c => c.table))];
    const t = h('select', null, ...tables.map(x => h('option', { value: x }, x))) as HTMLSelectElement;
    const row = h('fieldset', { class: 'table-map' }, h('legend', null, 'Table to index'));
    const build = () => {
      const r = { table: t, id: colSelect(t.value, false), title: colSelect(t.value, false), content: colSelect(t.value, false, true), date: colSelect(t.value, true), dept: colSelect(t.value, true), url: inp(`u-${Math.random()}`, { placeholder: 'https://system.example.gov/item/{id}' }) };
      replace(row, h('legend', null, 'Table to index'), field('Table', t), field('Unique ID column', r.id), field('Title column', r.title),
        field('Text columns to index', r.content, 'Hold Ctrl (or Cmd) to choose several. Only these columns are copied.'), field('Date column', r.date), field('Department column', r.dept), field('Link to the record (optional)', r.url, 'Use {id} where the record ID goes. Must start with https://'));
      const i = tableRows.findIndex(x => x.table === t);
      if (i >= 0) tableRows[i] = r; else tableRows.push(r);
    };
    t.addEventListener('change', build);
    build();
    mapping.append(row);
  };

  test.addEventListener('click', async () => {
    replace(out);
    try {
      columns = (await busy(test, 'Connecting…', () => post<typeof columns>('/api/connectors/database/inspect', conn()))).data;
      if (!columns.length) { replace(out, alertBox('Connected, but no tables are visible to this user.', 'warn')); return; }
      replace(mapping); tableRows.length = 0; addTable();
      mapping.append(h('button', { type: 'button', class: 'text-link', on: { click: addTable } }, '+ Add another table'));
      save.disabled = false;
      replace(out, alertBox(`Connected read-only. ${new Set(columns.map(c => c.table)).size} tables found.`, 'ok'));
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not connect.')); }
  });
  save.addEventListener('click', async () => {
    const tables = tableRows.map(r => ({ name: r.table.value, idColumn: r.id.value, titleColumn: r.title.value, contentColumns: [...r.content.selectedOptions].map(o => o.value), dateColumn: r.date.value || undefined, departmentColumn: r.dept.value || undefined, urlTemplate: r.url.value.trim() || undefined }));
    try {
      await busy(save, 'Saving…', () => post('/api/sources/database', { name: name.value.trim(), ...conn(), tenantColumn: tenantCol.value.trim() || undefined, tenantValue: tenantVal.value.trim() || undefined, tables, shareWithRoles: share.value() }));
      toast('Database connected. Indexing has started.'); dlg.close(); loadSources();
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.')); }
  });

  const dlg = openDialog(`Connect ${driver === 'postgres' ? 'PostgreSQL' : driver === 'mysql' ? 'MySQL' : 'a SQLite file'}`, h('div', { class: 'db-wizard' },
    h('p', null, 'The app only runs read-only SELECT statements it builds itself, on the tables and columns you choose here. Use a database account that has read access only.'),
    field('Name shown in the app', name),
    driver === 'sqlite' ? field('File name', file, 'The file must be in the server’s connector folder (data/connectors by default).')
      : h('div', { class: 'plan-grid' }, field('Host', host), field('Port', port), field('Database', database), field('User', user), field('Password', password, 'Stored encrypted.'), h('label', { class: 'inline-check' }, ssl, 'Require TLS')),
    h('details', null, h('summary', null, 'Shared database? Limit rows to one organization'), h('div', { class: 'plan-grid' }, field('Organization column', tenantCol), field('Value for this organization', tenantVal))),
    h('div', { class: 'form-row' }, test), out, mapping,
    h('fieldset', { class: 'source-pick' }, h('legend', null, 'Who can search it'), h('p', { class: 'hint' }, 'Leave all unticked to keep it private to you.'), share.el),
    h('div', { class: 'form-row' }, save)), { wide: true });
}

async function previewDb(s: Source) {
  const table = h('select', null, ...s.repositories.map(r => h('option', { value: r.name }, r.name))) as HTMLSelectElement;
  const kw = h('input', { placeholder: 'Keyword' }) as HTMLInputElement;
  const since = h('input', { type: 'date' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'button secondary' }, 'Preview');
  const out = h('div');
  go.addEventListener('click', async () => {
    try {
      const rows = (await busy(go, 'Querying…', () => post<any[]>(`/api/sources/${s.id}/preview`, { table: table.value, keyword: kw.value.trim() || undefined, since: since.value || undefined }))).data;
      replace(out, rows.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['ID', 'Title', 'Date', 'Excerpt'].map(x => h('th', null, x)))), h('tbody', null, rows.map(r => h('tr', null, h('td', null, r.id), h('td', null, r.title), h('td', null, fmtDate(r.date)), h('td', null, r.excerpt))))) : empty('No rows', 'Nothing matches those filters.'));
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Preview failed.')); }
  });
  openDialog(`Preview: ${s.name}`, h('div', null, h('p', { class: 'helper' }, 'Runs a read-only query (at most 20 rows) on the allowlisted columns.'), h('div', { class: 'filter-bar' }, field('Table', table), field('Keyword', kw), field('Since', since), go), out), { wide: true });
}

main();
