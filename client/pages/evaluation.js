// Screen 10: Evaluation (keyword vs hybrid on the labeled test set) and screen 13: replay closed requests.
// All figures come from runs on invented data. Targets are outcomes to be validated during discovery [est.].
import { ApiError, get, put } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, download, h, openDialog, pill, replace, toast } from '../ui.js';
const root = $('#root');
let userRole = '';
const pct = (x) => x === null ? 'n/a' : `${Math.round(x * 100)}%`;
async function main() {
    const st = await initShell({ title: 'Evaluation' });
    userRole = st.user.role;
    replace(root, h('div', { id: 'bench' }, h('p', { class: 'helper' }, 'Running the test set…')), h('div', { id: 'replay' }), h('div', { id: 'labels' }));
    bench();
    replay();
    if (st.user.permissions.includes('evaluate.write'))
        labels('', userRole === 'admin' ? 'adjudicator' : 'reviewer1');
}
function hbar(kind, value, max, text) {
    const i = h('i');
    i.style.width = `${Math.max(1, Math.round(100 * value / (max || 1)))}%`;
    return h('div', { class: `hbar ${kind}` }, h('span', { class: 'bar-track' }, i), h('span', null, text));
}
async function bench() {
    let b;
    try {
        b = (await get('/api/evaluation/benchmark')).data;
    }
    catch (e) {
        replace($('#bench'), alertBox(e instanceof ApiError ? e.message : 'Could not run the test set.'));
        return;
    }
    const rows = [
        ['Recall in top 10', b.keyword.recall10, b.hybrid.recall10, pct, 1], ['Recall in top 50', b.keyword.recall50, b.hybrid.recall50, pct, 1],
        ['Precision in top 10', b.keyword.precision10, b.hybrid.precision10, pct, 1],
        ['Rank of first relevant result (lower is better)', b.keyword.meanFirstRank, b.hybrid.meanFirstRank, (x) => x === null ? 'n/a' : x.toFixed(1), Math.max(b.keyword.meanFirstRank || 1, b.hybrid.meanFirstRank || 1)]
    ];
    replace($('#bench'), h('p', { class: 'banner sample', role: 'note' }, b.banner), h('div', { class: 'cols-main-side' }, h('section', { class: 'card', 'aria-labelledby': 'b-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'b-h' }, 'Keyword search versus hybrid search'), h('div', { class: 'legend' }, h('span', null, 'Keyword only'), h('span', { class: 'hy' }, 'Hybrid'))), h('div', { class: 'paired' }, rows.map(([label, kw, hy, fmt, max]) => h('div', { class: 'paired-row' }, h('b', null, label), h('div', { class: 'bars' }, hbar('kw', kw ?? 0, max, `Keyword only: ${fmt(kw)}`), hbar('hy', hy ?? 0, max, `Hybrid: ${fmt(hy)}`))))), h('p', { class: 'hint' }, `Median time per search on this server: keyword ${b.keyword.medianMs ?? 'n/a'} ms, hybrid ${b.hybrid.medianMs ?? 'n/a'} ms. Hybrid adds related wording from the city pack, matched locally.`)), h('section', { class: 'card', 'aria-labelledby': 't-h' }, h('h2', { id: 't-h' }, 'Test set'), h('p', null, `${b.requests} invented requests in ${Object.keys(b.kinds).length} kinds:`), h('ul', { class: 'plain-list' }, Object.entries(b.kinds).map(([k, n]) => h('li', null, `${k}: ${n}`))), h('p', { class: 'helper' }, `Labels: ${b.labels.adjudicated} settled by two reviewers, ${b.labels.provisional} still provisional.`), h('p', { class: 'hint' }, 'Targets are outcomes to be validated during discovery [est.]. These are not production results.'))));
}
async function replay() {
    let r;
    try {
        r = (await get('/api/evaluation/replay')).data;
    }
    catch {
        return;
    }
    replace($('#replay'), h('section', { class: 'card', 'aria-labelledby': 'r-h' }, h('div', { class: 'card-heading' }, h('h2', { id: 'r-h' }, 'Replay closed requests'), h('button', { type: 'button', class: 'button small secondary', on: { click: () => download('/api/evaluation/replay?format=csv') } }, 'Export CSV')), h('p', { class: 'banner sample', role: 'note' }, r.banner), h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Closed request (invented)'), h('th', null, 'Records released'), h('th', null, 'In top 50'), h('th', null, 'Recall'), h('th', null, 'Keyword only'), h('th', null, 'Missed'))), h('tbody', null, r.requests.map(q => h('tr', null, h('td', null, h('b', null, q.label), h('br'), h('small', { class: 'muted' }, q.labels === 'adjudicated' ? 'Settled labels' : 'Provisional labels')), h('td', { class: 'num' }, String(q.released)), h('td', { class: 'num' }, String(q.inTop50)), h('td', { class: 'num' }, pct(q.recall)), h('td', { class: 'num' }, pct(q.keywordRecall)), h('td', null, q.missed.length ? h('button', { type: 'button', class: 'text-link', on: { click: () => showMissed(q) } }, `${q.missed.length} missed`) : pill('ok', 'None missed'))))))), h('p', { class: 'hint' }, 'Missed records show the words they use, the plan terms they lacked, and a suggested term. This feeds tuning in pilot month 2.')));
}
function showMissed(q) {
    openDialog(`Missed records: ${q.label}`, h('div', { class: 'stack' }, h('p', { class: 'helper' }, q.request), ...q.missed.map(m => h('section', { class: 'card' }, h('h3', null, `${m.corpusId} ${m.title}`), h('dl', { class: 'meta-list' }, h('dt', null, 'Words it uses'), h('dd', null, m.uses.join(', ')), h('dt', null, 'Plan terms it lacked'), h('dd', null, m.lacked.join(', ') || 'None'), h('dt', null, 'Suggested term'), h('dd', null, m.suggested || 'None'))))), { wide: true });
}
async function labels(scenario, role) {
    let d;
    try {
        d = (await get(`/api/evaluation/labels?${new URLSearchParams({ scenario, role })}`)).data;
    }
    catch {
        return;
    }
    const sc = h('select', { id: 'l-sc' }, d.scenarios.map(s => h('option', { value: s.id, selected: s.id === d.scenario }, s.label)));
    const rl = h('select', { id: 'l-role' }, h('option', { value: 'reviewer1', selected: role === 'reviewer1' }, 'Reviewer 1'), h('option', { value: 'reviewer2', selected: role === 'reviewer2' }, 'Reviewer 2'), userRole === 'admin' ? h('option', { value: 'adjudicator', selected: role === 'adjudicator' }, 'Settle differences (Supervisor)') : null);
    sc.addEventListener('change', () => labels(sc.value, rl.value));
    rl.addEventListener('change', () => labels(sc.value, rl.value));
    const adj = d.role === 'adjudicator';
    replace($('#labels'), h('section', { class: 'card', 'aria-labelledby': 'l-h' }, h('h2', { id: 'l-h' }, 'Label review'), h('p', { class: 'helper' }, 'Two people label independently. Differences wait until a Supervisor settles them. Settled labels replace the provisional ones in the numbers above.'), h('div', { class: 'filter-bar' }, h('label', { for: 'l-sc' }, 'Test request'), sc, h('label', { for: 'l-role' }, 'Label as'), rl), h('p', { class: 'passage' }, d.scenarios.find(s => s.id === d.scenario)?.request || ''), h('p', null, `${d.labeled} of ${d.rows.length} records labeled in this view.${adj ? ` ${d.differences} differences.` : ''}`), h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Record (invented)'), h('th', null, adj ? 'Settled label' : 'Your label'), adj ? h('th', null, 'Reviewer 1 / 2') : null, h('th', null, adj ? 'Provisional label' : 'Reference'), h('th', null, 'Review status'))), h('tbody', null, d.rows.map(r => {
        const sel = h('select', { 'aria-label': `Label for ${r.title}` }, h('option', { value: '' }, 'Choose label'), ...[['relevant', 'Relevant'], ['not_relevant', 'Not relevant'], ['unsure', 'Unsure']].map(([v, l]) => h('option', { value: v, selected: r.mine === v }, l)));
        sel.addEventListener('change', async () => {
            if (!sel.value)
                return;
            try {
                await put('/api/evaluation/labels', { scenarioId: d.scenario, recordId: r.corpusId, role: d.role, label: sel.value });
                toast('Label saved');
                if (adj)
                    labels(d.scenario, d.role);
            }
            catch (e) {
                toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
            }
        });
        return h('tr', null, h('td', null, h('b', null, r.corpusId), ` ${r.title}`, h('br'), h('small', { class: 'muted' }, `${r.department} · ${r.type} · ${r.date}`)), h('td', null, sel), adj ? h('td', null, `${r.reviewer1 ?? '-'} / ${r.reviewer2 ?? '-'}`) : null, h('td', null, r.reference ?? 'Hidden during reviewer entry'), h('td', null, r.status === 'Difference' ? pill('warn', 'Difference') : r.status === 'Agreement' ? pill('ok', 'Agreement') : r.status));
    }))))));
}
main();
