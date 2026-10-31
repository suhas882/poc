import { records } from '../data/records';
import { scenarios } from '../data/scenarios';
import type { LabelVotes } from './types';

export type ReviewStatus = 'Agreement' | 'Difference' | 'Pending';

export function statusFor(votes: LabelVotes, scenarioId: string, recordId: string): ReviewStatus {
  const v = votes[scenarioId]?.[recordId];
  if (!v?.reviewer1 || !v?.reviewer2) return 'Pending';
  return v.reviewer1 === v.reviewer2 ? 'Agreement' : 'Difference';
}

/** CSV of every request-record pair, matching the v1 worksheet columns. */
export function labelWorksheetCsv(votes: LabelVotes): string {
  const header = ['scenario_id', 'request_type', 'request_text', 'record_id', 'record_title', 'reviewer_1_label', 'reviewer_2_label', 'adjudicated_label', 'provisional_example_label', 'review_status'];
  const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(q).join(',')];
  for (const s of scenarios) for (const r of records) {
    const v = votes[s.id]?.[r.id] ?? {};
    lines.push([s.id, s.type, s.request, r.id, r.title, v.reviewer1 ?? '', v.reviewer2 ?? '', v.adjudicator ?? '',
      s.relevant.includes(r.id) ? 'relevant' : 'not relevant', statusFor(votes, s.id, r.id)].map(q).join(','));
  }
  return lines.join('\r\n');
}
