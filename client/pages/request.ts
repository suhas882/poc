// Screen 1: Request & Plan. Intake, deadline clock, AI-drafted plan the clerk edits, sources, confirm and lock.
// Also opens screen 11 (preview counts and source map) and screen 15 (clarification drafts).
import { ApiError, get, patch, post, put } from '../api.js';
import { currentMode, initShell } from '../shell.js';
import { $, alertBox, busy, deadlineRing, empty, field, fmtDate, fmtNum, h, openDialog, pill, replace, toast, tracker } from '../ui.js';

interface Plan { summary: string; keywords: string[]; alternateTerms: string[]; phrases: string[]; people: string[]; organizations: string[]; locations: string[];
  dateFrom: string | null; dateTo: string | null; departments: string[]; recordTypes: string[]; exclusions: string[]; clarifyingQuestions: string[]; notes: string[];
  filterDepartments: boolean; filterRecordTypes: boolean; sourceIds?: string[] }
interface Version { id: string; version: number; status: 'draft' | 'confirmed'; plan: Plan; sourceIds: string[]; origin: string; model: string | null; promptVersion: string | null; note: string | null; createdBy: string | null; createdAt: string; confirmedBy: string | null; confirmedAt: string | null }
interface Choice { id: string; name: string; type: string; connected: boolean; records: number | null; note?: string; experimental?: boolean }
interface Req { id: string; ref: string; mode: string; text: string; channel: string | null; requesterLabel: string | null; createdBy: string; createdAt: string;
  clock: { receivedAt: string; dueDate: string; daysLeft: number; label: string; wording: string; options: string }; stage: { key: string; label: string; step: number };
  current: Version; confirmed: Version | null; versions: Version[]; choices: { sources: Choice[]; stubs: Choice[] }; lastRunAt: string | null; handedOffAt: string | null;
  review: { total: number; marked: number }; pack: { departments: string[]; recordTypes: string[]; threshold: number; wording: Record<string, string> } }

const root = $('#root')!;
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let canSearch = false;

async function main() {
  const status = await initShell({ title: 'Request & Plan' });
  canSearch = status.user!.permissions.includes('search.run');
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return renderNew();
  try { render((await get<Req>(`/api/requests/${encodeURIComponent(id)}`)).data); }
  catch (e) { replace(root, alertBox(e instanceof ApiError ? e.message : 'Could not load the request.')); }
}

/* ---------------- new request ---------------- */

async function renderNew() {
  const text = h('textarea', { id: 'req-text', rows: 6, placeholder: 'Paste the request exactly as received.' }) as HTMLTextAreaElement;
  const received = h('input', { type: 'date', id: 'req-received', value: today(), max: today() }) as HTMLInputElement;
  received.value = today();
  const channel = h('select', { id: 'req-channel' }, ['Portal ticket', 'Email', 'Phone', 'In person', 'Mail'].map(c => h('option', null, c))) as HTMLSelectElement;
  const requester = h('input', { id: 'req-requester', placeholder: 'For example: Requester 114 (no personal details needed)' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'button primary' }, 'Draft search plan');
  const out = h('div');
  const samples = h('div');
  replace(root, tracker(1),
    h('div', { class: 'cols-2' },
      h('section', { class: 'card', 'aria-labelledby': 'new-h' }, h('h2', { id: 'new-h' }, '1. The request'),
        field('Request text', text, 'Only this text and the plan go to the AI model. Record content never does.'),
        h('div', { class: 'field-grid' }, field('Received', received, 'The day of receipt does not count toward the deadline.'), field('Channel', channel)),
        field('Requester label (optional)', requester),
        out, h('div', { class: 'form-row' }, go, canSearch ? null : h('span', { class: 'disabled-reason' }, 'Your role cannot start requests.'))),
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h2', null, 'How this works'),
          h('ol', { class: 'guide-steps' },
            h('li', null, 'The AI drafts a search plan from the request text. You edit it.'),
            h('li', null, 'You choose the sources and confirm. The plan is locked and versioned.'),
            h('li', null, 'The tool searches read-only, ranks candidates, and says why each matched.'),
            h('li', null, 'Staff mark each candidate. The search record goes to the city’s existing process.')),
          h('p', { class: 'helper' }, 'The tool never decides responsiveness, exemptions, redaction or release.')),
        samples)));
  go.disabled = !canSearch;
  go.addEventListener('click', async () => {
    replace(out);
    if (text.value.trim().length < 5) { replace(out, alertBox('Enter the request text.')); text.focus(); return; }
    try {
      const res = await busy(go, 'Drafting plan…', () => post<Req>('/api/requests', { text: text.value.trim(), receivedAt: received.value || today(), channel: channel.value, requesterLabel: requester.value.trim(), mode: currentMode() }));
      history.replaceState(null, '', `/?id=${res.data.id}`);
      render(res.data);
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not draft the plan.')); }
  });
  if (currentMode() === 'demo') {
    try {
      const list = (await get<{ id: string; label: string; request: string; type: string }[]>('/api/samples')).data;
      replace(samples, h('section', { class: 'card' }, h('h2', null, 'Invented sample requests'),
        h('p', { class: 'helper' }, 'All sample requests are invented for the demo. Pick one to fill the request box.'),
        h('div', { class: 'chips' }, list.slice(0, 9).map(sc => h('button', { type: 'button', class: 'button small quiet', on: { click: () => { text.value = sc.request; text.focus(); } } }, sc.label)))));
    } catch { /* optional */ }
  }
  text.focus();
}

/* ---------------- existing request ---------------- */

function render(req: Req) {
  const t = $('#page-title'); if (t) t.textContent = `Request ${req.ref}`;
  document.title = `Request ${req.ref} | Public Records Search`;
  const cur = req.current;
  const locked = cur.status === 'confirmed';
  const step = locked ? (req.lastRunAt ? 4 : 3) : 2;
  replace(root, tracker(step, req.id),
    req.mode === 'demo' ? null : h('p', { class: 'helper' }, 'Real sources. Only sources you allowed and can access are listed.'),
    h('div', { class: 'cols-2' },
      h('div', { class: 'stack' }, requestCard(req), clockCard(req), vagueCard(req)),
      h('div', { class: 'stack' }, locked ? lockedPlan(req) : planEditor(req), versionsCard(req))));
}

function requestCard(req: Req) {
  const received = h('input', { type: 'date', value: req.clock.receivedAt, max: today(), 'aria-describedby': 'recv-hint' }) as HTMLInputElement;
  received.value = req.clock.receivedAt;
  received.addEventListener('change', async () => {
    try { render((await patch<Req>(`/api/requests/${req.id}`, { receivedAt: received.value })).data); toast('Received date updated. The due date moved with it.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not update.', 'error'); }
  });
  return h('section', { class: 'card', 'aria-labelledby': 'rq-h' }, h('h2', { id: 'rq-h' }, '1. The request'),
    h('blockquote', { class: 'passage' }, req.text),
    h('div', { class: 'facts' },
      h('div', null, h('label', { class: 'label', for: 'recv' }, 'Received'), Object.assign(received, { id: 'recv', disabled: !canSearch || Boolean(req.handedOffAt) }), h('p', { class: 'hint', id: 'recv-hint' }, 'Changing it recalculates the due date.')),
      h('div', null, h('span', { class: 'label' }, 'Channel'), h('p', null, req.channel || 'Not recorded')),
      h('div', null, h('span', { class: 'label' }, 'Logged by'), h('p', null, `${req.createdBy}, ${fmtDate(req.createdAt, true)}`)),
      h('div', null, h('span', { class: 'label' }, 'Status'), h('p', null, req.stage.label))));
}

function clockCard(req: Req) {
  const c = req.clock;
  return h('section', { class: 'card ring-card', 'aria-label': 'Response deadline' }, deadlineRing(c.daysLeft),
    h('div', null,
      h('b', null, c.daysLeft < 0 ? c.label : c.daysLeft === 0 ? 'Due today' : `business day${c.daysLeft === 1 ? '' : 's'} left`),
      h('p', { class: 'helper' }, `Response due ${fmtDate(c.dueDate)}. ${c.wording}`),
      h('p', { class: 'hint' }, `Options within the deadline: ${c.options}`)));
}

function vagueCard(req: Req) {
  const btn = h('button', { type: 'button', class: 'button secondary', disabled: !canSearch, on: { click: () => clarify(req) } }, 'Draft clarification questions');
  const qs = req.current.plan.clarifyingQuestions || [];
  return h('section', { class: 'card' }, h('h2', null, 'Vague request?'),
    h('p', { class: 'helper' }, 'Draft questions for the requester. You edit. The tool never sends.'),
    qs.length ? h('div', { class: 'alert alert-warn' }, h('p', null, 'The plan draft says this request may be broad:'), h('ul', { class: 'plain-list' }, qs.map(q => h('li', null, q)))) : null,
    h('div', { class: 'form-row' }, btn));
}

/* ---- chip editor ---- */
function chipList(label: string, values: string[], onChange: (v: string[]) => void, opts: { alt?: boolean; options?: string[]; id: string; addLabel?: string }) {
  const wrap = h('div', { class: 'chips', role: 'group', 'aria-label': label });
  const list = [...values];
  const input = h('input', { type: 'text', id: opts.id, 'aria-label': `Add to ${label}`, placeholder: opts.addLabel || 'Add term', list: opts.options ? `${opts.id}-list` : undefined }) as HTMLInputElement;
  const draw = () => {
    replace(wrap, ...list.map((v, i) => h('span', { class: `chip${opts.alt ? ' alt' : ''}` }, v,
      h('button', { type: 'button', 'aria-label': `Remove ${v}`, on: { click: () => { list.splice(i, 1); onChange([...list]); draw(); input.focus(); } } }, '×'))),
    h('span', { class: 'chip-add' }, input, h('button', { type: 'button', on: { click: add } }, '+ Add')),
    opts.options ? h('datalist', { id: `${opts.id}-list` }, opts.options.map(o => h('option', { value: o }))) : null);
  };
  function add() {
    for (const v of input.value.split(/[,;]+/).map(x => x.trim()).filter(Boolean)) if (!list.some(x => x.toLowerCase() === v.toLowerCase())) list.push(v);
    input.value = ''; onChange([...list]); draw(); input.focus();
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw();
  return h('div', { class: 'field' }, h('span', { class: 'label' }, label), wrap);
}

function planEditor(req: Req) {
  const v = req.current;
  const plan: Plan = JSON.parse(JSON.stringify(v.plan));
  const chosen = new Set(v.sourceIds);
  const from = h('input', { type: 'date', id: 'p-from', value: plan.dateFrom || '' }) as HTMLInputElement;
  const to = h('input', { type: 'date', id: 'p-to', value: plan.dateTo || '' }) as HTMLInputElement;
  from.value = plan.dateFrom || ''; to.value = plan.dateTo || '';
  const strictDept = h('input', { type: 'checkbox', checked: plan.filterDepartments }) as HTMLInputElement;
  const strictType = h('input', { type: 'checkbox', checked: plan.filterRecordTypes }) as HTMLInputElement;
  const reviewed = h('input', { type: 'checkbox', id: 'reviewed' }) as HTMLInputElement;
  const confirmBtn = h('button', { type: 'button', class: 'button primary', disabled: true, 'aria-describedby': 'confirm-why' }, 'Confirm plan and search ▶');
  const why = h('span', { class: 'disabled-reason', id: 'confirm-why' }, 'Tick the review box to confirm.');
  const out = h('div');
  const collect = () => ({ ...plan, dateFrom: from.value || null, dateTo: to.value || null, filterDepartments: strictDept.checked, filterRecordTypes: strictType.checked });
  const save = () => put<Req>(`/api/requests/${req.id}/plan`, { plan: collect(), sourceIds: [...chosen] });
  reviewed.addEventListener('change', () => { confirmBtn.disabled = !reviewed.checked || !canSearch; why.hidden = reviewed.checked; });

  const toggles = h('div', { class: 'toggle-cards' },
    ...req.choices.sources.map(sc => {
      const sw = h('input', { type: 'checkbox', class: 'switch', checked: chosen.has(sc.id), 'aria-describedby': `src-${sc.id}` }) as HTMLInputElement;
      sw.addEventListener('change', () => { if (sw.checked) chosen.add(sc.id); else chosen.delete(sc.id); });
      return h('label', { class: 'toggle-card' }, sw, h('span', null, h('b', null, sc.name), h('small', { id: `src-${sc.id}` }, `Connected · ${fmtNum(sc.records ?? 0)} records${sc.experimental ? ' · Experimental' : ''}`)));
    }),
    ...req.choices.stubs.map(sc => h('div', { class: 'toggle-card off', title: sc.note || '' }, h('input', { type: 'checkbox', class: 'switch', disabled: true, 'aria-label': `${sc.name}: not connected` }), h('span', null, h('b', null, sc.name), h('small', null, 'Not connected')))));

  confirmBtn.addEventListener('click', async () => {
    replace(out);
    if (!chosen.size) { replace(out, alertBox('Switch on at least one connected source.')); return; }
    try {
      await busy(confirmBtn, 'Confirming…', async () => {
        const saved = (await save()).data;
        await post(`/api/requests/${req.id}/plan/confirm`, { version: saved.current.version, reviewed: true });
        await post(`/api/requests/${req.id}/run`, { version: saved.current.version });
      });
      location.href = `/search.html?id=${encodeURIComponent(req.id)}`;
    } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not confirm the plan.')); }
  });
  const saveBtn = h('button', { type: 'button', class: 'button secondary', disabled: !canSearch }, 'Save draft');
  saveBtn.addEventListener('click', async () => { try { const r = await busy(saveBtn, 'Saving…', save); toast('Draft saved'); render(r.data); } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.')); } });
  const previewBtn = h('button', { type: 'button', class: 'button secondary', disabled: !canSearch }, 'Preview counts');
  previewBtn.addEventListener('click', async () => { try { await busy(previewBtn, 'Counting…', save); preview(req.id); } catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not save.')); } });

  return h('section', { class: 'card', 'aria-labelledby': 'plan-h' },
    h('div', { class: 'card-heading' }, h('h2', { id: 'plan-h' }, '2. Search plan', v.origin === 'claude' ? pill('info', 'Draft by AI. You decide.') : pill('info', 'Drafted by local rules. You decide.')),
      h('span', { class: 'micro' }, `Version ${v.version} (draft)`)),
    v.note ? h('p', { class: 'hint' }, v.note) : null,
    chipList('Terms', plan.keywords, (x) => { plan.keywords = x; }, { id: 'c-terms' }),
    chipList('Synonyms and related wording', plan.alternateTerms, (x) => { plan.alternateTerms = x; }, { id: 'c-alt', alt: true, addLabel: 'Add synonym' }),
    chipList('Names, places and exact phrases', [...plan.phrases, ...plan.people, ...plan.locations, ...plan.organizations],
      (x) => { plan.phrases = x; plan.people = []; plan.locations = []; plan.organizations = []; }, { id: 'c-names', addLabel: 'Add name or phrase' }),
    h('div', { class: 'field-grid' },
      h('fieldset', null, h('legend', null, 'Date range'), h('div', { class: 'date-range' }, h('label', { class: 'visually-hidden', for: 'p-from' }, 'From'), from, h('span', { 'aria-hidden': 'true' }, 'to'), h('label', { class: 'visually-hidden', for: 'p-to' }, 'To'), to)),
      h('div', null, chipList('Record types', plan.recordTypes, (x) => { plan.recordTypes = x; }, { id: 'c-types', options: req.pack.recordTypes, addLabel: 'Add type' }),
        h('label', { class: 'inline-check' }, strictType, 'Only these record types'))),
    h('div', { class: 'field-grid' },
      h('div', null, chipList('Likely departments', plan.departments, (x) => { plan.departments = x; }, { id: 'c-depts', options: req.pack.departments, addLabel: 'Add department' }),
        h('label', { class: 'inline-check' }, strictDept, 'Only these departments')),
      chipList('Exclude terms', plan.exclusions, (x) => { plan.exclusions = x; }, { id: 'c-excl', addLabel: 'Add exclusion' })),
    h('fieldset', null, h('legend', null, 'Where to search'), toggles),
    h('div', { class: 'banner warn', role: 'note' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', null, 'Nothing is searched until you confirm this plan. Unconnected sources will be listed as NOT searched.')),
    h('label', { class: 'inline-check consent-ack' }, reviewed, 'I reviewed this plan and I am ready to search the sources above.'),
    out,
    h('div', { class: 'form-row' }, confirmBtn, why, saveBtn, previewBtn),
    plan.notes?.length ? h('details', null, h('summary', null, 'Notes on this draft'), h('ul', { class: 'plain-list' }, plan.notes.map(n => h('li', null, n)))) : null);
}

function termsRow(label: string, xs: string[], alt = false) {
  return xs.length ? h('div', { class: 'field' }, h('span', { class: 'label' }, label), h('div', { class: 'chips' }, xs.map(x => h('span', { class: `chip plain${alt ? ' alt' : ''}` }, x)))) : null;
}

function lockedPlan(req: Req) {
  const v = req.current;
  const p = v.plan;
  const names = new Map([...req.choices.sources, ...req.choices.stubs].map(x => [x.id, x.name]));
  const runBtn = h('button', { type: 'button', class: 'button primary', disabled: !canSearch }, req.lastRunAt ? 'Search again with this version' : 'Run search ▶');
  const out = h('div');
  runBtn.addEventListener('click', async () => {
    try { await busy(runBtn, 'Searching…', () => post(`/api/requests/${req.id}/run`, { version: v.version })); location.href = `/search.html?id=${req.id}`; }
    catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'The search failed.')); }
  });
  const edit = h('button', { type: 'button', class: 'button secondary', disabled: !canSearch || Boolean(req.handedOffAt) }, `Edit plan (starts version ${v.version + 1})`);
  edit.addEventListener('click', async () => {
    try { const r = await busy(edit, 'Opening…', () => put<Req>(`/api/requests/${req.id}/plan`, { plan: v.plan, sourceIds: v.sourceIds })); render(r.data); toast(`Version ${r.data.current.version} started as a draft. Version ${v.version} stays locked.`); }
    catch (e) { replace(out, alertBox(e instanceof ApiError ? e.message : 'Could not start a new version.')); }
  });
  return h('section', { class: 'card', 'aria-labelledby': 'plan-h' },
    h('div', { class: 'card-heading' }, h('h2', { id: 'plan-h' }, '2. Search plan', pill('ok', 'Confirmed and locked', '✓')), h('span', { class: 'micro' }, `Version ${v.version}`)),
    h('p', { class: 'helper' }, `Confirmed by ${v.confirmedBy} on ${fmtDate(v.confirmedAt, true)}.${v.note ? ` ${v.note}.` : ''}`),
    termsRow('Terms', p.keywords), termsRow('Synonyms and related wording', p.alternateTerms, true), termsRow('Names, places and exact phrases', [...p.phrases, ...p.people, ...p.locations, ...p.organizations]),
    h('dl', { class: 'meta-list' },
      h('dt', null, 'Date range'), h('dd', null, p.dateFrom || p.dateTo ? `${p.dateFrom ? fmtDate(p.dateFrom) : 'Any'} to ${p.dateTo ? fmtDate(p.dateTo) : 'any'}` : 'Any date'),
      h('dt', null, 'Record types'), h('dd', null, p.recordTypes.join(', ') || 'Any', p.filterRecordTypes ? ' (only these)' : ''),
      h('dt', null, 'Departments'), h('dd', null, p.departments.join(', ') || 'Any', p.filterDepartments ? ' (only these)' : ''),
      h('dt', null, 'Exclude'), h('dd', null, p.exclusions.join(', ') || 'None'),
      h('dt', null, 'Sources'), h('dd', null, v.sourceIds.map(id => names.get(id) || 'Source').join(', '))),
    out,
    h('div', { class: 'form-row' },
      req.lastRunAt ? h('a', { class: 'button primary link-button', href: `/search.html?id=${req.id}` }, 'Go to results ▶') : runBtn,
      req.lastRunAt ? runBtn : null, edit,
      h('button', { type: 'button', class: 'button secondary', on: { click: () => preview(req.id) } }, 'Source map')));
}

function versionsCard(req: Req) {
  return h('section', { class: 'card' }, h('h2', null, 'Plan versions'),
    h('ul', { class: 'plain-list' }, req.versions.map(v => h('li', null, `Version ${v.version}: `,
      v.status === 'confirmed' ? pill('ok', 'Confirmed') : pill('draft', 'Draft'), ` ${v.status === 'confirmed' ? `by ${v.confirmedBy}, ${fmtDate(v.confirmedAt, true)}` : `started by ${v.createdBy}`}${v.note ? `. ${v.note}` : ''}`))),
    h('p', { class: 'hint' }, 'Confirmed versions never change. Every edit, confirmation and search is in the audit log.'));
}

/* ---------------- screen 11: preview counts and source map ---------------- */

interface Preview { version: number; status: string; total: number; threshold: number; broad: boolean; counts: { id: string; name: string; count: number; chosen: boolean }[]; stubs: { id: string; name: string }[]; chips: { id: string; label: string; patch: Partial<Plan> }[]; note: string }
interface Custodian { department: string; systems: string[]; custodian: string; status: string; confirmedBy: string | null; confirmedAt: string | null }

async function preview(id: string) {
  const body = h('div', { class: 'cols-2' });
  const dlg = openDialog('Plan preview and source map', body, { wide: true, onClose: () => location.reload() });
  void dlg;
  const draw = async () => {
    let p: Preview, req: Req;
    try { [p, req] = await Promise.all([get<Preview>(`/api/requests/${id}/preview`).then(r => r.data), get<Req & { custodians: Custodian[] }>(`/api/requests/${id}`).then(r => r.data)]); }
    catch (e) { replace(body, alertBox(e instanceof ApiError ? e.message : 'Could not count.')); return; }
    const custodians = (req as unknown as { custodians: Custodian[] }).custodians;
    const left = h('section', null, h('h3', null, 'Possible matches per source (approximate)'),
      p.broad ? h('div', { class: 'banner warn', role: 'status' }, h('span', { 'aria-hidden': 'true' }, '⚠'), h('span', null, `This plan is broad: about ${p.total} possible matches, above the warning level of ${p.threshold} set in Settings. You can still search.`)) : h('p', { class: 'helper' }, `About ${p.total} possible matches in the chosen sources. Warning level: ${p.threshold}.`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Source'), h('th', null, 'Chosen'), h('th', null, 'Approx. count'))),
        h('tbody', null, ...p.counts.map(c => h('tr', null, h('td', null, c.name), h('td', null, c.chosen ? 'Yes' : 'No'), h('td', { class: 'num' }, `~${c.count}`))),
          ...p.stubs.map(c => h('tr', null, h('td', null, c.name), h('td', null, 'Not connected'), h('td', { class: 'num' }, 'no count')))))),
      p.chips.length && p.status === 'draft' ? h('div', null, h('p', { class: 'label' }, 'Narrow using plan fields'),
        h('div', { class: 'chips' }, p.chips.map(c => h('button', { type: 'button', class: 'button small secondary', on: { click: async (e: Event) => {
          try { await busy(e.currentTarget as HTMLButtonElement, 'Applying…', () => put(`/api/requests/${id}/plan`, { plan: { ...req.current.plan, ...c.patch }, sourceIds: req.current.sourceIds })); draw(); }
          catch (err) { toast(err instanceof ApiError ? err.message : 'Could not apply.', 'error'); }
        } } }, c.label)))) : p.status === 'confirmed' ? h('p', { class: 'hint' }, 'This version is locked. Narrowing chips apply to draft versions.') : null,
      h('p', { class: 'hint' }, p.note));
    const right = h('section', null, h('h3', null, 'Source map and custodian checklist'),
      h('p', { class: 'helper' }, 'Who to ask in each department. The tool never contacts anyone: mark Confirmed after you ask.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, h('thead', null, h('tr', null, h('th', null, 'Department'), h('th', null, 'Likely systems'), h('th', null, 'Custodian'), h('th', null, 'Status'))),
        h('tbody', null, custodians.map(c => {
          const box = h('input', { type: 'checkbox', checked: c.status === 'confirmed', 'aria-label': `Confirmed: ${c.department}` }) as HTMLInputElement;
          box.addEventListener('change', async () => {
            try { await put(`/api/requests/${id}/custodians`, { department: c.department, status: box.checked ? 'confirmed' : 'pending' }); draw(); }
            catch (err) { toast(err instanceof ApiError ? err.message : 'Could not save.', 'error'); box.checked = !box.checked; }
          });
          return h('tr', null, h('td', null, c.department), h('td', null, c.systems.join(', ')), h('td', null, c.custodian),
            h('td', null, h('label', { class: 'inline-check' }, box, c.status === 'confirmed' ? `Confirmed by ${c.confirmedBy}, ${fmtDate(c.confirmedAt)}` : 'Pending')));
        })))),
      h('p', { class: 'hint' }, 'Names in the demo pack are placeholders or invented. Real custodians come from the city.'));
    replace(body, left, right);
  };
  draw();
}

/* ---------------- screen 15: clarification drafts ---------------- */

interface Clarify { origin: string; model: string | null; english: { questions: string[]; text: string; grade: number; target: number; targetNote: string }; spanish: { questions: string[]; text: string; label: string }; note: string; fallbackReason: string | null }

async function clarify(req: Req) {
  const body = h('div', null, h('p', { class: 'helper' }, 'Drafting…'));
  openDialog('Clarification drafts', body, { wide: true });
  let d: Clarify;
  try { d = (await post<Clarify>(`/api/requests/${req.id}/clarify`)).data; }
  catch (e) { replace(body, alertBox(e instanceof ApiError ? e.message : 'Could not draft questions.')); return; }
  const en = h('textarea', { id: 'cl-en', rows: 8 }) as HTMLTextAreaElement; en.value = d.english.text;
  const es = h('textarea', { id: 'cl-es', rows: 8, lang: 'es' }) as HTMLTextAreaElement; es.value = d.spanish.text;
  const reviewed = h('input', { type: 'checkbox', id: 'cl-es-ok' }) as HTMLInputElement;
  const copyEs = h('button', { type: 'button', class: 'button secondary', disabled: true, 'aria-describedby': 'es-why' }, 'Copy Spanish text');
  const esWhy = h('span', { class: 'disabled-reason', id: 'es-why' }, 'A person must review the Spanish draft first.');
  reviewed.addEventListener('change', () => { copyEs.disabled = !reviewed.checked; esWhy.hidden = reviewed.checked; });
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('Copied. Paste it into the portal ticket.'); } catch { toast('Select the text and copy it.', 'error'); } };
  copyEs.addEventListener('click', () => copy(es.value));
  const grade = d.english.grade;
  replace(body,
    h('div', { class: 'banner info', role: 'note' }, h('span', null, `${d.note} The model sees only the request text.${d.origin === 'rules' ? ' Drafted by local rules (no model).' : ''}`)),
    h('div', { class: 'cols-2' },
      h('section', null, field('English draft (plain language)', en),
        h('p', { class: grade <= d.english.target ? 'helper' : 'alert alert-warn' }, `Reading level: grade ${grade}. Target grade ${d.english.target}. ${d.english.targetNote}`),
        h('div', { class: 'form-row' }, h('button', { type: 'button', class: 'button primary', on: { click: () => copy(en.value) } }, 'Copy English text'))),
      h('section', null, field('Spanish draft', es), pill('warn', d.spanish.label, '!'),
        h('label', { class: 'inline-check consent-ack' }, reviewed, 'A person who reads Spanish reviewed this draft.'),
        h('div', { class: 'form-row' }, copyEs, esWhy))),
    h('p', { class: 'hint' }, 'There is no send button. Staff copy approved text into the portal ticket.'));
}

void empty;
main();
