import { ApiError, del, get, put, signOut } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, fmtNum, h, replace, SOURCE_LABEL, toast } from '../ui.js';
const next = (() => { const n = new URLSearchParams(location.search).get('next') || '/'; return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/consent') ? n : '/'; })();
async function main() {
    const status = await initShell({ title: 'Search permission' });
    const root = h('section', { class: 'card' });
    replace($('#root'), root);
    if (!status.user)
        return;
    if (!status.user.permissions.includes('search.run')) {
        location.replace(next);
        return;
    }
    let data;
    try {
        data = (await get('/api/consent')).data;
    }
    catch (e) {
        replace(root, alertBox(e instanceof ApiError ? e.message : 'Could not load.'));
        return;
    }
    const existing = data.consent;
    // Safe by default: “Only the sources I choose” is pre-selected; “Everything I can access” never is.
    const all = h('input', { type: 'radio', name: 'scope', value: 'all', checked: existing?.scope === 'all' });
    const some = h('input', { type: 'radio', name: 'scope', value: 'selected', checked: !existing || existing.scope === 'selected' });
    const stubs = (await get('/api/settings/workflow').then(r => r.data.pack.sources).catch(() => []));
    const chosen = new Set(existing?.sourceIds || []);
    const boxes = data.sources.map(s => h('input', { type: 'checkbox', value: s.id, checked: chosen.has(s.id) }));
    const list = h('div', { class: 'consent-sources' }, data.sources.length
        ? data.sources.map((s, i) => h('label', { class: 'consent-source' }, boxes[i], h('span', null, h('b', null, s.name), h('small', null, `${SOURCE_LABEL[s.type] || s.type} · ${fmtNum(s.records)} records · ${s.isOwn ? 'connected by you' : 'shared with you'}`))))
        : h('p', { class: 'helper' }, 'No sources are connected yet. If you choose this option, add sources here later from Settings.'), stubs.map(st => h('label', { class: 'consent-source is-off' }, h('input', { type: 'checkbox', disabled: true }), h('span', null, h('b', null, st.name), h('small', null, 'Not connected. Cannot be selected.')))));
    const syncList = () => { list.hidden = !some.checked; };
    all.addEventListener('change', syncList);
    some.addEventListener('change', syncList);
    syncList();
    const ack = h('input', { type: 'checkbox' });
    const allow = h('button', { type: 'button', class: 'button primary' }, existing ? 'Save permission' : 'Allow and continue');
    const out = h('div');
    replace(root, h('p', { class: 'label' }, existing ? 'Your search permission' : 'Before you search'), h('h1', null, existing ? 'What this app may search for you' : 'Allow this app to search records for you?'), h('p', { class: 'lead-text' }, `Signed in as ${status.user.name}. Searches only ever cover records your role is allowed to see. Here you decide whether the app may search all of them, or only the sources you choose.`), h('div', { class: 'consent-facts' }, h('div', null, h('b', null, 'What it reads'), h('p', null, 'The indexed copies of email, uploaded files, message imports and database rows from connected sources.')), h('div', null, h('b', null, 'What it never does'), h('p', null, 'Send, change or delete anything in your mailbox or databases, or read your phone. Phone messages only arrive as exports someone uploads.')), h('div', null, h('b', null, 'Who sees results'), h('p', null, 'Only you, plus anyone you share a search export with. Every search and opened record is written to the audit log.'))), h('fieldset', { class: 'consent-choice' }, h('legend', null, 'What may the app search?'), h('label', { class: 'consent-option' }, some, h('span', null, h('b', null, 'Only the sources I choose'), h('span', { class: 'pill ok' }, 'Recommended'), h('small', null, 'Nothing else is searched, even if more sources are connected later.'))), h('label', { class: 'consent-option' }, all, h('span', null, h('b', null, 'Everything I can access'), h('small', null, 'All current sources, and new ones as they are connected or shared with you.'))), list), h('label', { class: 'inline-check consent-ack' }, ack, 'I understand that my searches, opened records and exports are logged for auditing.'), out, h('div', { class: 'form-row' }, allow, existing ? h('button', { type: 'button', class: 'button danger', on: { click: withdraw } }, 'Withdraw permission')
        : h('button', { type: 'button', class: 'button secondary', on: { click: notNow } }, 'Not now (use the demo)')), h('p', { class: 'helper' }, 'Searches on real records stay blocked until you choose. The demo works without it. You can change or withdraw this in Settings. Every change is logged with the old value, the new value, who and when.'));
    allow.addEventListener('click', async () => {
        replace(out);
        if (!ack.checked) {
            replace(out, alertBox('Tick the box to confirm you understand that searches are logged.'));
            ack.focus();
            return;
        }
        const sourceIds = boxes.filter(b => b.checked).map(b => b.value);
        if (some.checked && data.sources.length && !sourceIds.length) {
            replace(out, alertBox('Choose at least one source, or pick “Everything I can access”.'));
            return;
        }
        try {
            await busy(allow, 'Saving…', () => put('/api/consent', { scope: some.checked ? 'selected' : 'all', sourceIds, acknowledged: true }));
            try {
                localStorage.setItem('prs-mode', 'real');
            }
            catch { /* ignore */ }
            toast('Permission saved');
            location.replace(next);
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.'));
        }
    });
    async function withdraw() {
        if (!confirm('Withdraw permission? Real-data searches will stop until you allow them again.'))
            return;
        try {
            await del('/api/consent');
            try {
                localStorage.setItem('prs-mode', 'demo');
            }
            catch { /* ignore */ }
            location.replace('/');
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not withdraw.'));
        }
    }
    function notNow() {
        try {
            localStorage.setItem('prs-mode', 'demo');
        }
        catch { /* ignore */ }
        location.replace('/');
    }
    void signOut;
}
main();
