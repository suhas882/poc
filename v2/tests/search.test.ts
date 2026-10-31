import { describe, expect, it } from 'vitest';
import { records } from '../src/data/records';
import { scenarios } from '../src/data/scenarios';
import { highlight, rank, suggestedConcepts, CLARIFICATION_DRAFT } from '../src/lib/search';
import { metrics, runFullEvaluation } from '../src/lib/evaluation';
import type { SearchPlan } from '../src/lib/types';

const blankPlan: SearchPlan = { requestText: '', topics: '', alternateTerms: '', peopleOrgs: '', dateFilter: '', departmentFilter: '', recordFilter: '', repositoryFilter: '', exclusions: '', clarificationQuestions: '', confirmed: true };
const s0 = scenarios[0]!;
const plan = (p: Partial<SearchPlan>): SearchPlan => ({ ...blankPlan, topics: 'road closure, Cedar Avenue, utility work', alternateTerms: 'lane closure, right-of-way work, detour', dateFilter: '2024', ...p });

// Ported from v1 smoke-test.js
describe('corpus and scenarios', () => {
  it('loads 18 scenarios split 6/6/6 and 18 records', () => {
    expect(scenarios).toHaveLength(18);
    for (const t of ['Exact keyword', 'Different wording', 'Vague request']) expect(scenarios.filter(s => s.type === t)).toHaveLength(6);
    expect(records).toHaveLength(18);
  });
});

describe('ranking', () => {
  it('both modes return positively scored candidates; synonym scenario finds labeled records', () => {
    const hybrid = rank('hybrid', s0, plan({})), keyword = rank('keyword', s0, plan({}));
    expect(hybrid.length).toBeGreaterThan(0); expect(keyword.length).toBeGreaterThan(0);
    expect(hybrid[0]!.score).toBeGreaterThan(0);
    expect(hybrid.slice(0, 10).some(x => s0.relevant.includes(x.record.id))).toBe(true);
  });
  it('applies strict department, date, record-type and exclusion filters', () => {
    expect(rank('hybrid', s0, plan({ departmentFilter: 'Parks' })).every(x => x.record.department === 'Parks')).toBe(true);
    expect(rank('hybrid', s0, plan({ dateFilter: '2023' })).every(x => x.record.date.includes('2023'))).toBe(true);
    expect(rank('hybrid', s0, plan({ dateFilter: '', recordFilter: 'email' })).every(x => x.record.type.toLowerCase().includes('email'))).toBe(true);
    expect(rank('hybrid', s0, plan({ dateFilter: '', exclusions: 'Cedar' })).every(x => !`${x.record.title} ${x.record.text}`.toLowerCase().includes('cedar'))).toBe(true);
  });
  it('every scenario retrieves at least one labeled record', () => {
    for (const s of scenarios) {
      const r = rank('hybrid', s, plan({ topics: s.topics, alternateTerms: s.alternate ?? '', dateFilter: s.date ?? '' }));
      expect(r.some(x => s.relevant.includes(x.record.id)), s.id).toBe(true);
    }
  });
  it('hybrid lifts recall on different wording and ties on exact keywords', () => {
    const p = plan({ topics: s0.topics, alternateTerms: s0.alternate!, dateFilter: '' });
    expect(metrics(rank('hybrid', s0, p), 10, s0).recall).toBeGreaterThan(metrics(rank('keyword', s0, p), 10, s0).recall);
    const ex = scenarios.find(s => s.id === 'exact-1')!;
    const pe = plan({ topics: ex.topics, alternateTerms: '', dateFilter: ex.date! });
    expect(metrics(rank('hybrid', ex, pe), 10, ex).recall).toBe(metrics(rank('keyword', ex, pe), 10, ex).recall);
  });
  it('top-50 recall is never below top-10 recall', () => {
    const r = rank('hybrid', s0, plan({}));
    expect(metrics(r, 50, s0).recall).toBeGreaterThanOrEqual(metrics(r, 10, s0).recall);
  });
});

describe('helpers', () => {
  it('highlights matching evidence as marked segments', () => {
    expect(highlight('A road closure affects the street.', ['road', 'closure']).filter(s => s.mark).map(s => s.text)).toEqual(['road', 'closure']);
  });
  it('suggests curated alternates and drafts clarification questions', () => {
    expect(suggestedConcepts('stormwater inspection summary')).toContain('rainwater drains');
    expect(CLARIFICATION_DRAFT).toContain('date range');
  });
  it('full evaluation covers all scenarios and verifies the recall lift', () => {
    const e = runFullEvaluation();
    expect(e.scenario_count).toBe(18);
    expect(e.groups['Exact keyword']!.hybrid.recallAt10).toBe(100);
    expect(e.groups['Different wording']!.hybrid.recallAt10).toBeGreaterThan(e.groups['Different wording']!.keyword.recallAt10);
  });
});
