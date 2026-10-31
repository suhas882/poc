// Screen 3: Search Results and review. Screen 12: Expand from what you found.
// The score is a ranking aid. Nothing here labels a result "responsive", and there are no exemption or release actions.
import { ApiError, get, post, put } from '../api.js';
import { initShell } from '../shell.js';
import { $, $$, alertBox, busy, download, empty, fmtDate, fmtNum, h, highlighted, MARK_LABEL, openDialog, pill, replace, toast, tracker } from '../ui.js';

interface Item { rank: number; relevance: number; band: string; arguable: boolean; matchType: string; why: string; snippet: string; exactTerms: string[]; alternateTerms: string[];
  groupKey: string | null; groupSize: number; foundInVersion: number | null; fromAddedTerms?: boolean;
  mark: { mark: string; note: string | null; by: string; at: string } | null; route: { to: string; by: string; at: string } | null;
  record: { id: string; title: string; sourceName: string; createdAt: string | null; department: string | null; documentType: string | null; provenance: { kind: string; url?: string; retrievedAt?: string } | null } }
interface Coverage { searched: { name: string; status: string; candidates: number; note: string | null }[]; notSearched: { name: string; status: string; reason: string | null }[]; at: string; planVersion: number }
interface Review { total: number; marked: number; unmarked: number; relevant: number; not_relevant: number; unsure: number }
interface Chip { kind: string; value?: string; from?: string; to?: string; label: string }

const root = $('#root')!;
const id = new URLSearchParams(location.search).get('id');
let canMark = false, canExport = false;
const show = new Set(['none', 'relevant', 'unsure', 'not_relevant']);
let includeArguable = true;
let chips: Chip[] = [];
let items: Item[] = [];

async function main() {
  const status = await initShell({ title: 'Search Results' });
  canMark = status.user!.permissions.includes('evaluate.write');
  canExport = status.user!.permissions.includes('export.create');
  if (!id) return pickRequest();
  try {
    const req = (await get<{ ref: string; text: string; lastRunAt: string | null; stage: { step: number } }>(`/api/requests/${encodeURIComponent(id)}`)).data;
    const t = $('#page-title'); if (t) t.textContent = `Results for ${req.ref}`;
    document.title = `Results for ${req.ref} | Public Records Search`;
    if (!req.lastRunAt) { replace(root, tracker(3, id), empty('Not searched yet', 'Confirm the plan to run the search.', h('a', { class: 'button primary link-button', href: `/?id=${id}` }, 'Open the plan'))); return; }
    layout(req.ref);
    await load();
  } catch (e) { replace(root, alertBox(e instanceof ApiError ? e.message : 'Could not load results.')); }
}

async function pickRequest() {
  const list = (await get<{ id: string; ref: string; text: string; stage: { label: string }; lastRunAt: string | null }[]>('/api/requests?pageSize=50').catch(() => ({ data: [] }))).data.filter(r => r.lastRunAt);
  replace(root, h('section', { class: 'card' }, h('h2', null, 'Choose a request'),
    list.length ? h('ul', { class: 'plain-list' }, list.map(r => h('li', null, h('a', { href: `/search.html?id=${r.id}` }, r.ref), ` · ${r.stage.label} · ${r.text.slice(0, 120)}`)))
      : empty('No searched requests yet', 'Start on Request & Plan.', h('a', { class: 'button primary link-button', href: '/' }, 'New request'))));
}

function layout(ref: string) {
  const filterInput = h('input', { type: 'search', id: 'nl-filter', placeholder: 'Filter in plain words, for example: emails from Transportation in April', 'aria-label': 'Filter results in plain words' }) as HTMLInputElement;
  const form = h('form', { role: 'search' }, h('span', { 'aria-hidden': 'true' }, '✦'), filterInput, h('button', { type: 'submit', class: 'button small secondary' }, 'Apply'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!filterInput.value.trim()) return;
    try {
      const r = (await post<{ chips: Chip[]; understood: boolean }>('/api/filters/parse', { text: filterInput.value, requestId: id })).data;
      if (!r.understood) { toast('No filter words recognized. Try a record type, department, month or mark.', 'error'); return; }
      for (const c of r.chips) { chips = chips.filter(x => x.kind !== c.kind); chips.push(c); }
      filterInput.value = '';
      await load();
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Could not read the filter.', 'error'); }
  });
  const showBox = h('fieldset', null, h('legend', null, 'Show'),
    ...([['none', 'Not yet marked'], ['relevant', 'Relevant'], ['unsure', 'Unsure'], ['not_relevant', 'Not relevant']] as const).map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', checked: show.has(k) }) as HTMLInputElement;
      cb.addEventListener('change', () => { if (cb.checked) show.add(k); else show.delete(k); load(); });
      return h('label', { class: 'inline-check' }, cb, label);
    }),
    (() => { const cb = h('input', { type: 'checkbox', checked: includeArguable }) as HTMLInputElement; cb.addEventListener('change', () => { includeArguable = cb.checked; load(); }); return h('label', { class: 'inline-check' }, cb, 'Include “arguably responsive”'); })());
  replace(root, tracker(4, id!),
    h('div', { id: 'not-searched' }),
    h('div', { class: 'cols-side' },
      h('div', { class: 'stack' },
        h('section', { class: 'card', id: 'coverage', 'aria-labelledby': 'cov-h' }, h('h2', { id: 'cov-h' }, 'Coverage')),
        h('section', { class: 'card', id: 'review', 'aria-labelledby': 'rev-h' }, h('h2', { id: 'rev-h' }, 'Your review')),
        h('section', { class: 'card' }, showBox),
        h('a', { class: 'button primary block link-button', href: `/report.html?id=${id}` }, 'Go to report ▶'),
        h('button', { type: 'button', class: 'button secondary block', on: { click: expand } }, 'Expand from what you found'),
        canExport ? h('button', { type: 'button', class: 'button quiet block', on: { click: () => download(`/api/requests/${id}/export/candidates.csv`) } }, 'Export candidates (CSV)') : null,
        h('p', { class: 'hint' }, 'Keys: focus a result, then press R relevant, N not relevant, U unsure.')),
      h('div', { class: 'stack' },
        h('div', { class: 'filter-bar' }, form, h('div', { class: 'chips', id: 'filter-chips', 'aria-live': 'polite' })),
        h('p', { class: 'showing', id: 'showing', 'aria-live': 'polite' }),
        h('div', { class: 'stack', id: 'results', 'aria-label': `Candidates for ${ref}` }))));
}

function query() {
  const q = new URLSearchParams({ pageSize: '200' });
  if (show.size < 4) q.set('marks', [...show].join(',') || 'nothing');
  if (!includeArguable) q.set('arguable', '0');
  for (const c of chips) {
    if (c.kind === 'type') q.set('type', c.value!);
    if (c.kind === 'department') q.set('department', c.value!);
    if (c.kind === 'source') q.set('source', c.value!);
    if (c.kind === 'date') { q.set('from', c.from!); q.set('to', c.to!); }
    if (c.kind === 'mark') q.set('mark', c.value!);
  }
  return q.toString();
}

async function load() {
  const res = await get<Item[]>(`/api/requests/${id}/results?${query()}`);
  const meta = res.meta as unknown as { total: number; all: number; review: Review; coverage: Coverage };
  items = res.data;
  drawCoverage(meta.coverage);
  drawReview(meta.review);
  replace($('#filter-chips')!, ...chips.map((c, i) => h('span', { class: 'chip' }, c.label, h('button', { type: 'button', 'aria-label': `Remove filter ${c.label}`, on: { click: () => { chips.splice(i, 1); load(); } } }, '×'))),
    chips.length ? h('button', { type: 'button', class: 'text-link', on: { click: () => { chips = []; load(); } } }, 'Clear filters') : null);
  const grouped = items.filter(x => x.groupKey && items.find(y => y.groupKey === x.groupKey) !== x).length;
  $('#showing')!.textContent = `Showing ${fmtNum(meta.total)} of ${fmtNum(meta.all)} candidates${grouped ? `, with ${grouped} related items grouped under their thread or duplicate` : ''}. Nothing is hidden silently: clear filters to see all.`;
  drawResults();
}

function drawCoverage(c: Coverage) {
  const box = $('#coverage')!;
  const searched = c.searched.length, not = c.notSearched.length;
  const pct = searched + not ? Math.round(100 * searched / (searched + not)) : 0;
  const bar = h('div', { class: 'coverage-bar', role: 'img', 'aria-label': `${searched} sources searched, ${not} NOT searched` }, h('i'));
  (bar.firstChild as HTMLElement).style.width = `${pct}%`;
  const total = c.searched.reduce((a, x) => a + x.candidates, 0);
  replace(box, h('h2', { id: 'cov-h' }, 'Coverage'), bar,
    h('p', null, pill('ok', 'Searched', '✓'), ` ${fmtNum(total)} found`),
    h('ul', { class: 'plain-list' }, c.searched.map(x => h('li', null, `${x.name}: ${x.candidates}`, x.status === 'partial' ? h('span', null, ' ', pill('warn', 'Partial'), h('br'), h('small', { class: 'muted' }, x.note || '')) : null))),
    not ? h('p', null, pill('bad', 'NOT searched', '✕')) : null,
    not ? h('ul', { class: 'plain-list' }, c.notSearched.map(x => h('li', null, `${x.name}${x.status === 'failed' ? `: failed. ${x.reason || ''}` : ''}`))) : null,
    h('p', { class: 'hint' }, `Plan version ${c.planVersion}, searched ${fmtDate(c.at, true)}.`));
  const ns = $('#not-searched')!;
  replace(ns, not ? h('div', { class: 'banner warn', role: 'status' }, h('span', { 'aria-hidden': 'true' }, '⚠'),
    h('span', null, `NOT searched: ${c.notSearched.map(x => `${x.name} (${x.status === 'failed' ? 'failed' : 'not connected'})`).join(', ')}. Results cover only the sources searched.`)) : null);
}

function drawReview(r: Review) {
  const prog = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(r.total), 'aria-valuenow': String(r.marked), 'aria-label': 'Review progress' }, h('i'));
  (prog.firstChild as HTMLElement).style.width = `${r.total ? Math.round(100 * r.marked / r.total) : 0}%`;
  replace($('#review')!, h('h2', { id: 'rev-h' }, 'Your review'), h('p', null, h('b', { class: 'big' }, String(r.marked)), ` of ${r.total} marked`), prog,
    h('p', { class: 'helper' }, `Relevant ${r.relevant} · Not relevant ${r.not_relevant} · Unsure ${r.unsure}`));
}

function scoreClass(n: number, arguable: boolean) { return arguable ? 'low' : n >= 70 ? '' : 'mid'; }

function card(it: Item, nested = false): HTMLElement {
  const r = it.record;
  const cls = scoreClass(it.relevance, it.arguable);
  const bar = h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { class: cls }));
  (bar.firstChild as HTMLElement).style.width = `${it.relevance}%`;
  const status = h('span', { class: `mark-status${it.mark ? ' marked' : ''}`, 'aria-live': 'polite' },
    it.mark ? `✓ Marked ${MARK_LABEL[it.mark.mark].toLowerCase()} by ${it.mark.by} · ${fmtDate(it.mark.at, true)}` : 'Not yet marked');
  const markBtn = (m: string, key: string) => h('button', { type: 'button', class: 'button small', 'aria-pressed': String(it.mark?.mark === m), 'aria-keyshortcuts': key, disabled: !canMark,
    on: { click: () => setMark(it, m) } }, MARK_LABEL[m], h('kbd', { 'aria-hidden': 'true' }, key));
  const art = h('article', { class: 'result', tabindex: '0', dataset: { recordId: r.id }, 'aria-labelledby': `t-${r.id}` },
    h('div', { class: 'score-col' }, h('b', { class: cls }, String(it.relevance)), h('small', null, 'match'), bar),
    h('div', null,
      h('h3', { id: `t-${r.id}` }, h('a', { href: `#`, on: { click: (e: Event) => { e.preventDefault(); openRecord(r.id); } } }, r.title),
        it.arguable ? pill('warn', 'Arguably responsive') : null, it.fromAddedTerms ? pill('info', `Found with added terms, v${it.foundInVersion}`) : null,
        r.provenance?.kind === 'synthetic' ? pill('gray', 'Synthetic') : r.provenance?.kind === 'public' ? pill('teal', 'Public document') : null),
      h('p', { class: 'meta' }, [r.sourceName, r.createdAt ? fmtDate(r.createdAt) : 'No date', r.department, r.documentType].filter(Boolean).join(' · ')),
      h('p', { class: 'why' }, h('b', null, 'Why it matched: '), it.why),
      h('blockquote', { class: 'passage' }, highlighted(it.snippet, [...it.exactTerms, ...it.alternateTerms])),
      h('div', { class: 'mark-row' }, markBtn('relevant', 'R'), markBtn('not_relevant', 'N'), markBtn('unsure', 'U'),
        h('button', { type: 'button', class: 'button small route', disabled: !canMark, on: { click: () => route(it) } }, it.route ? `Routed to ${it.route.to.split(',')[0]}` : 'Route'),
        h('button', { type: 'button', class: 'text-link', disabled: !canMark, on: { click: () => note(it) } }, it.mark?.note ? 'Edit note' : 'Add note'),
        status),
      it.mark?.note ? h('p', { class: 'hint' }, `Note: ${it.mark.note}`) : null));
  if (!nested && it.groupKey) {
    const members = items.filter(x => x.groupKey === it.groupKey && x !== it);
    if (members.length) {
      const kind = it.groupKey.startsWith('thread') ? 'in this thread' : 'that look like duplicates';
      art.appendChild(h('details', { class: 'group-list' }, h('summary', null, `${members.length} more ${members.length === 1 ? 'item' : 'items'} ${kind}`), h('div', { class: 'stack' }, members.map(m => card(m, true)))));
    }
  }
  return art;
}

function drawResults() {
  const box = $('#results')!;
  const leaders = items.filter(x => !x.groupKey || items.find(y => y.groupKey === x.groupKey) === x);
  replace(box, leaders.length ? leaders.map(x => card(x)) : empty('No candidates match these filters', 'Clear the filters or change what is shown.'));
}

async function setMark(it: Item, mark: string, noteText?: string) {
  try {
    const r = (await put<{ mark: Item['mark']; review: Review }>(`/api/requests/${id}/marks/${it.record.id}`, { mark, note: noteText ?? it.mark?.note ?? undefined })).data;
    it.mark = r.mark;
    drawReview(r.review);
    const focused = document.activeElement?.closest('.result') as HTMLElement | null;
    const fid = focused?.dataset.recordId;
    drawResults();
    if (fid) ($(`.result[data-record-id="${fid}"]`) as HTMLElement | null)?.focus();
    toast(`Marked ${MARK_LABEL[mark].toLowerCase()}`);
  } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the mark.', 'error'); }
}

function note(it: Item) {
  const ta = h('textarea', { id: 'note-text', rows: 4, maxlength: 1000 }) as HTMLTextAreaElement; ta.value = it.mark?.note || '';
  const mark = h('select', { id: 'note-mark' }, Object.entries(MARK_LABEL).map(([k, v]) => h('option', { value: k, selected: (it.mark?.mark || 'unsure') === k }, v))) as HTMLSelectElement;
  const save = h('button', { type: 'button', class: 'button primary' }, 'Save mark and note');
  const dlg = openDialog(`Note: ${it.record.title}`, h('div', null, h('div', { class: 'field' }, h('label', { for: 'note-mark' }, 'Mark'), mark), h('div', { class: 'field' }, h('label', { for: 'note-text' }, 'Note (optional)'), ta), h('div', { class: 'form-row' }, save)));
  save.addEventListener('click', async () => { await setMark(it, mark.value, ta.value.trim()); dlg.close(); });
}

async function route(it: Item) {
  const people = (await get<string[]>(`/api/requests/${id}/coordinators`).catch(() => ({ data: [] as string[] }))).data;
  const sel = h('select', { id: 'route-to' }, people.map(p => h('option', { value: p, selected: it.route?.to === p }, p))) as HTMLSelectElement;
  const ta = h('textarea', { id: 'route-note', rows: 3, maxlength: 500 }) as HTMLTextAreaElement;
  const save = h('button', { type: 'button', class: 'button primary' }, 'Route item');
  const dlg = openDialog('Route to a Records Coordinator', h('div', null,
    h('p', { class: 'helper' }, 'Routing records who should look at this item. The tool does not send anything to anyone.'),
    h('div', { class: 'field' }, h('label', { for: 'route-to' }, 'Route to'), sel), h('div', { class: 'field' }, h('label', { for: 'route-note' }, 'Note (optional)'), ta), h('div', { class: 'form-row' }, save)));
  save.addEventListener('click', async () => {
    try { await put(`/api/requests/${id}/routes/${it.record.id}`, { to: sel.value, note: ta.value.trim() || undefined }); dlg.close(); toast('Routed'); load(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not route.', 'error'); }
  });
}

async function openRecord(recordId: string) {
  try {
    const r = (await get<{ title: string; content: string; sourceName: string; createdAt: string; department: string; documentType: string; sourceUrl: string | null; entities: { provenance?: { url: string; retrievedAt: string } } }>(`/api/records/${recordId}`)).data;
    const prov = r.entities?.provenance;
    openDialog(r.title, h('div', null, h('p', { class: 'meta' }, [r.sourceName, r.createdAt ? fmtDate(r.createdAt) : '', r.department, r.documentType].filter(Boolean).join(' · ')),
      prov ? h('p', { class: 'hint' }, 'Public document from ', h('a', { href: prov.url, rel: 'noopener noreferrer', target: '_blank' }, prov.url), `, retrieved ${prov.retrievedAt}.`) : null,
      h('div', { class: 'passage' }, r.content), h('p', { class: 'hint' }, 'Opening a record is written to the audit log. Record text is treated as data, never as instructions.')), { wide: true });
  } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open the record.', 'error'); }
}

/* ---- keyboard: R / N / U on the focused result ---- */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target as HTMLElement).tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.querySelector('dialog[open]')) return;
  const art = (e.target as HTMLElement).closest('.result') as HTMLElement | null;
  if (!art || !canMark) return;
  const mark = { r: 'relevant', n: 'not_relevant', u: 'unsure' }[e.key.toLowerCase()];
  if (!mark) return;
  const it = items.find(x => x.record.id === art.dataset.recordId);
  if (it) { e.preventDefault(); setMark(it, mark); }
});

/* ---------------- screen 12: expand from what you found ---------------- */

interface Suggestion { term: string; kind: string; count: number; recordIds: string[]; example: { id: string; title: string } | null; decision: string | null }

async function expand() {
  const body = h('div', null, h('p', { class: 'helper' }, 'Looking at records marked relevant…'));
  const dlg = openDialog('Expand from what you found', body, { wide: true, onClose: () => load() });
  const draw = async () => {
    let d: { relevantCount: number; suggestions: Suggestion[] };
    try { d = (await get<typeof d>(`/api/requests/${id}/expansion`)).data; } catch (e) { replace(body, alertBox(e instanceof ApiError ? e.message : 'Could not load suggestions.')); return; }
    if (!d.relevantCount) { replace(body, empty('Mark some results relevant first', 'Suggestions come from the records you marked relevant.')); return; }
    const choice = new Map<string, 'approve' | 'reject'>();
    const rows = d.suggestions.map(sg => {
      const name = `sg-${sg.term.replace(/\W+/g, '-')}`;
      const radios = (['approve', 'reject'] as const).map(v => { const r = h('input', { type: 'radio', name, value: v, disabled: Boolean(sg.decision) }) as HTMLInputElement; r.addEventListener('change', () => choice.set(sg.term, v)); return h('label', { class: 'inline-check' }, r, v === 'approve' ? 'Approve' : 'Reject'); });
      return h('tr', null, h('td', null, h('b', null, sg.term)), h('td', null, sg.kind), h('td', { class: 'num' }, String(sg.count)), h('td', null, sg.example?.title || ''),
        h('td', null, sg.decision ? pill(sg.decision === 'approved' ? 'ok' : 'gray', sg.decision === 'approved' ? 'Approved' : 'Rejected') : h('div', { class: 'chips' }, radios)));
    });
    const apply = h('button', { type: 'button', class: 'button primary' }, 'Save decisions');
    const research = h('button', { type: 'button', class: 'button secondary' }, 'Re-search with approved terms');
    const out = h('div');
    apply.addEventListener('click', async () => {
      const approve = [...choice].filter(([, v]) => v === 'approve').map(([t]) => t), reject = [...choice].filter(([, v]) => v === 'reject').map(([t]) => t);
      if (!approve.length && !reject.length) { replace(out, alertBox('Choose Approve or Reject for at least one term.', 'warn')); return; }
      try {
        const r = (await busy(apply, 'Saving…', () => post<{ version: number; changed: boolean }>(`/api/requests/${id}/expansion`, { approve, reject }))).data;
        toast(r.changed ? `Plan version ${r.version} created with the approved terms.` : 'Decisions saved. The plan is unchanged.');
        draw();
      } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.')); }
    });
    research.addEventListener('click', async () => {
      try {
        const req = (await get<{ current: { version: number; status: string } }>(`/api/requests/${id}`)).data;
        const r = (await busy(research, 'Searching…', () => post<{ added: number }>(`/api/requests/${id}/run`, { version: req.current.version, addedTermsOnly: true }))).data;
        toast(`${r.added} new candidates added to the review list.`);
        dlg.close();
      } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not search.')); }
    });
    replace(body,
      h('div', { class: 'banner info', role: 'note' }, h('span', null, `Terms found inside the ${d.relevantCount} records you marked relevant. Extracted on this server: record text is never sent to a model. Nothing is added without your approval.`)),
      d.suggestions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('thead', null, h('tr', null, h('th', null, 'Term'), h('th', null, 'Kind'), h('th', null, 'Relevant records with it'), h('th', null, 'Example record'), h('th', null, 'Decision'))),
        h('tbody', null, rows))) : empty('No new terms found', 'The records marked relevant use the words already in the plan.'),
      out, h('div', { class: 'form-row' }, apply, research),
      h('p', { class: 'hint' }, 'Approving creates the next plan version and logs each term with the record it came from. Re-search runs only the added terms and adds new candidates to the end of the list.'));
  };
  draw();
}

void $$; void fmtNum;
main();
