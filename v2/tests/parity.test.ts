/**
 * Runs the original v1 app.js (one folder up) in a sandbox and checks the
 * TypeScript port produces identical rankings, scores and evaluation numbers.
 * Skipped automatically when v1 is not present.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scenarios } from '../src/data/scenarios';
import { rank } from '../src/lib/search';
import { runFullEvaluation } from '../src/lib/evaluation';
import type { SearchMethod, SearchPlan } from '../src/lib/types';

const v1Path = resolve(__dirname, '../../app.js');
const hasV1 = existsSync(v1Path);

function loadV1() {
  const fields: Record<string, { value: string }> = {};
  const field = (id: string) => (fields[id] ??= { value: '' });
  const context = vm.createContext({
    document: { getElementById: field, querySelectorAll: () => [], addEventListener: () => {} },
    console, Date, Set, Map, performance: { now: () => 0 }
  });
  vm.runInContext(readFileSync(v1Path, 'utf8'), context);
  return { context, field };
}

const variants: Partial<SearchPlan>[] = [
  {}, { dateFilter: '2024' }, { departmentFilter: 'transportation' }, { recordFilter: 'notice' },
  { repositoryFilter: 'Utilities files' }, { exclusions: 'Cedar, detour' }, { peopleOrgs: 'Pine Street crews' }
];

describe.skipIf(!hasV1)('parity with v1 app.js', () => {
  it('ranks identically for every scenario, method and filter combination', () => {
    const { context, field } = loadV1();
    let checked = 0;
    for (const s of scenarios) for (const v of variants) for (const method of ['hybrid', 'keyword'] as SearchMethod[]) {
      const plan: SearchPlan = { requestText: s.request, topics: s.topics, alternateTerms: s.alternate ?? '', peopleOrgs: '', dateFilter: s.date ?? '', departmentFilter: '', recordFilter: '', repositoryFilter: '', exclusions: '', clarificationQuestions: '', confirmed: true, ...v };
      const map: Record<string, string> = { topics: plan.topics, 'alternate-terms': plan.alternateTerms, 'people-orgs': plan.peopleOrgs, 'date-filter': plan.dateFilter, 'department-filter': plan.departmentFilter, 'record-filter': plan.recordFilter, 'repository-filter': plan.repositoryFilter, exclusions: plan.exclusions };
      for (const [id, value] of Object.entries(map)) field(id).value = value;
      vm.runInContext(`currentScenario=scenarios.find(s=>s.id===${JSON.stringify(s.id)})`, context);
      const v1 = JSON.parse(vm.runInContext(`JSON.stringify(rank(${JSON.stringify(method)}).map(x=>({id:x.record.id,score:x.score,hits:x.hits,evidence:x.evidence})))`, context));
      const v2 = rank(method, s, plan).map(x => ({ id: x.record.id, score: x.score, hits: x.hits, evidence: x.evidence }));
      expect(v2).toEqual(v1);
      checked++;
    }
    expect(checked).toBe(18 * variants.length * 2);
  });

  it('produces the same full-evaluation group numbers', () => {
    const { context } = loadV1();
    vm.runInContext("document.getElementById=id=>({value:'',hidden:false,innerHTML:'',disabled:false});runFullEvaluation()", context);
    const v1 = JSON.parse(vm.runInContext('JSON.stringify(fullBenchmarkResult.groups)', context));
    const v2 = runFullEvaluation().groups;
    for (const [type, g] of Object.entries(v2)) for (const m of ['keyword', 'hybrid'] as const) {
      expect(g[m].recallAt10).toBe(v1[type][`${m}_recall_at10`]);
      expect(g[m].precisionAt10).toBe(v1[type][`${m}_precision_at10`]);
      expect(g[m].recallAt50).toBe(v1[type][`${m}_recall_at50`]);
      expect(g[m].precisionAt50).toBe(v1[type][`${m}_precision_at50`]);
      expect(g[m].meanFirstRank).toBe(v1[type][`${m}_mean_first_relevant_rank`]);
    }
  });
});
