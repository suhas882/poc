import { ApiError, can, get } from '../api.js';
import { currentMode, initShell } from '../shell.js';
import { $, alertBox, empty, fmtDate, fmtMs, h, replace } from '../ui.js';

interface Summary {
  notice: string; searches: number; searchesWithJudgments: number;
  judgments: { total: number; relevant: number; notRelevant: number; unsure: number };
  precisionAt10: number | null; precisionAt50: number | null; pooledRecallAt10: number | null;
  execution: { medianMs: number | null; p95Ms: number | null; zeroResultSearches: number; averageResults: number | null; plansByClaude: number; plansByRules: number };
  falsePositives: { searchId: string; request: string; recordId: string; title: string; rank: number; band: string; matchType: string; reasons: string[]; note: string | null }[];
  history: { searchId: string; request: string; title: string; rank: number; judgment: string; note: string | null; at: string }[];
}
const LABEL: Record<string, string> = { relevant: 'Relevant', not_relevant: 'Not relevant', unsure: 'Unsure' };
let scope = 'mine';

async function main() {
  const status = await initShell();
  if (currentMode() !== 'real' || !status.user) return;
  if (!can(status, 'evaluate.write') && can(status, 'history.read_all')) scope = 'all';
  load(can(status, 'history.read_all'));
}

async function load(canAll: boolean) {
  const root = $('#real-eval')!;
  let s: Summary;
  try { s = (await get<Summary>(`/api/evaluations/summary${scope === 'all' ? '?scope=all' : ''}`)).data; }
  catch (e) { replace(root, alertBox(e instanceof ApiError ? e.message : 'Evaluation data could not be loaded.')); return; }
  const pct = (v: number | null) => v == null ? '–' : `${v}%`;
  const metric = (label: string, value: string, note: string) => h('div', { class: 'metric' }, h('span', null, label), h('b', null, value), h('small', null, note));
  replace(root,
    canAll ? h('div', { class: 'filter-bar' }, h('label', { class: 'filter' }, h('span', null, 'Scope'), h('select', { on: { change: (e: Event) => { scope = (e.target as HTMLSelectElement).value; load(canAll); } } }, h('option', { value: 'mine', selected: scope === 'mine' }, 'My searches'), h('option', { value: 'all', selected: scope === 'all' }, 'Everyone’s searches')))) : null,
    h('section', { class: 'card' },
      h('div', { class: 'card-heading' }, h('div', null, h('span', { class: 'step' }, '01'), h('h2', null, 'Search quality from staff decisions')), h('span', { class: 'micro' }, `${s.judgments.total} DECISIONS`)),
      h('p', { class: 'helper' }, s.notice),
      h('div', { class: 'metrics' },
        metric('Precision, top 10', pct(s.precisionAt10), 'Relevant ÷ judged in the top 10'),
        metric('Precision, top 50', pct(s.precisionAt50), 'Relevant ÷ judged in the top 50'),
        metric('Pooled recall, top 10', pct(s.pooledRecallAt10), 'Judged-relevant records found in the top 10'),
        metric('Decisions', String(s.judgments.total), `${s.judgments.relevant} relevant · ${s.judgments.notRelevant} not · ${s.judgments.unsure} unsure`)),
      s.judgments.total === 0 ? alertBox('No relevance decisions yet. Mark results as Relevant, Unsure or Not relevant on the Search Results page and they will be counted here.', 'info') : null),
    h('section', { class: 'card' },
      h('div', { class: 'card-heading' }, h('div', null, h('span', { class: 'step' }, '02'), h('h2', null, 'Search execution')), h('span', { class: 'micro' }, `${s.searches} SEARCHES`)),
      h('div', { class: 'metrics' },
        metric('Median ranking time', fmtMs(s.execution.medianMs), `95th percentile ${fmtMs(s.execution.p95Ms)}`),
        metric('Average results', s.execution.averageResults == null ? '–' : String(s.execution.averageResults), 'Per completed search'),
        metric('Zero-result searches', String(s.execution.zeroResultSearches), 'Worth reviewing their plans'),
        metric('Plans drafted', `${s.execution.plansByClaude} / ${s.execution.plansByRules}`, 'Claude / local rules'))),
    h('section', { class: 'card' },
      h('div', { class: 'card-heading' }, h('div', null, h('span', { class: 'step' }, '03'), h('h2', null, 'False positives in the top 10'))),
      h('p', { class: 'helper' }, 'Records staff marked Not relevant even though they ranked highly. Their “why it matched” reasons show which terms pulled them in.'),
      s.falsePositives.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['Request', 'Record', 'Rank', 'Match', 'Why it matched', 'Note'].map(x => h('th', { scope: 'col' }, x)))),
        h('tbody', null, s.falsePositives.map(f => h('tr', null, h('td', null, h('a', { href: `/search.html?search=${encodeURIComponent(f.searchId)}` }, f.request)), h('td', null, f.title), h('td', null, String(f.rank)), h('td', null, `${f.band} · ${f.matchType}`), h('td', null, f.reasons.join('; ')), h('td', null, f.note || '')))))
        : empty('None so far', 'No highly ranked record has been marked Not relevant.')),
    h('section', { class: 'card' },
      h('div', { class: 'card-heading' }, h('div', null, h('span', { class: 'step' }, '04'), h('h2', null, 'Decision history'))),
      s.history.length ? h('table', { class: 'data-table' }, h('thead', null, h('tr', null, ...['When', 'Request', 'Record', 'Rank', 'Decision', 'Note'].map(x => h('th', { scope: 'col' }, x)))),
        h('tbody', null, s.history.map(x => h('tr', null, h('td', null, fmtDate(x.at, true)), h('td', null, h('a', { href: `/search.html?search=${encodeURIComponent(x.searchId)}` }, x.request)), h('td', null, x.title), h('td', null, String(x.rank)), h('td', null, h('span', { class: `judg judg-${x.judgment}` }, LABEL[x.judgment])), h('td', null, x.note || '')))))
        : empty('No decisions yet', 'Your relevance decisions will be listed here.')));
}

main();
