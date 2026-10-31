// Screen 8: Report (the search record) and screen 16: export accessibility check.
// Generated only from stored data. Never says the search is complete or that results are responsive.
import { ApiError, get, post, put } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, download, empty, field, fmtDate, fmtNum, h, MARK_LABEL, openDialog, pill, replace, toast, tracker } from '../ui.js';
const root = $('#root');
const id = new URLSearchParams(location.search).get('id');
const printMode = new URLSearchParams(location.search).get('print') === '1';
let role = '';
async function main() {
    const status = await initShell({ title: 'Search record' });
    role = status.user.role;
    if (!id) {
        replace(root, empty('Choose a request', 'Open a request from Search History to see its search record.', h('a', { class: 'button primary link-button', href: '/history.html' }, 'Search History')));
        return;
    }
    await load();
    if (printMode)
        setTimeout(() => window.print(), 300);
}
async function load() {
    let d;
    try {
        d = (await get(`/api/requests/${encodeURIComponent(id)}/report${printMode ? '?print=1' : ''}`)).data;
    }
    catch (e) {
        replace(root, alertBox(e instanceof ApiError ? e.message : 'Could not load the search record.'));
        return;
    }
    const t = $('#page-title');
    if (t)
        t.textContent = `Search record ${d.ref}`;
    document.title = `Search record ${d.ref} | Public Records Search`;
    replace(root, tracker(5, id), h('div', { class: 'cols-main-side' }, body(d), side(d)));
}
const sec = (title, ...children) => h('section', { class: 'report-section' }, h('h2', null, title), ...children);
function body(d) {
    const p = d.plan?.plan;
    const c = d.request.clock;
    return h('article', { class: 'card', 'aria-label': `Search record ${d.ref}` }, h('p', { class: 'helper' }, `Generated ${fmtDate(d.generatedAt, true)} from stored data. ${d.tier}.`), sec('1. Request and clock', h('blockquote', { class: 'passage' }, d.request.text), h('dl', { class: 'meta-list' }, h('dt', null, 'Received'), h('dd', null, fmtDate(c.receivedAt)), h('dt', null, 'Response due'), h('dd', null, `${fmtDate(c.dueDate)} (${c.label})`), h('dt', null, 'Channel'), h('dd', null, d.request.channel || 'Not recorded'), h('dt', null, 'Logged by'), h('dd', null, `${d.request.createdBy}, ${fmtDate(d.request.createdAt, true)}`)), h('p', { class: 'hint' }, c.wording)), sec('2. Confirmed plan', d.plan && p ? h('div', null, h('p', null, `Version ${d.plan.version}, confirmed by ${d.plan.confirmedBy} on ${fmtDate(d.plan.confirmedAt, true)}. Drafted by ${d.plan.origin === 'claude' ? `AI (${d.plan.model})` : d.plan.origin === 'staff' ? 'staff' : 'local rules'}; edited and confirmed by staff.`), h('dl', { class: 'meta-list' }, h('dt', null, 'Terms'), h('dd', null, [...p.keywords, ...p.phrases, ...p.people, ...p.locations].join(', ') || 'None'), h('dt', null, 'Synonyms'), h('dd', null, p.alternateTerms.join(', ') || 'None'), h('dt', null, 'Dates'), h('dd', null, p.dateFrom || p.dateTo ? `${p.dateFrom || 'any'} to ${p.dateTo || 'any'}` : 'Any date'), h('dt', null, 'Departments'), h('dd', null, p.departments.join(', ') || 'Any'), h('dt', null, 'Record types'), h('dd', null, p.recordTypes.join(', ') || 'Any'), h('dt', null, 'Excluded'), h('dd', null, p.exclusions.join(', ') || 'None')), d.versions.length > 1 ? h('p', { class: 'hint' }, `Versions: ${d.versions.map(v => `v${v.version} ${v.status}${v.note ? ` (${v.note})` : ''}`).join('; ')}.`) : null, d.addedTerms.length ? h('p', { class: 'hint' }, `Terms from records marked relevant: ${d.addedTerms.map(t => `${t.term} (${t.decision}${t.plan_version ? `, v${t.plan_version}` : ''}; from ${t.source_record_ids.length} record${t.source_record_ids.length === 1 ? '' : 's'})`).join('; ')}.`) : null)
        : h('p', null, 'No plan has been confirmed.')), sec('3. Sources searched and NOT searched', d.coverage ? h('div', null, h('p', null, h('b', null, d.coverageWording)), h('ul', { class: 'plain-list' }, d.coverage.searched.map(s => h('li', null, pill(s.status === 'partial' ? 'warn' : 'ok', s.status === 'partial' ? 'Searched (partial)' : 'Searched', '✓'), ` ${s.name}: ${s.candidates} candidates${s.note ? `. ${s.note}` : ''}`))), h('ul', { class: 'plain-list' }, d.coverage.notSearched.map(s => h('li', null, pill('bad', 'NOT searched', '✕'), ` ${s.name}${s.reason ? `: ${s.reason}` : ''}`))))
        : h('p', null, 'The search has not been run.')), sec('4. Search log', d.log.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Plan'), h('th', null, 'Source'), h('th', null, 'Status'), h('th', null, 'Candidates'))), h('tbody', null, d.log.flatMap(l => l.sources.map((s, i) => h('tr', null, h('td', null, i ? '' : fmtDate(l.at, true)), h('td', null, i ? '' : l.by), h('td', null, i ? '' : l.kind), h('td', null, i ? '' : `v${l.planVersion}`), h('td', null, s.source_name), h('td', null, s.status === 'searched' ? 'Searched' : s.status === 'partial' ? 'Searched (partial)' : 'NOT searched'), h('td', { class: 'num' }, s.status === 'searched' || s.status === 'partial' ? String(s.candidates) : '')))))))
        : h('p', null, 'No searches yet.')), sec('5. Staff marks', h('p', null, `${d.review.marked} of ${d.review.total} candidates marked: relevant ${d.review.relevant}, not relevant ${d.review.not_relevant}, unsure ${d.review.unsure}. ${d.review.unmarked} not yet marked.`), d.marked.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Record'), h('th', null, 'Source'), h('th', null, 'Mark'), h('th', null, 'Who and when'), h('th', null, 'Note or route'))), h('tbody', null, d.marked.map(m => h('tr', null, h('td', null, m.title), h('td', null, m.source), h('td', null, m.mark ? MARK_LABEL[m.mark] : 'Not yet marked'), h('td', null, m.by ? `${m.by}, ${fmtDate(m.at, true)}` : ''), h('td', null, [m.note, m.routedTo ? `Routed to ${m.routedTo}` : ''].filter(Boolean).join('; '))))))) : null, d.custodians.length ? h('p', { class: 'hint' }, `Custodian checks: ${d.custodians.map(c => `${c.department} ${c.status === 'confirmed' ? `confirmed by ${c.confirmedBy} ${fmtDate(c.confirmedAt)}` : 'pending'}`).join('; ')}.`) : null), sec('6. Known gaps and limits', h('ul', { class: 'plain-list' }, d.knownGaps.map(g => h('li', null, g)))), sec('7. Reproducibility', d.reproducibility ? h('dl', { class: 'meta-list' }, h('dt', null, 'Model'), h('dd', null, d.reproducibility.model), h('dt', null, 'Prompt version'), h('dd', null, d.reproducibility.promptVersion), h('dt', null, 'Plan version'), h('dd', null, `v${d.reproducibility.planVersion}`), h('dt', null, 'Index time'), h('dd', null, d.reproducibility.indexTime ? fmtDate(d.reproducibility.indexTime, true) : 'Not recorded'), h('dt', null, 'Searched'), h('dd', null, fmtDate(d.reproducibility.searchedAt, true))) : h('p', null, 'Not searched yet.'), h('p', { class: 'hint' }, 'Only the request text and plan went to a model. Record content did not.')), sec('8. Approval (optional)', d.approval.required ? h('p', null, d.approval.approvedAt ? `Approved by ${d.approval.approvedBy} on ${fmtDate(d.approval.approvedAt, true)}.` : 'Second-person approval is on. Not yet approved.') : h('p', null, 'Second-person approval is not switched on.')), h('p', { class: 'banner info' }, d.handoffWording));
}
function side(d) {
    const handoff = h('button', { type: 'button', class: 'button primary block', disabled: Boolean(d.handoff.at) || role === 'auditor' }, d.handoff.at ? 'Handed to city process' : 'Mark handed to city process');
    const out = h('div');
    handoff.addEventListener('click', async () => {
        if (!confirm('Mark this search record as handed to the city process? This releases nothing.'))
            return;
        try {
            await busy(handoff, 'Saving…', () => post(`/api/requests/${id}/handoff`));
            toast('Marked handed off');
            load();
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not hand off.'));
        }
    });
    const approve = d.approval.required && !d.approval.approvedAt && role === 'admin' ? h('button', { type: 'button', class: 'button secondary block', on: { click: async (e) => {
                try {
                    await busy(e.currentTarget, 'Approving…', () => post(`/api/requests/${id}/approve`));
                    toast('Approved');
                    load();
                }
                catch (err) {
                    replace(out, alertBox(err instanceof ApiError ? err.message : 'Could not approve.'));
                }
            } } }, 'Approve as second person') : null;
    return h('div', { class: 'stack no-print' }, h('section', { class: 'card', 'aria-labelledby': 'chk-h' }, h('h2', { id: 'chk-h' }, 'Before handoff'), h('ul', { class: 'checklist' }, d.checklist.map(c => h('li', { class: c.level }, c.text))), h('p', { class: 'hint' }, 'Warnings do not block the handoff. Staff decide.')), h('section', { class: 'card' }, h('h2', null, 'Export'), h('div', { class: 'stack' }, h('button', { type: 'button', class: 'button secondary block', on: { click: () => { window.open(`/report.html?id=${id}&print=1`, '_blank', 'noopener'); } } }, 'Export PDF'), h('button', { type: 'button', class: 'button secondary block', on: { click: () => download(`/api/requests/${id}/export/log.csv`) } }, 'Export CSV log'), h('button', { type: 'button', class: 'button quiet block', on: { click: () => download(`/api/requests/${id}/export/candidates.csv`) } }, 'Export candidates CSV')), h('p', { class: 'hint' }, 'Export PDF opens the print view. Choose “Save as PDF”.')), exportChecks(d), h('section', { class: 'card' }, approve, handoff, out, d.handoff.at ? h('p', { class: 'hint' }, `Handed off by ${d.handoff.by} on ${fmtDate(d.handoff.at, true)}.`) : null, h('p', { class: 'hint' }, 'Handing off releases nothing. Exemptions, redaction and release stay in the city’s process.')));
}
const EXPORT_NAME = { report_pdf: 'Search record (PDF)', log_csv: 'Search log (CSV)', candidates_csv: 'Candidates (CSV)' };
const STATUS_WORDS = { scanned: ['Scanned with SureAccess', 'ok'], plain_table: ['Plain table with labeled headers', 'info'], scan_pending: ['Scan pending', 'warn'] };
function exportChecks(d) {
    return h('section', { class: 'card', 'aria-labelledby': 'acc-h' }, h('h2', { id: 'acc-h' }, 'Export accessibility check'), h('p', { class: 'banner info' }, 'A scan is a check, not a certification. Exports are WCAG 2.1 AA-aligned.'), h('ul', { class: 'plain-list' }, d.exportChecks.map(c => {
        const [words, kind] = STATUS_WORDS[c.status];
        return h('li', null, h('b', null, EXPORT_NAME[c.kind]), h('br'), pill(kind, words), c.status === 'scanned' ? ` ${c.reviewer}, ${fmtDate(c.reviewedOn)}` : '', role !== 'auditor' ? h('div', null, h('button', { type: 'button', class: 'text-link', on: { click: () => recordScan(c.kind) } }, 'Record a scan result')) : null);
    })), h('p', { class: 'hint' }, 'SureAccess scans are run by Vikram Kamble with SureAccess and recorded here by hand. There is no built-in SureAccess integration.'));
}
function recordScan(kind) {
    const status = h('select', { id: 'sc-status' }, h('option', { value: 'scanned' }, 'Scanned with SureAccess'), h('option', { value: 'scan_pending' }, 'Scan pending'), h('option', { value: 'plain_table' }, 'Plain table with labeled headers'));
    const reviewer = h('input', { id: 'sc-reviewer', value: 'Vikram Kamble (SureAccess)' });
    reviewer.value = 'Vikram Kamble (SureAccess)';
    const date = h('input', { id: 'sc-date', type: 'date' });
    const note = h('input', { id: 'sc-note' });
    const save = h('button', { type: 'button', class: 'button primary' }, 'Save');
    const out = h('div');
    const dlg = openDialog(`Record a check: ${EXPORT_NAME[kind]}`, h('div', null, field('Result', status), field('Reviewer', reviewer), field('Date of the scan', date), field('Note (optional)', note), out, h('div', { class: 'form-row' }, save)));
    save.addEventListener('click', async () => {
        try {
            await put(`/api/requests/${id}/export-checks/${kind}`, { status: status.value, reviewer: reviewer.value.trim() || undefined, reviewedOn: date.value || undefined, note: note.value.trim() || undefined });
            dlg.close();
            toast('Check recorded');
            load();
        }
        catch (e) {
            replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.'));
        }
    });
}
void fmtNum;
main();
