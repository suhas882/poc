import { ApiError, can, get, post } from '../api.js';
import { currentMode, initShell } from '../shell.js';
import { $, alertBox, busy, h, joinList, replace, SOURCE_LABEL, splitList, toast } from '../ui.js';

interface Plan {
  summary: string; keywords: string[]; alternateTerms: string[]; phrases: string[]; people: string[]; organizations: string[]; locations: string[];
  dateFrom: string | null; dateTo: string | null; departments: string[]; recordTypes: string[]; sourceIds: string[]; exclusions: string[];
  clarifyingQuestions: string[]; notes: string[]; filterDepartments: boolean; filterRecordTypes: boolean;
}
interface Drafted { searchId: string; plan: Plan; origin: 'claude' | 'rules'; model: string | null; fallbackReason: string | null; sources: { id: string; name: string; type: string }[] }

const EXAMPLES = [
  'Please provide all records related to the road closure on Cedar Avenue while utility crews were conducting their work between January and March 2025.',
  'All emails between the Transportation department and contractors about detours on Main Street in 2024.',
  'Text messages or emails mentioning the water main break near Pine Street since 2023.'
];

let drafted: Drafted | null = null;
const input = (id: string) => $<HTMLInputElement>(`#${id}`)!;

async function main() {
  const status = await initShell();
  if (currentMode() !== 'real' || !status.user) return;
  if (!can(status, 'search.run')) {
    replace($('#draft-error')!, alertBox('Your role can read history and audit logs but cannot run searches.', 'info'));
    $<HTMLButtonElement>('#draft-plan')!.disabled = true;
    return;
  }
  const sys = await get<{ ai: { configured: boolean; model: string | null } }>('/api/system/status').catch(() => null);
  $('#planner-status')!.textContent = sys?.data.ai.configured ? `CLAUDE · ${sys.data.ai.model}` : 'LOCAL RULES · CLAUDE NOT CONFIGURED';
  if (!sys?.data.ai.configured) $('#draft-hint')!.textContent = 'Claude is not configured on this server, so local rules will draft the plan.';

  const ex = $('#examples')!;
  replace(ex, h('span', { class: 'helper' }, 'Try:'), ...EXAMPLES.map((e, i) => h('button', { type: 'button', class: 'concept-term', on: { click: () => { $<HTMLTextAreaElement>('#real-request')!.value = e; } } }, `Example ${i + 1}`)));

  const prefill = new URLSearchParams(location.search).get('request');
  if (prefill) $<HTMLTextAreaElement>('#real-request')!.value = prefill.slice(0, 6000);

  $<HTMLButtonElement>('#draft-plan')!.addEventListener('click', (e) => draft(e.currentTarget as HTMLButtonElement));
  $<HTMLButtonElement>('#run-search')!.addEventListener('click', (e) => run(e.currentTarget as HTMLButtonElement));
}

async function draft(btn: HTMLButtonElement) {
  const text = $<HTMLTextAreaElement>('#real-request')!.value.trim();
  const err = $('#draft-error')!;
  replace(err);
  if (text.length < 3) { replace(err, alertBox('Describe the records you need before drafting a plan.')); $('#real-request')!.focus(); return; }
  try {
    const res = await busy(btn, 'Drafting…', () => post<Drafted>('/api/searches/plan', { requestText: text, mode: 'real' }));
    drafted = res.data;
    fillPlan(drafted);
  } catch (e) {
    replace(err, alertBox(e instanceof ApiError ? e.message : 'The plan could not be drafted.'));
  }
}

function fillPlan(d: Drafted) {
  const p = d.plan;
  $('#plan-card')!.hidden = false;
  $('#plan-origin')!.textContent = d.origin === 'claude' ? `DRAFTED BY CLAUDE · ${d.model}` : 'DRAFTED BY LOCAL RULES';
  $('#plan-summary')!.textContent = p.summary;
  const notes = [...p.notes];
  if (d.fallbackReason) notes.unshift(`Claude was not used: ${d.fallbackReason}`);
  replace($('#plan-notes')!, notes.length ? alertBox(notes.join(' '), d.fallbackReason ? 'warn' : 'info') : null);
  input('p-keywords').value = joinList(p.keywords);
  input('p-alternate').value = joinList(p.alternateTerms);
  input('p-phrases').value = joinList(p.phrases);
  input('p-people').value = joinList(p.people);
  input('p-orgs').value = joinList(p.organizations);
  input('p-locations').value = joinList(p.locations);
  input('p-from').value = p.dateFrom ?? '';
  input('p-to').value = p.dateTo ?? '';
  input('p-departments').value = joinList(p.departments);
  input('p-types').value = joinList(p.recordTypes);
  input('p-dept-strict').checked = p.filterDepartments;
  input('p-types-strict').checked = p.filterRecordTypes;
  input('p-exclusions').value = joinList(p.exclusions);
  input('p-confirm').checked = false;
  const chosen = new Set(p.sourceIds);
  replace($('#p-sources')!, d.sources.length
    ? d.sources.map(s => h('label', { class: 'inline-check' }, h('input', { type: 'checkbox', value: s.id, checked: chosen.size === 0 || chosen.has(s.id) }), `${s.name} `, h('small', null, `(${SOURCE_LABEL[s.type] || s.type})`)))
    : alertBox('You have no connected sources you can search yet.', 'warn', h('a', { href: '/sources.html', class: 'button secondary link-button' }, 'Connect a source')));
  replace($('#p-questions')!, p.clarifyingQuestions.length
    ? h('div', { class: 'clarification' }, h('b', null, 'This request may be too broad. Questions you could ask the requester:'), h('ul', null, p.clarifyingQuestions.map(q => h('li', null, q))), h('span', null, 'These are drafts for staff. Nothing is sent to the requester.'))
    : null);
  $('#plan-card')!.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  input('p-keywords').focus({ preventScroll: true });
}

async function run(btn: HTMLButtonElement) {
  const err = $('#run-error')!;
  replace(err);
  if (!drafted) return;
  if (!input('p-confirm').checked) { replace(err, alertBox('Tick the box to confirm you reviewed the plan.')); input('p-confirm').focus(); return; }
  const sourceBoxes = [...document.querySelectorAll<HTMLInputElement>('#p-sources input[type=checkbox]')];
  const selected = sourceBoxes.filter(b => b.checked).map(b => b.value);
  if (sourceBoxes.length && !selected.length) { replace(err, alertBox('Choose at least one source to search.')); return; }
  const plan: Plan = {
    ...drafted.plan,
    keywords: splitList(input('p-keywords').value), alternateTerms: splitList(input('p-alternate').value), phrases: splitList(input('p-phrases').value),
    people: splitList(input('p-people').value), organizations: splitList(input('p-orgs').value), locations: splitList(input('p-locations').value),
    dateFrom: input('p-from').value || null, dateTo: input('p-to').value || null,
    departments: splitList(input('p-departments').value), recordTypes: splitList(input('p-types').value),
    filterDepartments: input('p-dept-strict').checked, filterRecordTypes: input('p-types-strict').checked,
    exclusions: splitList(input('p-exclusions').value),
    sourceIds: selected.length === sourceBoxes.length ? [] : selected
  };
  try {
    const res = await busy(btn, 'Searching…', () => post<{ searchId: string; total: number }>(`/api/searches/${drafted!.searchId}/run`, { plan, confirmed: true }));
    toast(`${res.data.total} records found`);
    location.href = `/search.html?search=${encodeURIComponent(res.data.searchId)}`;
  } catch (e) {
    replace(err, alertBox(e instanceof ApiError ? e.message : 'The search failed.'));
  }
}

main();
