import { ApiError, can, get, post, put } from '../api.js';
import { currentMode, initShell } from '../shell.js';
import { $, alertBox, busy, empty, fmtDate, fmtMs, h, highlighted, openDialog, pager, replace, SOURCE_LABEL, toast } from '../ui.js';
const MATCH_LABEL = { exact: 'Exact match', alternate: 'Related wording', semantic: 'Similar meaning' };
const BAND_LABEL = { strong: 'Strong', possible: 'Possible', weak: 'Weak' };
const JUDGMENTS = [['relevant', 'Relevant'], ['unsure', 'Unsure'], ['not_relevant', 'Not relevant']];
let status;
let search;
const state = { page: 1, sort: 'rank', sourceType: '', matchType: '', band: '', judgment: '', group: false };
const titles = new Map();
async function main() {
    status = await initShell();
    if (currentMode() !== 'real' || !status.user)
        return;
    const id = new URLSearchParams(location.search).get('search');
    if (!id) {
        const latest = await get('/api/searches?pageSize=1').catch(() => null);
        if (latest?.data[0]) {
            location.replace(`/search.html?search=${encodeURIComponent(latest.data[0].id)}`);
            return;
        }
        replace($('#r-list'), empty('No searches yet', 'Plan and run a search first. Its results will appear here.', h('a', { class: 'button primary link-button', href: '/' }, 'Plan a search')));
        return;
    }
    try {
        search = (await get(`/api/searches/${encodeURIComponent(id)}`)).data;
    }
    catch (e) {
        replace($('#r-list'), alertBox(e instanceof ApiError ? e.message : 'The search could not be loaded.'));
        return;
    }
    renderHeader();
    renderSummary();
    await load();
}
function renderHeader() {
    $('#r-request').textContent = `“${search.requestText}”`;
    const p = search.plan || {};
    const chip = (k, v) => h('span', { class: 'chip' }, h('small', null, k), v);
    replace($('#r-plan'), h('span', { class: `mode-chip mode-${search.mode}` }, search.mode === 'demo' ? 'Synthetic records' : 'Real records'), ...(p.keywords || []).map((t) => chip('Term', t)), ...(p.phrases || []).map((t) => chip('Phrase', t)), ...(p.alternateTerms || []).slice(0, 6).map((t) => chip('Alt', t)), p.dateFrom || p.dateTo ? chip('Dates', `${p.dateFrom || '…'} to ${p.dateTo || '…'}`) : null, ...(p.exclusions || []).map((t) => chip('Exclude', t)), h('span', { class: 'chip' }, h('small', null, 'Plan'), search.planOrigin === 'claude' ? `Claude (${search.planModel})` : 'Local rules'), search.isOwn ? h('a', { class: 'chip chip-link', href: `/?request=${encodeURIComponent(search.requestText)}` }, 'Search again with a new plan') : null);
}
function renderSummary() {
    const card = $('#summary-card');
    card.hidden = false;
    const body = $('#summary-body');
    if (!search.aiConfigured) {
        replace(body, h('p', { class: 'helper' }, 'Claude is not configured on this server, so evidence summaries are unavailable. An administrator can set ANTHROPIC_API_KEY (see Settings).'));
        return;
    }
    if (!search.summary) {
        const btn = h('button', { type: 'button', class: 'button secondary' }, 'Summarize the top results with Claude');
        btn.addEventListener('click', async () => {
            try {
                const res = await busy(btn, 'Summarizing…', () => post(`/api/searches/${search.id}/summary`));
                search.summary = res.data;
                renderSummary();
                await load();
            }
            catch (e) {
                replace(body, btn, alertBox(e instanceof ApiError ? e.message : 'The summary failed.'));
            }
        });
        replace(body, h('p', { class: 'helper' }, 'Claude reads excerpts of the top results you can access and writes a short summary. Every statement must cite a record; citations that can’t be found in the record are removed automatically.'), btn);
        return;
    }
    const s = search.summary;
    $('#summary-meta').textContent = `CLAUDE · ${s.model}`;
    replace(body, h('p', { class: 'summary-overview' }, s.overview), s.findings.length ? h('ol', { class: 'findings' }, s.findings.map(f => h('li', null, f.statement, ' ', ...f.citations.map(c => h('button', { type: 'button', class: 'cite', title: `“${c.quote}”`, on: { click: () => preview(c.recordId) } }, `[${titles.get(c.recordId) || 'source'}]`))))) : h('p', { class: 'helper' }, 'No statement could be backed by a citation.'), s.missingEvidence.length ? h('div', { class: 'summary-block' }, h('b', null, 'Not covered by these records'), h('ul', null, s.missingEvidence.map(m => h('li', null, m)))) : null, s.uncertainty ? h('div', { class: 'summary-block' }, h('b', null, 'Check before relying on this'), h('p', null, s.uncertainty)) : null, h('p', { class: 'metric-caveat' }, `Checked against ${s.verification.checkedRecords} record excerpts. ${s.verification.removedCitations} unverifiable citation(s) and ${s.verification.removedFindings} unsupported statement(s) were removed. Summaries can be wrong; open the cited records before relying on them.`));
}
async function load() {
    const list = $('#r-list');
    replace(list, h('p', { class: 'loading' }, 'Loading results…'));
    const q = new URLSearchParams({ page: String(state.page), pageSize: '20' });
    if (state.sort !== 'rank')
        q.set('sort', state.sort);
    for (const k of ['sourceType', 'matchType', 'band', 'judgment'])
        if (state[k])
            q.set(k, state[k]);
    if (state.group)
        q.set('group', '1');
    let res;
    try {
        res = await get(`/api/searches/${search.id}/results?${q}`);
    }
    catch (e) {
        replace(list, alertBox(e instanceof ApiError ? e.message : 'Results could not be loaded.'));
        return;
    }
    const meta = res.meta;
    $('#r-count').textContent = `${meta.total} RESULTS${search.durationMs != null ? ` · ${fmtMs(search.durationMs)}` : ''} · SEMANTIC ${search.semanticSearch ? 'ON' : 'OFF'}`;
    renderFilters(meta.facets);
    for (const r of res.data)
        titles.set(r.record.id, r.record.title);
    if (!res.data.length) {
        replace(list, search.sourcesAvailable === 0
            ? empty('No sources to search', 'You have no connected sources yet, or none are shared with your role.', h('a', { class: 'button primary link-button', href: '/sources.html' }, 'Connect a source'))
            : empty('No records match', 'Try broader keywords, more alternative terms, a wider date range, or fewer filters.', h('a', { class: 'button secondary link-button', href: `/?request=${encodeURIComponent(search.requestText)}` }, 'Revise the plan')));
    }
    else {
        replace(list, ...res.data.map(card));
    }
    replace($('#r-pager'), pager(res.meta, (p) => { state.page = p; load(); window.scrollTo({ top: 0 }); }));
}
function renderFilters(facets) {
    const sel = (key, label, options) => {
        const s = h('select', { 'aria-label': label, on: { change: (e) => { state[key] = e.target.value; state.page = 1; load(); } } }, ...options.map(([v, t]) => h('option', { value: v, selected: state[key] === v }, t)));
        return h('label', { class: 'filter' }, h('span', null, label), s);
    };
    const facet = (k, labels = {}) => (facets?.[k] || []).map(f => [f.value, `${labels[f.value] || f.value} (${f.n})`]);
    const groupBox = h('input', { type: 'checkbox', checked: state.group, on: { change: (e) => { state.group = e.target.checked; state.page = 1; load(); } } });
    replace($('#r-filters'), sel('sourceType', 'Source', [['', 'All sources'], ...facet('sourceType', SOURCE_LABEL)]), sel('matchType', 'Match', [['', 'All matches'], ...facet('matchType', MATCH_LABEL)]), sel('band', 'Strength', [['', 'All strengths'], ...facet('band', BAND_LABEL)]), sel('judgment', 'Decision', [['', 'Any decision'], ['none', 'Not reviewed'], ['relevant', 'Relevant'], ['not_relevant', 'Not relevant'], ['unsure', 'Unsure']]), sel('sort', 'Sort', [['rank', 'Relevance'], ['newest', 'Newest first'], ['oldest', 'Oldest first'], ['title', 'Title A–Z']]), h('label', { class: 'inline-check filter-check' }, groupBox, 'Group duplicates and threads'), can(status, 'export.create') ? h('span', { class: 'export-links' }, h('a', { class: 'button secondary link-button', href: `/api/searches/${search.id}/export?format=csv`, download: '' }, 'Export CSV'), h('a', { class: 'button secondary link-button', href: `/api/searches/${search.id}/export?format=json`, download: '' }, 'Export JSON')) : null);
}
function card(r) {
    const rec = r.record;
    const terms = [...r.exactTerms, ...r.alternateTerms];
    const decisionGroup = h('div', { class: 'review-actions', role: 'group', 'aria-label': `Your decision on ${rec.title}` }, h('span', null, 'Your decision'), ...JUDGMENTS.map(([v, label]) => h('button', { type: 'button', class: 'mark', dataset: { value: v.replace('_', ' ') }, 'aria-pressed': String(r.judgment === v), on: { click: () => judge(r, v, articleEl) } }, label)), h('button', { type: 'button', class: 'text-link', on: { click: () => editNote(r, articleEl) } }, r.note ? 'Edit note' : 'Add note'));
    const source = rec.sourceUrl
        ? rec.sourceUrl.startsWith('/api/')
            ? h('a', { href: rec.sourceUrl, class: 'text-link' }, 'Download original')
            : h('a', { href: rec.sourceUrl, target: '_blank', rel: 'noopener noreferrer', class: 'text-link' }, 'Open in source ↗')
        : null;
    const articleEl = h('article', { class: 'result rcard', dataset: { mark: r.judgment || 'none' }, 'aria-labelledby': `t-${rec.id}` }, h('div', { class: 'result-top' }, h('div', { class: 'result-titleline' }, h('span', { class: 'result-rank' }, String(r.rank).padStart(2, '0')), h('div', null, h('h3', { id: `t-${rec.id}` }, rec.title), h('div', { class: 'meta-row' }, h('span', { class: `src-badge src-${rec.sourceType}` }, SOURCE_LABEL[rec.sourceType] || rec.sourceType), h('span', null, rec.sourceName), h('span', null, fmtDate(rec.createdAt)), rec.department ? h('span', null, rec.department) : null, rec.documentType ? h('span', null, rec.documentType) : null, rec.isSynthetic ? h('span', { class: 'synthetic-tag' }, 'Synthetic') : null))), h('div', { class: 'score-box' }, h('span', { class: 'score', dataset: { strength: r.band } }, `${BAND_LABEL[r.band]} · ${r.relevance}`), h('span', { class: 'meter', 'aria-hidden': 'true' }, h('span', { class: 'meter-fill' })), h('span', { class: `match-badge match-${r.matchType}` }, MATCH_LABEL[r.matchType]))), h('blockquote', { class: 'passage' }, highlighted(r.snippet, terms)), terms.length ? h('div', { class: 'chip-row' }, ...r.exactTerms.map(t => h('span', { class: 'chip chip-exact' }, t)), ...r.alternateTerms.map(t => h('span', { class: 'chip chip-alt' }, t))) : null, h('details', { class: 'why' }, h('summary', null, 'Why this record matched'), h('ul', null, r.reasons.map(x => h('li', null, x)))), r.aiAssessment ? h('p', { class: 'ai-assessment' }, h('b', null, `Claude’s view: ${r.aiAssessment.relevance} relevance. `), r.aiAssessment.reason) : null, r.groupSize > 1 ? h('p', { class: 'group-note' }, `${r.groupSize - (state.group ? 0 : 1)} related record(s) in the same thread or near-duplicate group${state.group ? ' are hidden; turn off grouping to see them' : ''}.`) : null, rec.duplicateOf ? h('p', { class: 'group-note' }, 'This is an exact copy of another indexed record.') : null, h('div', { class: 'card-actions' }, h('button', { type: 'button', class: 'button secondary', on: { click: () => preview(rec.id) } }, 'Preview record'), source), can(status, 'evaluate.write') ? decisionGroup : null, r.note ? h('p', { class: 'saved-note' }, h('b', null, 'Note: '), r.note) : null);
    // The CSP forbids style attributes, but CSSOM changes are allowed.
    const fill = articleEl.querySelector('.meter-fill');
    if (fill)
        fill.style.width = `${r.relevance}%`;
    return articleEl;
}
async function judge(r, judgment, el, note = r.note) {
    try {
        await put(`/api/searches/${search.id}/evaluations/${r.record.id}`, { judgment, note: note || undefined });
        r.judgment = judgment;
        r.note = note;
        el.replaceWith(card(r));
        toast(`Saved: ${JUDGMENTS.find(j => j[0] === judgment)?.[1]}`);
    }
    catch (e) {
        toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
    }
}
function editNote(r, el) {
    const area = h('textarea', { rows: 4, maxlength: 1000 }, r.note || '');
    area.value = r.note || '';
    const save = h('button', { type: 'button', class: 'button primary' }, 'Save note');
    const dlg = openDialog(`Note on “${r.record.title}”`, h('div', null, h('label', { for: 'note-area' }, 'Visible to anyone who can open this search.'), Object.assign(area, { id: 'note-area' }), h('div', { class: 'form-row' }, save)));
    save.addEventListener('click', async () => { await judge(r, r.judgment || 'unsure', el, area.value.trim()); dlg.close(); });
}
async function preview(recordId) {
    try {
        const { data: rec } = await get(`/api/records/${encodeURIComponent(recordId)}`);
        const terms = [...(search.plan?.keywords || []), ...(search.plan?.phrases || []), ...(search.plan?.alternateTerms || [])];
        openDialog(rec.title, h('div', { class: 'preview' }, h('dl', { class: 'meta-list' }, h('dt', null, 'Source'), h('dd', null, `${SOURCE_LABEL[rec.sourceType] || rec.sourceType} · ${rec.sourceName}`), h('dt', null, 'Date'), h('dd', null, fmtDate(rec.createdAt, true)), rec.sender ? [h('dt', null, 'From'), h('dd', null, rec.sender)] : null, rec.recipients?.length ? [h('dt', null, 'To'), h('dd', null, rec.recipients.join(', '))] : null, rec.department ? [h('dt', null, 'Department'), h('dd', null, rec.department)] : null, rec.documentType ? [h('dt', null, 'Type'), h('dd', null, rec.documentType)] : null, h('dt', null, 'Source record ID'), h('dd', null, h('code', null, rec.sourceRecordId)), h('dt', null, 'Indexed'), h('dd', null, fmtDate(rec.ingestedAt, true)), h('dt', null, 'Checksum'), h('dd', null, h('code', null, rec.checksum.slice(0, 16) + '…'))), rec.isSynthetic ? alertBox('Synthetic demo record. It does not describe a real event.', 'warn') : null, rec.parent ? h('p', null, 'Attachment of: ', h('button', { type: 'button', class: 'text-link', on: { click: () => preview(rec.parent.id) } }, rec.parent.title)) : null, h('div', { class: 'preview-content' }, highlighted(rec.content || '(No text could be extracted from this record.)', terms)), rec.related?.length ? h('div', null, h('h3', null, 'Same thread or conversation'), h('ul', null, rec.related.map(x => h('li', null, h('button', { type: 'button', class: 'text-link', on: { click: () => preview(x.id) } }, x.title), ` · ${fmtDate(x.createdAt)}`)))) : null, rec.sourceUrl ? h('p', null, rec.sourceUrl.startsWith('/api/') ? h('a', { href: rec.sourceUrl, class: 'button secondary link-button' }, 'Download original file') : h('a', { href: rec.sourceUrl, target: '_blank', rel: 'noopener noreferrer', class: 'button secondary link-button' }, 'Open in the original system ↗')) : null), { wide: true });
    }
    catch (e) {
        toast(e instanceof ApiError ? e.message : 'The record could not be opened.', 'error');
    }
}
main();
