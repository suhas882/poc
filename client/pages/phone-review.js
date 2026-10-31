// Screen 5: Phone Link texts, employee review (experimental). Shown only when the Phone Link switch is on.
// The employee reviews their own matches before anything reaches a clerk. Only City business items are sent.
import { ApiError, get, post, put } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, empty, fmtDate, h, highlighted, pill, replace, toast } from '../ui.js';
const root = $('#root');
const DEC = [['city', 'City business'], ['personal', 'Personal'], ['unsure', 'Unsure']];
async function main() {
    await initShell({ title: 'Phone Link texts: your review' });
    load();
}
async function load() {
    let d;
    try {
        d = (await get('/api/phone-review')).data;
    }
    catch (e) {
        replace(root, alertBox(e instanceof ApiError ? e.message : 'Phone Link review is not available.'));
        return;
    }
    replace(root, h('div', { class: 'banner warn', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', null, d.banner)), h('section', { class: 'card' }, h('h2', null, 'Limits ', pill('warn', 'Experimental')), h('ul', { class: 'plain-list' }, d.limits.map(l => h('li', null, l)))), d.requests.length ? d.requests.map(q => requestCard(q)) : empty('No matches to review', d.sources.length ? 'No confirmed request includes your phone source yet.' : 'Connect Android texts (Phone Link) on Connected Sources first.'));
}
function requestCard(q) {
    const attest = h('input', { type: 'checkbox' });
    const pending = q.items.filter(i => !i.sentAt);
    const cityCount = pending.filter(i => i.decision === 'city').length;
    const send = h('button', { type: 'button', class: 'button primary', disabled: true, 'aria-describedby': `why-${q.requestId}` }, `Send ${cityCount} City business item${cityCount === 1 ? '' : 's'} to the clerk`);
    const why = h('span', { class: 'disabled-reason', id: `why-${q.requestId}` }, 'Tick the attestation first.');
    attest.addEventListener('change', () => { send.disabled = !attest.checked || !cityCount; why.hidden = attest.checked; });
    send.addEventListener('click', async () => {
        try {
            const r = await busy(send, 'Sending…', () => post(`/api/phone-review/${q.requestId}/send`, { attested: true }));
            toast(`${r.data.sent} items sent to the clerk.`);
            load();
        }
        catch (e) {
            toast(e instanceof ApiError ? e.message : 'Could not send.', 'error');
        }
    });
    return h('section', { class: 'card', 'aria-labelledby': `pr-${q.requestId}` }, h('h2', { id: `pr-${q.requestId}` }, `${q.ref}: your matches`), h('p', { class: 'helper' }, q.request), h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Text'), h('th', null, 'Matched'), h('th', null, 'Your choice'))), h('tbody', null, q.items.map(it => {
        const prev = it.personalLooking
            ? h('details', null, h('summary', null, 'Preview hidden: looks personal. Open to read.'), h('p', null, highlighted(it.preview, it.matched)))
            : h('p', null, highlighted(it.preview, it.matched));
        const name = `d-${q.requestId}-${it.recordId}`;
        const choices = h('fieldset', null, h('legend', { class: 'visually-hidden' }, `Decision for ${it.title}`), h('div', { class: 'chips' }, DEC.map(([v, l]) => {
            const r = h('input', { type: 'radio', name, value: v, checked: it.decision === v, disabled: Boolean(it.sentAt) });
            r.addEventListener('change', async () => { try {
                await put(`/api/phone-review/${q.requestId}/${it.recordId}`, { decision: v });
                load();
            }
            catch (e) {
                toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
            } });
            return h('label', { class: 'inline-check' }, r, l);
        })));
        return h('tr', null, h('td', null, h('b', null, it.title), h('br'), h('small', { class: 'muted' }, it.date ? fmtDate(it.date) : ''), prev), h('td', null, it.matched.join(', ')), h('td', null, it.sentAt ? pill('ok', `Sent ${fmtDate(it.sentAt)}`) : choices));
    })))), h('label', { class: 'inline-check consent-ack' }, attest, 'I attest that the items I marked City business relate to city business, and that I reviewed every match.'), h('div', { class: 'form-row' }, send, why), h('p', { class: 'hint' }, `Only City business items reach the clerk. Personal and Unsure items stay with you. ${q.sent} sent so far. Every choice is logged.`));
}
main();
