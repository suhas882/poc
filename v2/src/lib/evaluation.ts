import { records } from '../data/records';
import { scenarios } from '../data/scenarios';
import { timedRank } from './search';
import type { RankedResult, Scenario, SearchMethod, SearchPlan } from './types';

export interface CutoffMetrics {
  /** Whole-number percentages, rounded per scenario exactly as in v1. */
  recall: number;
  precision: number;
  /** 1-based rank of the first labeled record, or null. */
  firstRank: number | null;
}

export function metrics(data: RankedResult[], cutoff: number, scenario: Scenario, corpusSize = records.length): CutoffMetrics {
  const rel = new Set(scenario.relevant);
  const hits = data.slice(0, cutoff).filter(x => rel.has(x.record.id)).length;
  const first = data.findIndex(x => rel.has(x.record.id));
  return {
    recall: Number((hits / rel.size * 100).toFixed(0)),
    precision: Number((hits / Math.min(cutoff, corpusSize) * 100).toFixed(0)),
    firstRank: first < 0 ? null : first + 1
  };
}

export interface MethodComparison {
  at10: CutoffMetrics;
  at50: CutoffMetrics;
  elapsedMs: number;
  /** Local ranking time when a labeled record was found; null otherwise. Not staff time. */
  timeToFirstMs: number | null;
}

export function compareMethods(scenario: Scenario, plan: SearchPlan | null): Record<SearchMethod, MethodComparison> {
  const run = (method: SearchMethod): MethodComparison => {
    const { results, elapsedMs } = timedRank(method, scenario, plan);
    const at10 = metrics(results, 10, scenario);
    return { at10, at50: metrics(results, 50, scenario), elapsedMs, timeToFirstMs: at10.firstRank === null ? null : elapsedMs };
  };
  return { hybrid: run('hybrid'), keyword: run('keyword') };
}

export const REQUEST_TYPES = ['Exact keyword', 'Different wording', 'Vague request'] as const;

export interface GroupSummary {
  count: number;
  recallAt10: number; precisionAt10: number; recallAt50: number; precisionAt50: number;
  meanFirstRank: number | null; meanTimeToFirstMs: number | null;
}

export interface FullEvaluation {
  notice: string;
  corpus_size: number;
  scenario_count: number;
  groups: Record<string, Record<SearchMethod, GroupSummary>>;
  scenarios: { id: string; label: string; type: string; methods: Record<SearchMethod, MethodComparison> }[];
}

const mean = (xs: number[], digits: number) => xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(digits)) : null;

export function runFullEvaluation(): FullEvaluation {
  const cases = scenarios.map(s => ({ id: s.id, label: s.label, type: s.type, methods: compareMethods(s, null) }));
  const groups: FullEvaluation['groups'] = {};
  for (const type of REQUEST_TYPES) {
    const rows = cases.filter(c => c.type === type);
    const summarise = (m: SearchMethod): GroupSummary => ({
      count: rows.length,
      recallAt10: mean(rows.map(r => r.methods[m].at10.recall), 1) ?? 0,
      precisionAt10: mean(rows.map(r => r.methods[m].at10.precision), 1) ?? 0,
      recallAt50: mean(rows.map(r => r.methods[m].at50.recall), 1) ?? 0,
      precisionAt50: mean(rows.map(r => r.methods[m].at50.precision), 1) ?? 0,
      meanFirstRank: mean(rows.flatMap(r => r.methods[m].at10.firstRank ?? []), 1),
      meanTimeToFirstMs: mean(rows.flatMap(r => r.methods[m].timeToFirstMs ?? []), 3)
    });
    groups[type] = { keyword: summarise('keyword'), hybrid: summarise('hybrid') };
  }
  return {
    notice: 'Synthetic provisional labels only. Performance figures are target outcomes to be validated during discovery. Hybrid is local keyword plus curated concept expansion, not an embedding model. Time is local ranking latency, not staff time.',
    corpus_size: records.length,
    scenario_count: cases.length,
    groups,
    scenarios: cases
  };
}
