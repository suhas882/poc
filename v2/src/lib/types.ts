export interface SyntheticRecord {
  id: string;
  title: string;
  department: string;
  type: string;
  date: string;
  text: string;
  terms: string[];
}

export type RequestType = 'Exact keyword' | 'Different wording' | 'Vague request';

export interface Scenario {
  id: string;
  label: string;
  type: RequestType | string;
  request: string;
  topics: string;
  alternate?: string;
  date?: string;
  needsClarification?: boolean;
  relevant: string[];
}

export type SearchMethod = 'hybrid' | 'keyword';

/** Everything staff can edit on the Request & Plan page. */
export interface SearchPlan {
  requestText: string;
  topics: string;
  alternateTerms: string;
  peopleOrgs: string;
  dateFilter: string;
  departmentFilter: string;
  recordFilter: string;
  repositoryFilter: string;
  exclusions: string;
  clarificationQuestions: string;
  confirmed: boolean;
}

export type EvidenceKind = 'query' | 'concept' | 'phrase';
export type EvidenceField = 'title' | 'metadata' | 'passage';

export interface Evidence {
  term: string;
  kind: EvidenceKind;
  field: EvidenceField;
}

export interface RankedResult {
  record: SyntheticRecord;
  score: number;
  hits: string[];
  evidence: Evidence[];
}

export type ReviewMark = 'relevant' | 'not relevant' | 'unsure';
export type ReviewerRole = 'reviewer1' | 'reviewer2' | 'adjudicator';
export type LabelVotes = Record<string, Record<string, Partial<Record<ReviewerRole, ReviewMark | ''>>>>;

export interface LogEvent {
  time: string;
  actor: string;
  type: string;
  details: Record<string, unknown>;
}

export type Theme = 'light' | 'dark';
