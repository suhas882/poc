import { api, ApiError, can, del, get, patch, post, uploadFile } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, empty, field, fmtBytes, fmtDate, fmtNum, h, openDialog, replace, ROLE_LABEL, SOURCE_LABEL, toast } from '../ui.js';
const ROLES = ['admin', 'records_officer', 'reviewer', 'auditor'];
const STATUS_LABEL = { connected: 'Connected', syncing: 'Synchronizing', needs_attention: 'Needs attention', disconnected: 'Disconnected' };
/** Lifecycle states from the server's connector registry, and the existing pill colour each one uses. */
const LIFECYCLE = {
    indexed: ['Sync completed', 'connected'], connected: ['Connected', 'connected'], syncing: ['Syncing', 'syncing'], pending_approval: ['Authorization pending', 'syncing'],
    reauthorization_required: ['Reconnect required', 'needs_attention'], permission_denied: ['Permission denied', 'needs_attention'], error: ['Error', 'needs_attention'],
    disconnected: ['Not connected', 'not_connected'], authorization_required: ['Not connected', 'not_connected'], available: ['Available', 'not_connected'], needs_setup: ['Needs server setup', 'planned'],
    unsupported: ['Not available yet', 'planned'], not_connected: ['Not connected', 'not_connected']
};
const CATEGORY = { email: 'Email', files: 'Files and documents', messages: 'Text messages', databases: 'Databases', imports: 'Uploads and imports', demo: 'Demo data', planned: 'Not connected in this proof of concept' };
const ICON = { public: 'P', stub: '\u25CC', phonelink: '✆', gmail: '✉', uploads: '⇪', messages: '✆', database: '⛁', synthetic: '◇', gdrive: '△', onedrive: '☁', sharepoint: '▦', outlook: '✉' };
let status;
let sys = null;
let pollTimer = 0;
async function main() {
    status = await initShell({ title: 'Connected Sources' });
    replace($('#root'), h('div', { class: 'banner info', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '\u2139'), h('span', null, 'Every source is read-only. The tool never writes to, sends from, or deletes in a source system.')), h('div', { id: 'flash' }), h('div', { class: 'tiles', id: 'system-status' }), h('div', { id: 'provider-cards' }), h('section', { class: 'card', 'aria-labelledby': 'ds-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'ds-h' }, 'Data sources at a glance')), h('div', { class: 'table-scroll', id: 'source-summary' })), h('section', { class: 'card', 'aria-labelledby': 'cs-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'cs-h' }, 'Connected sources'), h('span', { class: 'micro', id: 'source-count' })), h('div', { class: 'grid-cards', id: 'source-list' })), h('section', { class: 'card', 'aria-labelledby': 'as-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'as-h' }, 'Add or request a source')), h('div', { class: 'connector-groups', id: 'connector-list' })), h('section', { class: 'card', id: 'known-gaps', 'aria-labelledby': 'kg-h' }, h('h2', { id: 'kg-h' }, 'Known gaps'), h('p', { class: 'helper' }, 'Loading\u2026')));
    loadGaps();
    const q = new URLSearchParams(location.search);
    if (q.get('connected'))
        replace($('#flash'), alertBox('The account is connected. The first synchronization has started; it can take a few minutes for a large mailbox or drive.', 'ok'));
    if (q.get('error'))
        replace($('#flash'), alertBox(q.get('error').slice(0, 300)));
    const welcome = q.get('welcome');
    if (q.get('linked'))
        replace($('#flash'), alertBox(`Your ${q.get('linked') === 'microsoft' ? 'Microsoft' : 'Google'} account is linked. Connect its services below; each one asks for its own read-only permission.`, 'ok'));
    if (q.get('link_error'))
        replace($('#flash'), alertBox(`${q.get('link_error').slice(0, 300)} You are still signed in.`));
    if (q.has('connected') || q.has('error') || q.has('linked') || q.has('link_error') || welcome)
        history.replaceState(null, '', '/sources.html');
    if (welcome === 'google' && !(status.identities || []).some(i => i.provider === 'microsoft'))
        linkMicrosoftPopup();
    sys = (await get('/api/system/status').catch(() => null))?.data ?? null;
    renderStatus();
    await Promise.all([loadSources(), loadConnectors()]);
}
/**
 * After "Continue with Google": offer to link a Microsoft account too. Skipping keeps the Google session and
 * changes nothing; Microsoft can be linked later from the Microsoft card.
 */
function linkMicrosoftPopup() {
    const ready = Boolean(status.signIn?.microsoft);
    const link = h('button', { type: 'button', class: 'button primary', disabled: !ready }, 'Link Microsoft Account');
    const skip = h('button', { type: 'button', class: 'button secondary' }, 'Skip for Now');
    const out = h('div');
    const dlg = openDialog('Link Your Microsoft Account', h('div', null, h('p', null, 'To provide access to your connected applications, link your Microsoft account as well. This allows you to connect Outlook, OneDrive and eligible SharePoint sources.'), ready ? null : h('p', { class: 'hint' }, 'Microsoft sign-in is not set up on this server yet. An administrator adds MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (docs/SETUP.md, section 6a).'), out, h('div', { class: 'form-row' }, link, skip)));
    skip.addEventListener('click', () => dlg.close());
    link.addEventListener('click', () => linkMicrosoft(link, out));
}
/** Start linking: Microsoft's own sign-in page, then back here. Bound to this session on the server. */
async function linkMicrosoft(btn, out) {
    try {
        const r = await busy(btn, 'Opening Microsoft…', () => post('/api/signin/link/microsoft'));
        location.href = r.data.url;
    }
    catch (e) {
        const box = alertBox(e instanceof ApiError ? e.message : 'Could not start linking.');
        if (out)
            replace(out, box);
        else
            toast(e instanceof ApiError ? e.message : 'Could not start linking.', 'error');
    }
}
function renderStatus() {
    if (!sys)
        return;
    const item = (label, ok, text) => h('div', { class: 'tile' }, h('span', null, label), h('p', null, h('span', { class: `pill ${ok ? 'ok' : 'gray'}` }, ok ? 'On' : 'Off'), ' ', text));
    replace($('#system-status'), item('AI plan drafts', sys.ai.configured, sys.ai.configured ? `${sys.ai.model}. Sees request text and plans only.` : 'Local rules draft plans.'), item('Meaning matching', true, 'Related wording from the city pack, matched on this server.'), item('Real sources', Boolean(status.realSources), status.realSources ? 'Allowed on this server.' : 'Off. Tier 0 data only.'), item('OCR for scans', sys.ocr.enabled && sys.ocr.installed, sys.ocr.enabled && sys.ocr.installed ? 'Available.' : 'Not installed.'));
}
async function loadGaps() {
    const wf = await get('/api/settings/workflow').then(r => r.data).catch(() => null);
    if (!wf)
        return;
    replace($('#known-gaps'), h('h2', { id: 'kg-h' }, 'Known gaps'), h('ul', { class: 'plain-list' }, wf.pack.knownGaps.map(g => h('li', null, g))), h('p', { class: 'hint' }, 'This text is copied into every search record.'));
}
function publicDocDialog() {
    const url = h('input', { type: 'url', id: 'pd-url', placeholder: 'https://' });
    const date = h('input', { type: 'date', id: 'pd-date' });
    const terms = h('input', { type: 'checkbox' });
    const file = h('input', { type: 'file', id: 'pd-file', accept: '.pdf,.docx,.xlsx,.csv,.txt,.md,.json' });
    const go = h('button', { type: 'button', class: 'button primary' }, 'Add document');
    const out = h('div');
    const dlg = openDialog('Add a public document', h('div', null, h('p', { class: 'helper' }, 'Only openly published documents belong here (Tier 0). Record where each file came from.'), field('File', file), field('Public web address it came from', url), field('Date you downloaded it', date), h('label', { class: 'inline-check consent-ack' }, terms, 'I checked that the site\u2019s terms of use allow this use.'), out, h('div', { class: 'form-row' }, go)));
    go.addEventListener('click', async () => {
        replace(out);
        const f = file.files?.[0];
        if (!f) {
            replace(out, alertBox('Choose a file.'));
            return;
        }
        try {
            const res = await busy(go, 'Adding\u2026', () => api('POST', '/api/uploads?kind=public', undefined, { raw: f, headers: { 'x-file-name': encodeURIComponent(f.name), 'content-type': f.type || 'application/octet-stream', 'x-source-url': url.value.trim(), 'x-retrieved-at': date.value, 'x-terms-checked': terms.checked ? 'yes' : 'no' } }));
            void res;
            toast('Document added with its provenance');
            dlg.close();
            loadSources();
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not add the document.'));
        }
    });
}
function requestAccess(c) {
    openDialog(`${c.name}: not connected`, h('div', null, h('p', null, c.description), c.note ? h('p', { class: 'hint' }, c.note) : null, h('h3', null, 'To connect it later'), h('ol', { class: 'guide-steps' }, h('li', null, 'City IT grants read-only access scoped to named sites or mailboxes.'), h('li', null, 'The connector is built against that access and tested on Tier 1 data first.'), h('li', null, 'Until then, every search lists this source as NOT searched.')), h('p', { class: 'hint' }, 'This page does not send a request to anyone. Ask city IT directly.')));
}
async function loadSources() {
    const list = $('#source-list');
    let sources;
    try {
        sources = (await get('/api/sources')).data;
    }
    catch (e) {
        replace(list, alertBox(e instanceof ApiError ? e.message : 'Sources could not be loaded.'));
        return;
    }
    $('#source-count').textContent = `${sources.length} CONNECTED \u00B7 ${fmtNum(sources.reduce((a, s) => a + s.recordCount, 0))} RECORDS`;
    replace(list, ...(sources.length ? sources.map(sourceCard) : [empty('No sources yet', 'Add one below.')]));
    replace($('#source-summary'), summaryTable(sources));
    providerCards(sources);
    const waiting = sources.filter(s => s.canApprove);
    if (waiting.length)
        replace($('#flash'), alertBox(`${waiting.length} source${waiting.length > 1 ? 's are' : ' is'} waiting for your approval: ${waiting.map(s => s.name).join(', ')}. Nothing is synchronized or searched until you approve.`, 'info'));
    const reconnect = sources.filter(s => s.lifecycle === 'reauthorization_required' && s.isOwner);
    if (reconnect.length && !waiting.length)
        replace($('#flash'), alertBox(`Sign in again to keep ${reconnect.map(s => s.name).join(', ')} up to date. Already indexed records stay searchable.`, 'warn'));
    clearTimeout(pollTimer);
    if (sources.some(s => s.status === 'syncing'))
        pollTimer = window.setTimeout(loadSources, 2500);
}
/** One row per source: provider, state, what it may read, last good sync, records, and the actions that matter most. */
function summaryTable(sources) {
    const real = sources.filter(s => !s.isSynthetic);
    if (!real.length)
        return empty('No real sources yet', 'Connect one under “Add or request a source”.');
    return h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Provider', 'Source', 'Status', 'Permissions', 'Last successful sync', 'Records', 'Problem', 'Actions'].map(x => h('th', { scope: 'col' }, x)))), h('tbody', null, real.map(s => {
        const life = s.lifecycle ? LIFECYCLE[s.lifecycle] : null;
        const actions = h('div', { class: 'card-actions compact' });
        if (s.canManage && s.syncs && s.lifecycle !== 'pending_approval')
            actions.append(h('button', { type: 'button', class: 'button small secondary', disabled: s.status === 'syncing', on: { click: async (e) => {
                        try {
                            await busy(e.currentTarget, 'Starting…', () => post(`/api/sources/${s.id}/sync`));
                            toast('Synchronization started');
                            loadSources();
                        }
                        catch (err) {
                            toast(err instanceof ApiError ? err.message : 'Could not start.', 'error');
                        }
                    } } }, 'Sync now'));
        if (s.canManage)
            actions.append(h('button', { type: 'button', class: 'button small danger', on: { click: () => disconnect(s) } }, isOAuth(s.type) ? 'Disconnect' : 'Remove'));
        return h('tr', null, h('td', null, SOURCE_LABEL[s.type] || s.type), h('th', { scope: 'row' }, s.name, s.accountLabel ? h('div', { class: 'helper' }, s.accountLabel) : null), h('td', null, life ? h('span', { class: `status-pill st-${life[1]}` }, life[0]) : s.status), h('td', null, s.scopes.length ? s.scopes.map(x => h('code', { class: 'scope' }, x.split('/').pop())) : '–'), h('td', null, s.lastSuccessAt ? fmtDate(s.lastSuccessAt, true) : s.syncs ? 'Never' : '–'), h('td', null, fmtNum(s.recordCount)), h('td', null, s.lastError ? h('span', { class: 'helper' }, s.lastError.slice(0, 160)) : '–'), h('td', null, actions));
    })));
}
function sourceCard(s) {
    const life = s.lifecycle ? LIFECYCLE[s.lifecycle] : null;
    const pill = life ? h('span', { class: `status-pill st-${life[1]}` }, life[0]) : h('span', { class: `status-pill st-${s.status}` }, STATUS_LABEL[s.status] || s.status);
    const pending = s.lifecycle === 'pending_approval';
    const sharing = s.visibility === 'owner' ? `Only ${s.isOwner ? 'you' : s.owner?.name || 'the owner'}` : s.allowedRoles.length ? s.allowedRoles.map(r => ROLE_LABEL[r]).join(', ') : 'Every role that can search';
    const cardEl = h('article', { class: `source-card src-${s.type}`, 'aria-labelledby': `s-${s.id}` }, h('header', { class: 'source-head' }, h('span', { class: 'source-icon', 'aria-hidden': 'true' }, ICON[s.type] || '•'), h('div', null, h('h3', { id: `s-${s.id}` }, s.name), h('p', { class: 'helper' }, s.accountLabel || '')), pill), h('dl', { class: 'source-facts' }, h('dt', null, 'Indexed records'), h('dd', null, fmtNum(s.recordCount), s.duplicateCount ? ` (${s.duplicateCount} duplicates)` : ''), h('dt', null, 'Last synchronized'), h('dd', null, s.lastSyncAt ? `${fmtDate(s.lastSyncAt, true)}${s.lastSyncStatus === 'failed' ? ' (failed)' : ''}` : 'Never'), s.syncs && s.lastSyncStatus === 'failed' ? [h('dt', null, 'Last successful'), h('dd', null, s.lastSuccessAt ? fmtDate(s.lastSuccessAt, true) : 'Never')] : null, s.credentials === 'stored_encrypted' ? [h('dt', null, 'Credentials'), h('dd', null, 'Stored encrypted on the server. Never shown here.')] : null, h('dt', null, 'Who can search it'), h('dd', null, sharing), s.owner ? [h('dt', null, 'Connected by'), h('dd', null, s.owner.name)] : null, s.scopes.length ? [h('dt', null, 'Access granted'), h('dd', null, h('ul', { class: 'plain-list' }, s.scopes.map(x => h('li', null, h('code', null, x)))))] : null, s.repositories.length ? [h('dt', null, s.type === 'database' ? 'Tables' : 'Scope'), h('dd', null, s.repositories.map(r => r.name).join(', '))] : null), s.lastError ? alertBox(s.lastError, 'error', s.type === 'gmail' && s.canManage ? h('button', { type: 'button', class: 'button secondary', on: { click: () => startGmail() } }, 'Reconnect Gmail')
        : s.type === 'gdrive' && s.canManage ? h('button', { type: 'button', class: 'button secondary', on: { click: () => startDrive() } }, 'Reconnect Google Drive')
            : isMicrosoft(s.type) && s.canManage ? h('button', { type: 'button', class: 'button secondary', on: { click: () => startMicrosoft(s.type) } }, `Reconnect ${MS_NAME[s.type]}`) : undefined) : null, s.isSynthetic ? h('p', { class: 'helper' }, 'Invented records for Tier 0 demo searches. They never appear in real-source results.') : s.publicDocs ? h('p', { class: 'helper' }, 'Openly published documents. Each one keeps its web address and retrieval date.') : null, s.experimental ? h('p', null, h('span', { class: 'pill warn' }, 'Experimental'), ' ', h('a', { href: '/phone-review.html' }, 'Review your matches')) : null, pending ? h('p', { class: 'banner info' }, s.canApprove
        ? `${s.owner?.name || 'Someone'} connected this source. It is not synchronized or searched until a Supervisor approves it.`
        : 'Waiting for a Supervisor to approve this source. It is not synchronized or searched until then.') : null, s.canApprove ? h('div', { class: 'card-actions' }, h('button', { type: 'button', class: 'button primary', on: { click: (e) => decide(e, s, 'approve') } }, 'Approve'), h('button', { type: 'button', class: 'button danger', on: { click: (e) => decide(e, s, 'reject') } }, 'Reject and remove')) : null);
    if (s.canManage) {
        const actions = h('div', { class: 'card-actions' });
        const phone = s.provider === 'phonelink', helper = s.provider === 'phonelink-agent';
        if (s.syncs && !pending) {
            actions.append(h('button', { type: 'button', class: 'button primary', disabled: s.status === 'syncing', on: { click: async (e) => {
                        try {
                            await busy(e.currentTarget, 'Starting…', () => post(`/api/sources/${s.id}/sync`));
                            toast('Synchronization started');
                            loadSources();
                        }
                        catch (err) {
                            toast(err instanceof ApiError ? err.message : 'Could not start.', 'error');
                        }
                    } } }, s.status === 'syncing' ? 'Synchronizing…' : 'Sync now'));
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showJobs(s) } }, 'Sync history'));
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: (e) => checkAccess(e, s) } }, 'Check access'));
            if (isOAuth(s.type) && s.isOwner)
                actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => s.type === 'gmail' ? startGmail() : s.type === 'gdrive' ? startDrive() : startMicrosoft(s.type) } }, 'Reconnect'));
        }
        if (can(status, 'audit.read')) {
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showActivity(s) } }, 'Activity'));
        }
        if (phone || helper)
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showRecords(s) } }, 'View conversations'));
        if (helper)
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => syncHelper() } }, 'Helper keys'));
        if ((s.type === 'uploads' || s.type === 'messages') && !phone && !helper) {
            actions.append(fileButton(s.type === 'uploads' ? 'Upload more files' : 'Import more messages', s.type, s.id));
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => showRecords(s) } }, 'Manage files'));
        }
        if (s.type === 'database')
            actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => previewDb(s) } }, 'Preview rows'));
        actions.append(h('button', { type: 'button', class: 'button secondary', on: { click: () => editSharing(s) } }, 'Sharing'));
        actions.append(h('button', { type: 'button', class: 'button danger', on: { click: () => disconnect(s) } }, isOAuth(s.type) ? 'Disconnect' : 'Remove'));
        cardEl.append(actions);
    }
    return cardEl;
}
async function loadConnectors() {
    let list;
    try {
        list = (await get('/api/connectors')).data;
    }
    catch {
        return;
    }
    const manage = can(status, 'sources.manage'), upload = can(status, 'uploads.create');
    const cards = list.map(c => {
        let action = null;
        if (c.status === 'not_connected')
            action = h('div', { class: 'card-actions' }, h('span', { class: 'pill bad' }, '\u2715 Not connected'), h('button', { type: 'button', class: 'button small secondary', on: { click: () => requestAccess(c) } }, 'Request access'));
        else if (c.type === 'public')
            action = upload ? h('button', { type: 'button', class: 'button primary', on: { click: publicDocDialog } }, 'Add public document') : h('p', { class: 'helper' }, 'Your role cannot add documents.');
        else if (c.status === 'planned')
            action = h('span', { class: 'status-pill st-planned' }, 'Planned');
        else if (c.status === 'needs_configuration')
            action = h('p', { class: 'helper' }, c.reason || 'Needs configuration.');
        else if (c.type === 'phonelink' && manage)
            action = h('div', { class: 'card-actions' }, c.local ? h('button', { type: 'button', class: 'button primary', on: { click: () => phoneLink() } }, 'Check this PC') : null, h('button', { type: 'button', class: c.local ? 'button secondary' : 'button primary', on: { click: () => syncHelper() } }, 'PC sync helper'));
        else if (c.type === 'gmail' && manage)
            action = h('button', { type: 'button', class: 'button primary', on: { click: () => startGmail() } }, 'Connect Gmail');
        else if (c.type === 'gdrive' && manage)
            action = h('button', { type: 'button', class: 'button primary', on: { click: () => startDrive() } }, 'Connect Google Drive');
        else if (isMicrosoft(c.type) && manage)
            action = h('button', { type: 'button', class: 'button primary', on: { click: () => startMicrosoft(c.type) } }, `Connect ${MS_NAME[c.type]}`);
        else if (c.type === 'uploads' && upload)
            action = fileButton('Choose files', 'uploads');
        else if (c.type === 'messages' && upload)
            action = h('div', { class: 'card-actions' }, fileButton('Choose export files', 'messages'), h('button', { type: 'button', class: 'button secondary', on: { click: exportGuide } }, 'How to export messages'));
        else if (c.type === 'database' && manage)
            action = h('button', { type: 'button', class: 'button primary', on: { click: () => dbWizard(c.driver) } }, `Connect ${c.name}`);
        else
            action = h('p', { class: 'helper' }, 'Your role can’t add sources.');
        const life = c.lifecycle ? LIFECYCLE[c.lifecycle] : null;
        return [c.category || 'imports', h('div', { class: `connector-card is-${c.status}` }, h('div', { class: 'source-head' }, h('span', { class: 'source-icon', 'aria-hidden': 'true' }, ICON[c.type] || '•'), h('h3', null, c.name), c.experimental ? h('span', { class: 'pill warn' }, 'Experimental') : null, life && c.status !== 'not_connected' ? h('span', { class: `status-pill st-${life[1]}` }, life[0]) : null), c.approvalRequired ? h('p', { class: 'helper' }, 'A Supervisor approves new sources before they are synchronized or searched.') : null, h('p', null, c.description), c.permissions.length ? h('p', { class: 'helper' }, h('b', null, 'Access: '), c.permissions.join('; ')) : null, c.note ? h('p', { class: 'helper' }, c.note) : null, action)];
    });
    // Group by category, each under its own heading.
    const ORDER = ['email', 'files', 'messages', 'databases', 'imports', 'demo', 'planned'];
    const order = [...new Set(cards.map(([cat]) => cat))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    replace($('#connector-list'), ...order.map(cat => h('div', { class: 'connector-group' }, h('h3', { class: 'micro' }, CATEGORY[cat] || cat), h('div', { class: 'grid-cards' }, ...cards.filter(([k]) => k === cat).map(([, el]) => el)))));
}
async function phoneLink() {
    const body = h('div', { class: 'consent' }, h('p', { class: 'helper' }, 'Looking for Phone Link on this PC…'));
    const dlg = openDialog('Android texts through Phone Link', body);
    let chk;
    try {
        chk = (await get('/api/connectors/phonelink/check')).data;
    }
    catch (e) {
        replace(body, alertBox(e instanceof ApiError ? e.message : 'Could not check this PC.'), setupSteps());
        return;
    }
    if (!chk.found) {
        replace(body, alertBox(chk.reason || 'Phone Link was not found.'), setupSteps());
        return;
    }
    if (!chk.recognized) {
        replace(body, alertBox(chk.reason || 'The message table was not recognized.'), h('p', { class: 'helper' }, `Tables found: ${(chk.tables || []).join(', ') || 'none'}`));
        return;
    }
    const ack = h('input', { type: 'checkbox' });
    const go = h('button', { type: 'button', class: 'button primary' }, 'Connect and index my texts');
    const out = h('div');
    replace(body, alertBox(`Found ${fmtNum(chk.messages || 0)} text${chk.messages === 1 ? '' : 's'}${chk.conversations != null ? ` in ${fmtNum(chk.conversations)} conversation${chk.conversations === 1 ? '' : 's'}` : ''}${chk.oldest ? `, from ${fmtDate(chk.oldest)} to ${fmtDate(chk.newest || chk.oldest)}` : ''}.`, 'ok'), h('h3', null, 'What happens'), h('ul', null, h('li', null, 'The app reads the copy of your texts that Phone Link keeps on this PC. No export, and nothing on your phone is changed.'), h('li', null, 'New texts are picked up automatically every few minutes and again right before each search.'), h('li', null, `Texts are grouped into one record per conversation per day${chk.contactNames ? ', with contact names' : ''}. Only you can search them unless you share the source.`), h('li', null, 'Phone Link keeps only recent texts, so older ones may be missing. Remove the source at any time to delete everything indexed.')), h('label', { class: 'inline-check consent-ack' }, ack, 'These are my own texts (or I am authorized to index them) and I want them searchable here.'), out, h('div', { class: 'form-row' }, go));
    go.addEventListener('click', async () => {
        replace(out);
        if (!ack.checked) {
            replace(out, alertBox('Tick the box to confirm.'));
            return;
        }
        try {
            await busy(go, 'Connecting…', () => post('/api/connectors/phonelink/connect', { acknowledged: true }));
            dlg.close?.();
            toast('Phone Link connected. Indexing your texts…');
            location.reload();
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not connect.'));
        }
    });
}
async function syncHelper() {
    const body = h('div', { class: 'consent' });
    openDialog('PC sync helper for Android texts', body, { wide: true });
    const list = h('div');
    const name = h('input', { value: 'My PC', maxlength: 60 });
    name.value = 'My PC';
    const ack = h('input', { type: 'checkbox' });
    const create = h('button', { type: 'button', class: 'button primary' }, 'Create helper key');
    const out = h('div');
    replace(body, h('p', null, 'This website runs on a server, so it cannot read files on your PC. The helper is a small program on your Windows PC that reads the texts Phone Link keeps there and sends new ones here every few minutes, over HTTPS. No exporting.'), h('ul', null, h('li', null, 'It only reads Phone Link’s copy of your texts. Nothing on your phone is changed.'), h('li', null, 'Its key can only add texts to your own private source. It cannot search or read anything here.'), h('li', null, 'Your PC must be on, with Phone Link running, for new texts to arrive. Revoke the key at any time to stop it.')), list, h('h3', null, 'Create a key'), field('Name for this PC', name), h('label', { class: 'inline-check consent-ack' }, ack, 'These are my own texts (or I am authorized to index them) and I want them sent to this site.'), out, h('div', { class: 'form-row' }, create));
    const loadKeys = async () => {
        try {
            const keys = (await get('/api/agent-tokens')).data;
            replace(list, keys.length ? h('div', null, h('h3', null, 'Your helper keys'), h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'PC'), h('th', null, 'Texts indexed'), h('th', null, 'Last contact'), h('th', null, ''))), h('tbody', null, keys.map(k => h('tr', null, h('td', null, k.name), h('td', null, fmtNum(k.records)), h('td', null, k.revokedAt ? 'Revoked' : k.lastUsedAt ? fmtDate(k.lastUsedAt, true) : 'Never'), h('td', null, k.revokedAt ? null : h('button', { type: 'button', class: 'button danger small', on: { click: async () => {
                        if (!confirm(`Revoke the key for ${k.name}? The helper on that PC stops sending texts. Texts already here stay until you remove the source.`))
                            return;
                        try {
                            await del(`/api/agent-tokens/${k.id}`);
                            toast('Key revoked');
                            loadKeys();
                        }
                        catch (e) {
                            toast(e instanceof ApiError ? e.message : 'Could not revoke.', 'error');
                        }
                    } } }, 'Revoke'))))))) : null);
        }
        catch {
            replace(list);
        }
    };
    loadKeys();
    create.addEventListener('click', async () => {
        replace(out);
        if (!ack.checked) {
            replace(out, alertBox('Tick the box to confirm.'));
            return;
        }
        try {
            const res = await busy(create, 'Creating…', () => post('/api/agent-tokens', { name: name.value.trim() || 'My PC', acknowledged: true }));
            const keyBox = h('input', { readonly: true, value: res.data.token, class: 'mono-input' });
            keyBox.value = res.data.token;
            const copy = h('button', { type: 'button', class: 'button secondary', on: { click: async () => { try {
                        await navigator.clipboard.writeText(res.data.token);
                        toast('Key copied');
                    }
                    catch {
                        keyBox.select();
                    } } } }, 'Copy key');
            replace(out, alertBox('Key created. Copy it now: it is shown only once.', 'ok'), h('div', { class: 'form-row' }, keyBox, copy), h('h3', null, 'Set up the helper on your Windows PC'), h('ol', { class: 'guide-steps' }, h('li', null, 'Make sure Phone Link is set up and your texts appear in its Messages tab.'), h('li', null, 'On that PC, open the project folder (the one with start.bat) and double-click ', h('b', null, 'phonelink-sync.bat'), '.'), h('li', null, 'When asked, paste this website’s address: ', h('code', null, location.origin), '.'), h('li', null, 'Paste the key above. The helper sends your texts and then keeps checking for new ones.'), h('li', null, 'To start it automatically, press Win+R, type ', h('code', null, 'shell:startup'), ', and put a shortcut to phonelink-sync.bat in that folder.')));
            create.hidden = true;
            loadKeys();
            loadSources();
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not create the key.'));
        }
    });
}
function setupSteps() {
    return h('div', null, h('h3', null, 'Set up Phone Link first'), h('ol', { class: 'guide-steps' }, h('li', null, 'On this Windows PC, open ', h('b', null, 'Phone Link'), ' from the Start menu.'), h('li', null, 'Pair your Android phone (install ', h('b', null, 'Link to Windows'), ' on the phone and scan the QR code).'), h('li', null, 'On the phone, allow Messages access, and open the Messages tab in Phone Link once so it syncs.'), h('li', null, 'Come back here and choose Check this PC again.')), h('p', { class: 'helper' }, 'This app must be running on that same PC and opened at http://localhost. iPhone texts are not stored this way, so they still need an export.'));
}
/* ---------------- message export guide ---------------- */
function exportGuide() {
    const step = (title, items) => h('section', { class: 'guide-step' }, h('h3', null, title), h('ol', null, items.map(i => h('li', null, i))));
    openDialog('How to export messages as files', h('div', { class: 'guide' }, h('p', null, 'Phones only let the owner export their messages. Ask the person who holds the phone to make the export, then upload the file here with “Choose export files”.'), step('Android text messages (SMS)', [
        'Install “SMS Backup & Restore” by SyncTech from the Google Play Store.',
        'Open it, tap “Set up a backup”, turn on Messages only, and choose where to save (phone storage, Google Drive or email).',
        'Tap “Back up now”. It creates a file named like sms-20250120.xml.',
        'Copy that .xml file to this computer (USB cable, Google Drive or email) and upload it.'
    ]), step('WhatsApp (Android or iPhone)', [
        'Open the chat, tap the contact or group name (iPhone) or the ⋮ menu → More (Android).',
        'Tap “Export chat”, then “Without media”.',
        'Send it to yourself by email or save it to Files or Drive.',
        'Android gives a .txt file; upload it as is. iPhone gives a .zip: open it and upload the _chat.txt inside.'
    ]), step('iPhone text messages and iMessage', [
        'iPhone has no built-in export. Use a desktop tool that exports messages to CSV (for example iMazing, connected by cable).',
        'Make sure the CSV has columns named date, from, to and body (optionally conversation).',
        'Upload the .csv file.'
    ]), step('Any other app', ['Save the messages as a CSV with date, from, to and body columns, and upload it.']), h('p', { class: 'helper' }, 'Only import messages your organization is entitled to hold as records, and follow your policy on telling the people involved. Imports are private to you unless you share the source, and every import is written to the audit log.')), { wide: true });
}
/* ---------------- Gmail consent ---------------- */
function startGmail() {
    const query = h('input', { id: 'g-query', value: 'newer_than:2y' });
    query.value = 'newer_than:2y';
    const share = sharingPicker();
    const go = h('button', { type: 'button', class: 'button primary' }, 'Continue to Google');
    const dlg = openDialog('Connect a Gmail account', h('div', { class: 'consent' }, h('p', null, 'You’ll be sent to Google to sign in and approve access. This app never sees or stores your Google password.'), h('h3', null, 'What this app will ask Google for'), h('ul', null, h('li', null, h('b', null, 'Read your email messages and settings'), ' (', h('code', null, 'gmail.readonly'), '). It cannot send, delete, or change anything in your mailbox.')), h('h3', null, 'What happens next'), h('ul', null, h('li', null, 'Messages matching the filter below, and their attachments in supported formats, are copied into this app’s search index.'), h('li', null, 'The access token is stored encrypted. Every sync and record view is written to the audit log.'), h('li', null, 'Disconnecting revokes the access at Google and deletes every copied message and attachment.')), field('Which messages to include (Gmail search syntax)', query, 'For example: newer_than:1y, label:records, from:contractor.com. Leave empty for all mail except spam and trash.'), share.el, h('div', { class: 'form-row' }, go)));
    go.addEventListener('click', async () => {
        try {
            const res = await busy(go, 'Opening Google…', () => post('/api/connectors/gmail/authorize', { query: query.value.trim(), ...share.value() }));
            location.href = res.data.url;
        }
        catch (e) {
            dlg.querySelector('.modal-body').append(alertBox(e instanceof ApiError ? e.message : 'Could not start the connection.'));
        }
    });
}
const MS_NAME = { outlook: 'Outlook mail', onedrive: 'OneDrive', sharepoint: 'SharePoint' };
const isMicrosoft = (type) => type === 'outlook' || type === 'onedrive' || type === 'sharepoint';
function startMicrosoft(kind) {
    const share = sharingPicker();
    const go = h('button', { type: 'button', class: 'button primary' }, 'Continue to Microsoft');
    const site = h('input', { id: 'sp-site', type: 'url', placeholder: 'https://contoso.sharepoint.com/sites/Records' });
    const what = kind === 'outlook'
        ? [h('li', null, h('b', null, 'Read your mail'), ' (', h('code', null, 'Mail.Read'), '). It cannot send, delete, move or change any message.')]
        : kind === 'sharepoint'
            ? [h('li', null, h('b', null, 'Read items in sites you can already open'), ' (', h('code', null, 'Sites.Read.All'), ', on your behalf). It cannot change, upload or delete anything. Some organizations need an administrator to approve this first.')]
            : [h('li', null, h('b', null, 'Read your files'), ' (', h('code', null, 'Files.Read'), '). It cannot upload, delete or change any file.')];
    const dlg = openDialog(`Connect ${MS_NAME[kind]}`, h('div', { class: 'consent' }, h('p', null, 'You’ll be sent to Microsoft to sign in and approve access. Personal accounts (Outlook.com, Hotmail) and work or school accounts both work. This app never sees or stores your Microsoft password.'), h('h3', null, 'What this app will ask Microsoft for'), h('ul', null, ...what, h('li', null, h('b', null, 'Your basic profile'), ' (', h('code', null, 'User.Read'), '), to label the source with your address.'), h('li', null, h('code', null, 'offline_access'), ', so syncs keep working after you sign out.')), h('h3', null, 'What happens next'), h('ul', null, kind === 'outlook'
        ? h('li', null, 'Mail from the last two years, except Deleted Items and Junk, and attachments in supported formats, are copied into this app’s search index.')
        : h('li', null, `PDF, Word, Excel, CSV, text and image files in ${kind === 'sharepoint' ? 'the site’s document library' : 'your OneDrive'} are copied into this app’s search index. Later syncs pick up changes and deletions.`), h('li', null, 'The access token is stored encrypted. Every sync and record view is written to the audit log.'), h('li', null, 'Disconnecting deletes the stored access and every copied item. To also remove the app from your Microsoft account, use account.live.com/consent/Manage (personal) or myapps.microsoft.com (work).')), kind === 'sharepoint' ? field('SharePoint site address', site, 'Work or school accounts only. Copy it from the browser while the site is open.') : null, share.el, h('div', { class: 'form-row' }, go)));
    go.addEventListener('click', async () => {
        try {
            const res = await busy(go, 'Opening Microsoft…', () => post('/api/connectors/microsoft/authorize', { kind, siteUrl: site.value.trim(), ...share.value() }));
            location.href = res.data.url;
        }
        catch (e) {
            dlg.querySelector('.modal-body').append(alertBox(e instanceof ApiError ? e.message : 'Could not start the connection.'));
        }
    });
}
/* ---------------- Google Drive consent ---------------- */
const isOAuth = (type) => type === 'gmail' || type === 'gdrive' || isMicrosoft(type);
function startDrive() {
    const share = sharingPicker();
    const go = h('button', { type: 'button', class: 'button primary' }, 'Continue to Google');
    const dlg = openDialog('Connect Google Drive', h('div', { class: 'consent' }, h('p', null, 'You’ll be sent to Google to sign in and approve access. This app never sees or stores your Google password.'), h('h3', null, 'What this app will ask Google for'), h('ul', null, h('li', null, h('b', null, 'See and download your Google Drive files'), ' (', h('code', null, 'drive.readonly'), '). It cannot upload, change, share or delete anything in your Drive.')), h('h3', null, 'What happens next'), h('ul', null, h('li', null, 'Files in My Drive and files shared with you are copied into this app’s search index: Google Docs, Sheets and Slides as text, plus PDF, Word, Excel, CSV, text and image files. The trash is skipped.'), h('li', null, 'Later syncs read only what changed, including files that were trashed or removed.'), h('li', null, 'The access token is stored encrypted. Disconnecting revokes it at Google and deletes every copied file.')), share.el, h('div', { class: 'form-row' }, go)));
    go.addEventListener('click', async () => {
        try {
            const res = await busy(go, 'Opening Google…', () => post('/api/connectors/gmail/authorize', { kind: 'gdrive', ...share.value() }));
            location.href = res.data.url;
        }
        catch (e) {
            dlg.querySelector('.modal-body').append(alertBox(e instanceof ApiError ? e.message : 'Could not start the connection.'));
        }
    });
}
/**
 * Who can search a source being connected. Everyone in the organization is the default, so every login sees the
 * same connected sources; "Only me" and specific roles stay available. Changeable later with Sharing.
 */
function sharingPicker() {
    const name = `share-${Math.random().toString(36).slice(2, 8)}`;
    const radio = (value, label, checked = false) => {
        const el = h('input', { type: 'radio', name, value, checked });
        return { el, row: h('label', { class: 'inline-check' }, el, label) };
    };
    // Private by default: sharing with others is always an explicit choice.
    const owner = radio('owner', 'Only me', true), org = radio('org', 'Everyone in the organization who can search'), some = radio('roles', 'Only these roles:');
    const roles = roleChecks([]);
    const sync = () => roles.el.toggleAttribute('hidden', !some.el.checked);
    for (const r of [owner, org, some])
        r.el.addEventListener('change', sync);
    sync();
    return {
        el: h('fieldset', { class: 'source-pick' }, h('legend', null, 'Who can search it'), owner.row, org.row, some.row, roles.el, h('p', { class: 'hint' }, 'Only you can search it unless you choose otherwise. You can change this later with Sharing on the source card.')),
        value: () => org.el.checked ? { visibility: 'org', shareWithRoles: [] }
            : some.el.checked && roles.value().length ? { visibility: 'roles', shareWithRoles: roles.value() } : { visibility: 'owner', shareWithRoles: [] }
    };
}
function roleChecks(selected) {
    const boxes = ROLES.map(r => h('input', { type: 'checkbox', value: r, checked: selected.includes(r) }));
    return { el: h('div', { class: 'role-checks' }, ...boxes.map((b, i) => h('label', { class: 'inline-check' }, b, ROLE_LABEL[ROLES[i]]))), value: () => boxes.filter(b => b.checked).map(b => b.value) };
}
/* ---------------- uploads ---------------- */
function fileButton(label, kind, sourceId) {
    const inputEl = h('input', { type: 'file', multiple: true, class: 'visually-hidden', accept: kind === 'uploads' ? '.pdf,.docx,.xlsx,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.tif,.tiff,.webp' : '.xml,.txt,.csv' });
    const btn = h('button', { type: 'button', class: 'button secondary', on: { click: () => inputEl.click() } }, label);
    inputEl.addEventListener('change', () => { if (inputEl.files?.length)
        uploadAll([...inputEl.files], kind, sourceId); inputEl.value = ''; });
    return h('span', null, btn, inputEl);
}
async function uploadAll(files, kind, sourceId) {
    const max = sys?.limits.uploadMaxBytes ?? 25 * 1048576;
    const rows = files.map(f => ({ f, li: h('li', null, `${f.name} (${fmtBytes(f.size)}) `, h('span', { class: 'helper' }, 'Waiting…')) }));
    const dlg = openDialog(kind === 'uploads' ? 'Uploading files' : 'Importing messages', h('ul', { class: 'upload-list' }, rows.map(r => r.li)), { onClose: () => loadSources() });
    for (const { f, li } of rows) {
        const out = li.querySelector('span');
        if (f.size > max) {
            out.textContent = `Too large (limit ${fmtBytes(max)}).`;
            li.dataset.state = 'error';
            continue;
        }
        out.textContent = 'Uploading…';
        try {
            const q = new URLSearchParams({ ...(kind === 'messages' ? { kind: 'messages' } : {}), ...(sourceId ? { sourceId } : {}) });
            const res = await uploadFile(f, q.toString() ? `?${q}` : '');
            const d = res.data;
            out.textContent = kind === 'messages'
                ? `Imported ${d.messages} messages into ${d.conversationDays} conversation days.`
                : d.result === 'unchanged' ? 'Already uploaded.' : d.extraction === 'ok' ? `Indexed (${fmtNum(d.characters)} characters).` : (d.notes?.[0] || 'Stored, but no text could be read.');
            li.dataset.state = d.extraction === 'ok' || kind === 'messages' || d.result === 'unchanged' ? 'ok' : 'warn';
        }
        catch (e) {
            out.textContent = e instanceof ApiError ? e.message : 'Failed.';
            li.dataset.state = 'error';
        }
    }
    dlg.querySelector('.modal-body').append(h('div', { class: 'form-row' }, h('button', { type: 'button', class: 'button primary', on: { click: () => dlg.close() } }, 'Done')));
}
async function showRecords(s, page = 1) {
    const res = await get(`/api/sources/${s.id}/records?page=${page}&pageSize=25`).catch(() => null);
    if (!res)
        return;
    const body = h('div', null, res.data.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Title'), h('th', null, 'Type'), h('th', null, 'Added'), h('th', null, h('span', { class: 'visually-hidden' }, 'Actions')))), h('tbody', null, res.data.map(r => h('tr', null, h('td', null, r.title), h('td', null, r.documentType || ''), h('td', null, fmtDate(r.ingestedAt)), h('td', null, h('button', { type: 'button', class: 'button danger small', on: { click: async () => {
                if (!confirm(`Delete “${r.title}” from the index? The stored original is deleted too.`))
                    return;
                try {
                    await del(`/api/records/${r.id}`);
                    toast('Deleted');
                    dlg.close();
                    showRecords(s, page);
                }
                catch (e) {
                    toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error');
                }
            } } }, 'Delete')))))) : empty('Nothing here yet', 'Upload files to add them.'), res.meta && res.meta.total > 25 ? h('p', { class: 'helper' }, `Showing ${res.data.length} of ${res.meta.total}.`) : null);
    const dlg = openDialog(s.name, body, { wide: true, onClose: () => loadSources() });
}
/** Messages fetched of those attempted, e.g. "158 of 159 (519 listed)". Blank for sources that don't report it. */
function jobMessages(j) {
    if (j.attempted == null && j.listed == null)
        return '';
    return `${j.fetched ?? 0} of ${j.attempted ?? 0}${j.listed != null ? ` (${j.listed} listed)` : ''}`;
}
function jobDetails(j) {
    const api = [j.errorEndpoint, j.apiStatus != null ? `HTTP ${j.apiStatus}` : null, j.errorReason].filter(Boolean).join(' · ');
    const calls = j.apiCalls != null ? `${j.apiCalls} API calls${j.rateLimitWaits ? `, waited for the rate limit ${j.rateLimitWaits}×` : ''}` : '';
    return h('div', null, j.error ? h('div', null, j.error) : null, api ? h('div', { class: 'hint' }, `Google API: ${api}`) : null, j.providerMessage ? h('div', { class: 'hint' }, `Google said: ${j.providerMessage}`) : null, calls ? h('div', { class: 'hint' }, calls) : null);
}
/**
 * One card per provider. Each service keeps its own status: signing in to Microsoft does not connect Outlook,
 * and a Drive problem does not mark Gmail as failed.
 */
async function providerCards(sources) {
    const box = $('#provider-cards');
    if (!box)
        return;
    if (!status.realSources || status.user?.isDemo) {
        replace(box);
        return;
    }
    const catalog = (await get('/api/connectors').catch(() => null))?.data ?? [];
    const ids = status.identities || [];
    const service = (type, name, what, start) => {
        const c = catalog.find(x => x.type === type);
        const mine = sources.filter(x => x.type === type);
        const src = mine.find(x => x.isOwner) ?? mine[0];
        const life = src?.lifecycle ? LIFECYCLE[src.lifecycle] : null;
        const pill = !c ? h('span', { class: 'status-pill st-planned' }, 'Not available')
            : c.status === 'needs_configuration' ? h('span', { class: 'status-pill st-planned' }, 'Needs server setup')
                : life ? h('span', { class: `status-pill st-${life[1]}` }, life[0]) : h('span', { class: 'status-pill st-not_connected' }, 'Not connected');
        const action = c && c.status === 'available' && can(status, 'sources.manage')
            ? h('button', { type: 'button', class: 'button small secondary', on: { click: start } }, src?.isOwner ? 'Reconnect' : 'Connect') : null;
        return h('li', { class: 'welcome-item' }, h('div', null, h('b', null, name), h('p', { class: 'helper' }, what), src ? h('p', { class: 'helper' }, `${fmtNum(src.recordCount)} records${src.lastSuccessAt ? ` · last successful sync ${fmtDate(src.lastSuccessAt, true)}` : ''}${src.owner && !src.isOwner ? ` · connected by ${src.owner.name}` : ''}`) : null, c?.status === 'needs_configuration' && c.reason ? h('p', { class: 'hint' }, c.reason) : null), h('div', { class: 'card-actions compact' }, pill, action));
    };
    const account = (provider) => {
        const id = ids.find(i => i.provider === provider);
        if (id)
            return h('p', { class: 'helper' }, h('span', { class: 'pill ok' }, 'Account linked'), ` ${id.email}. Linking signs you in; it does not connect any service by itself.`);
        if (provider === 'microsoft' && status.signIn?.microsoft)
            return h('p', null, h('button', { type: 'button', class: 'button small secondary', on: { click: (e) => linkMicrosoft(e.currentTarget) } }, 'Link Microsoft Account'), ' ', h('span', { class: 'helper' }, 'Optional: lets you sign in with Microsoft too.'));
        return null;
    };
    const googleList = () => [
        service('gmail', 'Gmail', 'Read-only: email messages and attachments (gmail.readonly).', () => startGmail()),
        service('gdrive', 'Google Drive', 'Read-only: Drive files; Docs and Sheets as text (drive.readonly).', () => startDrive())
    ];
    const msList = () => [
        service('outlook', 'Outlook Mail', 'Read-only: mail, except Deleted Items and Junk (Mail.Read). Personal and work accounts.', () => startMicrosoft('outlook')),
        service('onedrive', 'OneDrive', 'Read-only: files (Files.Read). Personal and work accounts.', () => startMicrosoft('onedrive')),
        service('sharepoint', 'SharePoint', 'Read-only: one site\u2019s document library (Sites.Read.All). Work or school accounts only; some organizations need administrator consent.', () => startMicrosoft('sharepoint'))
    ];
    const chooser = (title, build) => () => openDialog(title, h('div', null, h('p', null, 'Choose which services to connect. Each one opens the provider\u2019s own consent page, asks only for its read-only permission, and can be disconnected separately.'), h('ul', { class: 'plain-list welcome-list' }, ...build())), { wide: true });
    const card = (name, text, button, build, acct) => h('section', { class: 'card provider-card' }, h('div', { class: 'card-heading' }, h('h2', null, name)), h('p', null, text), acct, h('ul', { class: 'plain-list welcome-list' }, ...build()), can(status, 'sources.manage') ? h('button', { type: 'button', class: 'button primary', on: { click: chooser(button, build) } }, button) : null);
    replace(box, h('div', { class: 'provider-grid' }, card('Google', 'Connect your Google account to retrieve authorized Gmail messages and Google Drive documents.', 'Connect Google Account', googleList, account('google')), card('Microsoft', 'Connect your Microsoft account to retrieve authorized Outlook messages, OneDrive files and eligible SharePoint documents.', 'Connect Microsoft Account', msList, account('microsoft'))), h('p', { class: 'hint privacy-note' }, 'Your account credentials are never shared with this application. You control which permissions are granted and can disconnect access at any time.'));
}
/** What the source can do right now: sign-in accepted, permissions granted, API reachable. Reads no content. */
async function checkAccess(e, s) {
    let res;
    try {
        res = (await busy(e.currentTarget, 'Checking…', () => post(`/api/sources/${s.id}/verify`))).data;
    }
    catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not check access.', 'error');
        return;
    }
    openDialog(`Access check: ${s.name}`, h('div', null, h('ul', { class: 'plain-list' }, ...res.checks.map(c => h('li', null, h('span', { class: `pill ${c.ok ? 'ok' : 'bad'}` }, c.ok ? 'OK' : 'Problem'), ' ', h('b', null, c.label), h('p', { class: 'helper' }, c.detail)))), h('p', { class: 'hint' }, `Checked ${fmtDate(res.checkedAt, true)}. Nothing was read from the source; this check is in the audit log.`)), { wide: true });
    if (res.checks.some(c => !c.ok))
        loadSources();
}
async function decide(e, s, what) {
    if (what === 'reject' && !confirm(`Reject “${s.name}”? Its stored access and anything indexed from it are deleted.`))
        return;
    try {
        await busy(e.currentTarget, what === 'approve' ? 'Approving…' : 'Removing…', () => post(`/api/sources/${s.id}/${what}`));
        toast(what === 'approve' ? 'Approved. The first synchronization has started.' : 'Rejected and removed.');
        replace($('#flash'));
        loadSources();
        loadConnectors();
    }
    catch (err) {
        toast(err instanceof ApiError ? err.message : 'Could not save the decision.', 'error');
    }
}
/** This source's audit trail: connections, approvals, syncs, sharing changes. */
async function showActivity(s) {
    const res = await get(`/api/audit?targetId=${encodeURIComponent(s.id)}&pageSize=25`).catch(() => null);
    openDialog(`Activity: ${s.name}`, res?.data.length
        ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['When', 'Who', 'What', 'Outcome'].map(x => h('th', null, x)))), h('tbody', null, res.data.map(a => h('tr', null, h('td', null, fmtDate(a.at, true)), h('td', null, a.user?.name || 'System'), h('td', null, a.label), h('td', null, a.outcome)))))
        : empty('No activity yet', 'Connections, syncs and sharing changes appear here.'), { wide: true });
}
async function showJobs(s) {
    const res = await get(`/api/sources/${s.id}/jobs`).catch(() => null);
    openDialog(`Sync history: ${s.name}`, res?.data.length
        ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Started', 'Trigger', 'Result', 'Messages fetched', 'Added', 'Updated', 'Removed', 'Details'].map(x => h('th', null, x)))), h('tbody', null, res.data.map(j => h('tr', null, h('td', null, fmtDate(j.startedAt, true)), h('td', null, j.trigger), h('td', null, h('span', { class: `status-pill st-${j.status === 'succeeded' ? 'connected' : j.status === 'running' ? 'syncing' : 'needs_attention'}` }, j.status)), h('td', null, jobMessages(j)), h('td', null, j.added), h('td', null, j.updated), h('td', null, j.deleted), h('td', null, jobDetails(j))))))
        : empty('No synchronizations yet', 'Use Sync now to start one.'), { wide: true });
}
function editSharing(s) {
    const vis = h('select', { id: 'vis' }, h('option', { value: 'owner', selected: s.visibility === 'owner' }, 'Only the person who connected it'), h('option', { value: 'roles', selected: s.visibility === 'roles' }, 'People with the roles below'));
    const roles = roleChecks(s.allowedRoles);
    const save = h('button', { type: 'button', class: 'button primary' }, 'Save sharing');
    const dlg = openDialog(`Sharing: ${s.name}`, h('div', null, h('p', null, 'Sharing decides who can find this source’s records in searches. Changes apply immediately, including to existing result lists.'), field('Who can search it', vis), h('fieldset', { class: 'source-pick' }, h('legend', null, 'Roles (if shared by role)'), h('p', { class: 'hint' }, 'Leave all unticked to share with every role that can search.'), roles.el), h('div', { class: 'form-row' }, save)));
    save.addEventListener('click', async () => {
        try {
            await busy(save, 'Saving…', () => patch(`/api/sources/${s.id}`, { visibility: vis.value, allowedRoles: roles.value() }));
            toast('Sharing updated');
            dlg.close();
            loadSources();
        }
        catch (e) {
            toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
        }
    });
}
function disconnect(s) {
    const oauth = isOAuth(s.type);
    const yes = h('button', { type: 'button', class: 'button danger' }, oauth ? 'Disconnect and delete' : 'Remove and delete');
    const dlg = openDialog(oauth ? `Disconnect ${s.name}?` : `Remove ${s.name}?`, h('div', null, h('p', null, `This deletes all ${fmtNum(s.recordCount)} indexed records from this source, along with any stored credentials${s.type === 'uploads' ? ' and uploaded originals' : ''}.`), s.type === 'gmail' || s.type === 'gdrive' ? h('p', null, `Access is also revoked at Google. Nothing in the ${s.type === 'gmail' ? 'mailbox' : 'Drive'} itself is changed.`)
        : isMicrosoft(s.type) ? h('p', null, 'The stored Microsoft access is deleted. Nothing in the mailbox or OneDrive itself is changed. To remove the app from your Microsoft account too, use account.live.com/consent/Manage.') : null, h('p', null, 'Past search results will no longer show these records. The audit log keeps a record of the disconnection.'), h('div', { class: 'form-row' }, yes, h('button', { type: 'button', class: 'button secondary', on: { click: () => dlg.close() } }, 'Cancel'))));
    yes.addEventListener('click', async () => {
        try {
            const r = await busy(yes, 'Deleting…', () => del(`/api/sources/${s.id}`));
            toast(`Removed ${r.data.recordsDeleted} records${r.data.revokedAtProvider === false ? '. Google did not confirm the revocation; remove the app at myaccount.google.com/permissions.' : ''}`);
            dlg.close();
            loadSources();
        }
        catch (e) {
            toast(e instanceof ApiError ? e.message : 'Could not remove.', 'error');
        }
    });
}
/* ---------------- database wizard ---------------- */
function dbWizard(driver) {
    const inp = (id, attrs = {}) => h('input', { id, ...attrs });
    const name = inp('db-name', { value: driver === 'sqlite' ? 'Records database' : '' });
    const host = inp('db-host'), port = inp('db-port', { type: 'number', min: 1, max: 65535 }), database = inp('db-database'), user = inp('db-user'), password = inp('db-password', { type: 'password', autocomplete: 'new-password' });
    const file = inp('db-file', { placeholder: 'records.sqlite' });
    const ssl = inp('db-ssl', { type: 'checkbox' });
    const tenantCol = inp('db-tenant-col'), tenantVal = inp('db-tenant-val');
    const mapping = h('div', { id: 'db-mapping' });
    const share = sharingPicker();
    const test = h('button', { type: 'button', class: 'button secondary' }, 'Test connection and list tables');
    const save = h('button', { type: 'button', class: 'button primary', disabled: true }, 'Save and index');
    const out = h('div');
    let columns = [];
    const conn = () => ({ driver, ...(driver === 'sqlite' ? { file: file.value.trim() } : { host: host.value.trim(), port: port.value ? Number(port.value) : undefined, database: database.value.trim(), user: user.value.trim(), password: password.value || undefined, ssl: ssl.checked }) });
    const tableRows = [];
    const colSelect = (table, optional, multiple = false) => {
        const s = h('select', { multiple }, optional && !multiple ? h('option', { value: '' }, '(none)') : null, ...columns.filter(c => c.table === table).map(c => h('option', { value: c.column }, `${c.column} (${c.type})`)));
        return s;
    };
    const addTable = () => {
        const tables = [...new Set(columns.map(c => c.table))];
        const t = h('select', null, ...tables.map(x => h('option', { value: x }, x)));
        const row = h('fieldset', { class: 'table-map' }, h('legend', null, 'Table to index'));
        const build = () => {
            const r = { table: t, id: colSelect(t.value, false), title: colSelect(t.value, false), content: colSelect(t.value, false, true), date: colSelect(t.value, true), dept: colSelect(t.value, true), url: inp(`u-${Math.random()}`, { placeholder: 'https://system.example.gov/item/{id}' }) };
            replace(row, h('legend', null, 'Table to index'), field('Table', t), field('Unique ID column', r.id), field('Title column', r.title), field('Text columns to index', r.content, 'Hold Ctrl (or Cmd) to choose several. Only these columns are copied.'), field('Date column', r.date), field('Department column', r.dept), field('Link to the record (optional)', r.url, 'Use {id} where the record ID goes. Must start with https://'));
            const i = tableRows.findIndex(x => x.table === t);
            if (i >= 0)
                tableRows[i] = r;
            else
                tableRows.push(r);
        };
        t.addEventListener('change', build);
        build();
        mapping.append(row);
    };
    test.addEventListener('click', async () => {
        replace(out);
        try {
            columns = (await busy(test, 'Connecting…', () => post('/api/connectors/database/inspect', conn()))).data;
            if (!columns.length) {
                replace(out, alertBox('Connected, but no tables are visible to this user.', 'warn'));
                return;
            }
            replace(mapping);
            tableRows.length = 0;
            addTable();
            mapping.append(h('button', { type: 'button', class: 'text-link', on: { click: addTable } }, '+ Add another table'));
            save.disabled = false;
            replace(out, alertBox(`Connected read-only. ${new Set(columns.map(c => c.table)).size} tables found.`, 'ok'));
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not connect.'));
        }
    });
    save.addEventListener('click', async () => {
        const tables = tableRows.map(r => ({ name: r.table.value, idColumn: r.id.value, titleColumn: r.title.value, contentColumns: [...r.content.selectedOptions].map(o => o.value), dateColumn: r.date.value || undefined, departmentColumn: r.dept.value || undefined, urlTemplate: r.url.value.trim() || undefined }));
        try {
            await busy(save, 'Saving…', () => post('/api/sources/database', { name: name.value.trim(), ...conn(), tenantColumn: tenantCol.value.trim() || undefined, tenantValue: tenantVal.value.trim() || undefined, tables, ...share.value() }));
            toast('Database connected. Indexing has started.');
            dlg.close();
            loadSources();
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.'));
        }
    });
    const dlg = openDialog(`Connect ${driver === 'postgres' ? 'PostgreSQL' : driver === 'mysql' ? 'MySQL' : 'a SQLite file'}`, h('div', { class: 'db-wizard' }, h('p', null, 'The app only runs read-only SELECT statements it builds itself, on the tables and columns you choose here. Use a database account that has read access only.'), field('Name shown in the app', name), driver === 'sqlite' ? field('File name', file, 'The file must be in the server’s connector folder (data/connectors by default).')
        : h('div', { class: 'plan-grid' }, field('Host', host), field('Port', port), field('Database', database), field('User', user), field('Password', password, 'Stored encrypted.'), h('label', { class: 'inline-check' }, ssl, 'Require TLS')), h('details', null, h('summary', null, 'Shared database? Limit rows to one organization'), h('div', { class: 'plan-grid' }, field('Organization column', tenantCol), field('Value for this organization', tenantVal))), h('div', { class: 'form-row' }, test), out, mapping, share.el, h('div', { class: 'form-row' }, save)), { wide: true });
}
async function previewDb(s) {
    const table = h('select', null, ...s.repositories.map(r => h('option', { value: r.name }, r.name)));
    const kw = h('input', { placeholder: 'Keyword' });
    const since = h('input', { type: 'date' });
    const go = h('button', { type: 'button', class: 'button secondary' }, 'Preview');
    const out = h('div');
    go.addEventListener('click', async () => {
        try {
            const rows = (await busy(go, 'Querying…', () => post(`/api/sources/${s.id}/preview`, { table: table.value, keyword: kw.value.trim() || undefined, since: since.value || undefined }))).data;
            replace(out, rows.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['ID', 'Title', 'Date', 'Excerpt'].map(x => h('th', null, x)))), h('tbody', null, rows.map(r => h('tr', null, h('td', null, r.id), h('td', null, r.title), h('td', null, fmtDate(r.date)), h('td', null, r.excerpt))))) : empty('No rows', 'Nothing matches those filters.'));
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Preview failed.'));
        }
    });
    openDialog(`Preview: ${s.name}`, h('div', null, h('p', { class: 'helper' }, 'Runs a read-only query (at most 20 rows) on the allowlisted columns.'), h('div', { class: 'filter-bar' }, field('Table', table), field('Keyword', kw), field('Since', since), go), out), { wide: true });
}
main();
