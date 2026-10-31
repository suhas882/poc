/**
 * Local lexical retrieval: phrase-aware keyword scoring, light plural
 * normalisation, rare-term weighting, field boosts, curated concept expansion
 * and strict metadata filters. This is a port of v1 app.js with identical
 * scoring. Each record's token sets and document frequencies are computed
 * once instead of on every query term.
 */
import { records as defaultRecords } from '../data/records';
import { synonymGroups } from '../data/synonyms';
import type {
  Evidence, EvidenceKind, RankedResult, Scenario, SearchMethod, SearchPlan, SyntheticRecord
} from './types';

const STOP = new Set(['a', 'all', 'an', 'and', 'about', 'after', 'are', 'by', 'city', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'with', 'find', 'records', 'record', 'please', 'show', 'send', 'give', 'need', 'want']);

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(t => t.length > 4 && t.endsWith('ies') ? t.slice(0, -3) + 'y'
      : t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function containsTerm(text: string, term: string): boolean {
  return new RegExp('(^|[^a-z0-9])' + escapeRe(term.toLowerCase()) + '(?=$|[^a-z0-9])', 'i').test(text);
}

export const splitTerms = (s: string) => s.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);

interface QueryTerm { weight: number; kind: EvidenceKind }

export function expandedTerms(raw: string): Map<string, QueryTerm> {
  const expanded = new Map<string, QueryTerm>(tokens(raw).map(t => [t, { weight: 1, kind: 'query' }]));
  if (!raw) return expanded;
  const normalized = normalise(raw);
  for (const group of synonymGroups) {
    if (!group.some(phrase => normalized.includes(normalise(phrase)))) continue;
    for (const phrase of group) for (const token of tokens(phrase)) {
      if (!expanded.has(token)) expanded.set(token, { weight: 0.28, kind: 'concept' });
    }
  }
  return expanded;
}

/** Up to three curated alternates for the given terms that are not already present. */
export function suggestedConcepts(raw: string): string[] {
  const normalized = normalise(raw);
  const candidates = synonymGroups
    .filter(group => group.some(p => normalized.includes(normalise(p))))
    .flatMap(group => group.filter(p => !normalized.includes(normalise(p))));
  return [...new Set(candidates)].slice(0, 3);
}

/* ---------- precomputed index ---------- */

interface IndexedRecord {
  record: SyntheticRecord;
  title: string; meta: string; body: string; full: string;
  titleTokens: Set<string>; metaTokens: Set<string>; bodyTokens: Set<string>;
}

export interface SearchIndex {
  size: number;
  items: IndexedRecord[];
  documentFrequency: (term: string) => number;
}

export function buildIndex(source: readonly SyntheticRecord[] = defaultRecords): SearchIndex {
  const items = source.map<IndexedRecord>(record => {
    const title = record.title.toLowerCase();
    const meta = `${record.department} ${record.type} ${record.terms.join(' ')}`.toLowerCase();
    const body = record.text.toLowerCase();
    return {
      record, title, meta, body,
      full: `${record.title} ${record.department} ${record.type} ${record.text} ${record.terms.join(' ')}`.toLowerCase(),
      titleTokens: new Set(tokens(title)), metaTokens: new Set(tokens(meta)), bodyTokens: new Set(tokens(body))
    };
  });
  const docTokens = source.map(r => new Set(tokens(`${r.title} ${r.department} ${r.type} ${r.text} ${r.terms.join(' ')}`)));
  const dfCache = new Map<string, number>();
  return {
    size: source.length,
    items,
    documentFrequency: term => {
      let df = dfCache.get(term);
      if (df === undefined) { df = docTokens.reduce((n, set) => n + Number(set.has(term)), 0); dfCache.set(term, df); }
      return df;
    }
  };
}

export const defaultIndex = buildIndex();

interface Boosts { date?: string; department?: string; type?: string }

function scoreItem(item: IndexedRecord, raw: string, hybrid: boolean, index: SearchIndex, boosts: Boosts) {
  const query = hybrid ? expandedTerms(raw) : new Map<string, QueryTerm>(tokens(raw).map(t => [t, { weight: 1, kind: 'query' }]));
  let score = 0;
  const hits: string[] = [];
  const evidence: Evidence[] = [];
  for (const [t, { weight, kind }] of query) {
    const inTitle = item.titleTokens.has(t), inMeta = item.metaTokens.has(t), inBody = item.bodyTokens.has(t);
    if (!(inTitle || inMeta || inBody)) continue;
    const rarity = 1 + Math.log((index.size + 1) / (index.documentFrequency(t) + 1));
    score += weight * rarity * (inTitle ? 4 : inMeta ? 2 : 1);
    hits.push(t);
    evidence.push({ term: t, kind, field: inTitle ? 'title' : inMeta ? 'metadata' : 'passage' });
  }
  for (const phrase of raw.toLowerCase().split(/[,;\n]+/).map(x => x.trim()).filter(x => x.length > 3)) {
    if (containsTerm(item.title, phrase)) { score += hybrid ? 7 : 6; evidence.push({ term: phrase, kind: 'phrase', field: 'title' }); }
    else if (containsTerm(item.body, phrase)) { score += hybrid ? 4 : 3; evidence.push({ term: phrase, kind: 'phrase', field: 'passage' }); }
    else if (containsTerm(item.meta, phrase)) { score += hybrid ? 3 : 2; evidence.push({ term: phrase, kind: 'phrase', field: 'metadata' }); }
  }
  const r = item.record;
  if (boosts.date && r.date.includes(boosts.date)) score += 0.6;
  if (boosts.department && r.department.toLowerCase().includes(boosts.department.toLowerCase())) score += 0.8;
  if (boosts.type && r.type.toLowerCase().includes(boosts.type.toLowerCase())) score += 0.8;
  return { score, hits: [...new Set(hits)], evidence };
}

const REPOSITORIES: Record<string, string> = {
  Transportation: 'Transportation files', 'Public Works': 'Public Works files', Utilities: 'Utilities files',
  'City Clerk': 'City Clerk files', 'Development Services': 'Development Services files', Parks: 'Parks files'
};
export const repositoryFor = (r: SyntheticRecord) => REPOSITORIES[r.department] ?? 'Other synthetic files';
export const repositories = Object.values(REPOSITORIES);
export const groupFor = (r: SyntheticRecord) => ['R-001', 'R-002', 'R-018'].includes(r.id) ? 'Cedar Avenue utility project' : null;

/**
 * Rank the corpus. With a plan, the staff-edited terms and strict filters
 * apply (the Search Results page). Without one, only the scenario's own terms
 * and date are used (the all-scenario benchmark).
 */
export function rank(method: SearchMethod, scenario: Scenario | undefined, plan: SearchPlan | null, index: SearchIndex = defaultIndex): RankedResult[] {
  const date = (plan ? plan.dateFilter : scenario?.date ?? '').trim();
  const dep = (plan?.departmentFilter ?? '').trim().toLowerCase();
  const typ = (plan?.recordFilter ?? '').trim().toLowerCase();
  const repo = (plan?.repositoryFilter ?? '').trim();
  const excluded = tokens(plan?.exclusions ?? '');
  const topic = plan ? (plan.topics || scenario?.topics || '') : (scenario?.topics ?? '');
  const alternate = plan ? (plan.alternateTerms || scenario?.alternate || '') : (scenario?.alternate ?? '');
  const people = plan?.peopleOrgs ?? '';
  const raw = [topic, method === 'hybrid' ? alternate : '', people].join(', ');
  const boosts = { date, department: dep, type: typ };
  return index.items
    .filter(({ record: r, full }) =>
      (!date || r.date.includes(date)) &&
      (!dep || r.department.toLowerCase().includes(dep)) &&
      (!typ || r.type.toLowerCase().includes(typ)) &&
      (!repo || repositoryFor(r) === repo) &&
      !excluded.some(t => containsTerm(full, t)))
    .map(item => ({ record: item.record, ...scoreItem(item, raw, method === 'hybrid', index, boosts) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
}

export function timedRank(method: SearchMethod, scenario: Scenario | undefined, plan: SearchPlan | null) {
  const start = performance.now();
  const results = rank(method, scenario, plan);
  return { results, elapsedMs: performance.now() - start };
}

export type MatchStrength = 'strong' | 'possible' | 'weak';
export const strengthOf = (score: number): MatchStrength => score >= 12 ? 'strong' : score >= 5 ? 'possible' : 'weak';

/** Explain why a candidate was shown, in plain words. */
export function reasonFor(result: RankedResult, method: SearchMethod): string {
  const why = [...new Set(result.evidence.slice(0, 4).map(e =>
    `${e.kind === 'concept' ? 'related concept' : e.kind === 'phrase' ? 'phrase' : 'term'} in ${e.field}`))];
  if (why.length) return why.join(' · ');
  return `${method === 'hybrid' ? 'Concept-expanded' : 'Keyword'} matches: ${result.hits.slice(0, 5).join(', ') || 'context and metadata'}`;
}

export interface Segment { text: string; mark: boolean }

/** Split a passage into plain and highlighted segments (rendered safely by React). */
export function highlight(text: string, hits: string[]): Segment[] {
  const terms = hits.filter(x => x.length > 2).sort((a, b) => b.length - a.length);
  if (!terms.length) return [{ text, mark: false }];
  const variants = terms.flatMap(t => { const safe = escapeRe(t); return [safe, t.endsWith('y') ? safe.slice(0, -1) + 'ies' : safe + 's']; });
  const re = new RegExp('\\b(' + variants.join('|') + ')\\b', 'gi');
  const lower = new Set(variants.map(v => v.toLowerCase()));
  return text.split(re).filter(Boolean).map(part => ({ text: part, mark: lower.has(part.toLowerCase()) }));
}

/* ---------- plan drafting ---------- */

const PLAN_STOP = ['please', 'records', 'about', 'find', 'send', 'from', 'with', 'that', 'this', 'city', 'want', 'while', 'during', 'everything'];

export const CLARIFICATION_DRAFT = [
  'Which project, location, or subject should the search focus on?',
  'What date range should staff search?',
  'Are there departments or record types to include or exclude?'
].join('\n');

export function draftTopics(requestText: string): string {
  const text = requestText.toLowerCase();
  const terms = [...new Set((text.match(/[a-z0-9-]+(?:\s+[a-z0-9-]+){0,2}/g) ?? []).filter(w => w.length > 3 && !PLAN_STOP.includes(w)))];
  return terms.slice(0, 8).join(', ');
}

export function isBroadRequest(requestText: string): boolean {
  const text = requestText.toLowerCase();
  return text.includes('all records') || text.includes('everything') || text.includes('all the records') || text.length < 30;
}
