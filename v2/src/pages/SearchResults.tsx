import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Meta, PageHead } from '../components/Layout';
import { useToast } from '../components/Toast';
import { groupFor, highlight, rank, reasonFor, splitTerms, strengthOf } from '../lib/search';
import type { RankedResult, ReviewMark, SearchMethod } from '../lib/types';
import { useAppState } from '../state/AppState';

const MARKS: { value: ReviewMark; label: string }[] = [
  { value: 'relevant', label: 'Relevant' }, { value: 'unsure', label: 'Unsure' }, { value: 'not relevant', label: 'Not relevant' }
];
const STRENGTH_LABEL = { strong: 'Strong match', possible: 'Possible match', weak: 'Weak match' } as const;
type Filter = 'all' | 'unreviewed' | ReviewMark;
const FILTER_LABEL: Record<Filter, string> = { all: 'All', unreviewed: 'To review', relevant: 'Relevant', unsure: 'Unsure', 'not relevant': 'Not relevant' };
const COORDINATORS = ['Transportation Records Coordinator', 'Public Works Records Coordinator', 'Utilities Records Coordinator', 'Clerk Records Coordinator'];

const IndexCard = memo(function IndexCard({ result, index, method, mark, note, onMark, onNote }: {
  result: RankedResult; index: number; method: SearchMethod; mark?: ReviewMark; note: string;
  onMark: (id: string, m: ReviewMark) => void; onNote: (id: string, n: string) => void;
}) {
  const r = result.record;
  const strength = strengthOf(result.score);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const group = groupFor(r);
  const titleId = `t-${r.id}`;
  useEffect(() => setDraft(note), [note]);

  return (
    <article className="card" data-mark={mark ?? 'none'} aria-labelledby={titleId}>
      <div className="card-rank" aria-label={`Rank ${index + 1}`}>{index + 1}</div>
      <div className="card-body">
        <header className="card-head">
          <h3 id={titleId}>{r.title}</h3>
          <span className="strength" data-strength={strength}>{STRENGTH_LABEL[strength]}</span>
        </header>
        <Meta items={[r.department, r.type, <time dateTime={r.date}>{r.date}</time>, r.id, group && <span className="related">Part of: {group}</span>]} />
        <blockquote className="excerpt">
          {highlight(r.text, result.hits).map((s, i) => s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>)}
        </blockquote>
        <p className="why"><span>Why it’s here:</span> {reasonFor(result, method).split(' · ').join(', ')}</p>
        <div className="card-foot">
          <div className="segmented" role="group" aria-label={`Your decision on ${r.title}`}>
            {MARKS.map(m => (
              <button key={m.value} type="button" data-value={m.value} aria-pressed={mark === m.value} onClick={() => onMark(r.id, m.value)}>{m.label}</button>
            ))}
          </div>
          {!editing && <button type="button" className="link-btn" onClick={() => setEditing(true)}>{note ? 'Edit note' : 'Add note'}</button>}
        </div>
        {note && !editing && <p className="note"><span>Note</span> {note}</p>}
        {editing && (
          <form className="note-form" onSubmit={e => { e.preventDefault(); onNote(r.id, draft.trim()); setEditing(false); }}>
            <input aria-label={`Note on ${r.title}`} placeholder="What should the next reviewer know?" value={draft} autoFocus
              onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setDraft(note); setEditing(false); } }} />
            <button type="submit" className="btn btn-quiet">Save note</button>
            <button type="button" className="link-btn" onClick={() => { setDraft(note); setEditing(false); }}>Cancel</button>
          </form>
        )}
      </div>
    </article>
  );
});

export default function SearchResults() {
  const { scenario, plan, marks, notes, setMark, setNote, addEvent } = useAppState();
  const toast = useToast();
  const [method, setMethod] = useState<SearchMethod>('hybrid');
  const [filter, setFilter] = useState<Filter>('all');
  const [routeRecord, setRouteRecord] = useState('');
  const [routeOwner, setRouteOwner] = useState(COORDINATORS[0]!);
  const [routeStatus, setRouteStatus] = useState('');

  const ranked = useMemo(() => ({ hybrid: rank('hybrid', scenario, plan), keyword: rank('keyword', scenario, plan) }), [scenario, plan]);
  const results = ranked[method];
  const top = results.slice(0, 10);
  const reviewed = top.filter(x => marks[x.record.id]).length;
  const count = (f: Filter) => f === 'all' ? top.length : f === 'unreviewed' ? top.length - reviewed : top.filter(x => marks[x.record.id] === f).length;
  const shown = top.map((r, i) => ({ r, i })).filter(({ r }) => filter === 'all' ? true : filter === 'unreviewed' ? !marks[r.record.id] : marks[r.record.id] === filter);

  const logged = useRef(false);
  useEffect(() => {
    if (logged.current) return;
    logged.current = true;
    addEvent('results_viewed', { scenario: scenario.id, request: plan.requestText || scenario.request, method: 'hybrid', result_count: ranked.hybrid.length });
  }, [addEvent, scenario, plan.requestText, ranked.hybrid.length]);
  useEffect(() => { setRouteRecord(top[0]?.record.id ?? ''); }, [method, results]);

  const chooseMethod = (m: SearchMethod) => {
    setMethod(m);
    addEvent('search_method_changed', { scenario: scenario.id, method: m, result_count: ranked[m].length });
  };
  const onMark = (id: string, m: ReviewMark) => setMark(id, m);
  const onNote = (id: string, n: string) => { setNote(id, n); toast(n ? `Note saved on ${id}` : `Note removed from ${id}`); };

  const filters = [['Year', plan.dateFilter], ['Department', plan.departmentFilter], ['Type', plan.recordFilter], ['Repository', plan.repositoryFilter], ['Leaving out', plan.exclusions]]
    .filter(([, v]) => v?.trim()) as [string, string][];

  const route = () => {
    if (!routeRecord) { setRouteStatus('Choose a candidate first.'); return; }
    addEvent('candidate_routed', { record_id: routeRecord, synthetic_coordinator: routeOwner });
    setRouteStatus(`Recorded: ${routeRecord} sent to ${routeOwner}. Nobody was notified.`);
  };

  return (
    <>
      <PageHead title="Review candidates">
        <p className="subject"><span className="subject-label">Request</span> <q>{plan.requestText || scenario.request}</q></p>
        <dl className="plan-summary">
          <div><dt>Terms</dt><dd>{splitTerms(plan.topics).join(', ') || 'None'}</dd></div>
          {method === 'hybrid' && plan.alternateTerms.trim() && <div><dt>Also matching</dt><dd>{splitTerms(plan.alternateTerms).join(', ')}</dd></div>}
          {filters.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          <div><dd><Link to="/">Change the plan</Link></dd></div>
        </dl>
      </PageHead>

      <div className="review-layout">
        <section className="results" aria-labelledby="h-results">
          <div className="results-bar">
            <h2 id="h-results" className="sub-head">{results.length} candidates, top {top.length} shown</h2>
            <div className="method-switch" role="group" aria-label="Search method">
              {(['hybrid', 'keyword'] as SearchMethod[]).map(m => (
                <button key={m} type="button" aria-pressed={method === m} onClick={() => chooseMethod(m)}>
                  {m === 'hybrid' ? 'With alternate terms' : 'Exact keywords only'} <span className="count">{ranked[m].length}</span>
                </button>
              ))}
            </div>
          </div>

          <div aria-live="polite">
            {shown.map(({ r, i }) => (
              <IndexCard key={r.record.id} result={r} index={i} method={method} mark={marks[r.record.id]} note={notes[r.record.id] ?? ''} onMark={onMark} onNote={onNote} />
            ))}
          </div>
          {!results.length && <div className="empty"><p>No records match this plan.</p><Link to="/">Change the plan</Link> or remove a filter.</div>}
          {results.length > 0 && !shown.length && <div className="empty"><p>Nothing in “{FILTER_LABEL[filter]}” yet.</p><button type="button" className="link-btn" onClick={() => setFilter('all')}>Show all candidates</button></div>}
          <p className="fine">Ranking helps staff find records faster. It is not a decision on responsiveness, exemption or release.</p>
          <Link className="btn btn-primary" to="/evaluation">Go to evaluation</Link>
        </section>

        <aside className="review-panel" aria-label="Review progress and routing">
          <section aria-labelledby="h-progress">
            <h2 id="h-progress" className="sub-head">Your review</h2>
            <p className="progress-num"><strong>{reviewed}</strong> of {top.length} decided</p>
            <progress max={top.length || 1} value={reviewed} aria-label="Candidates decided" />
            <div className="filter-list" role="group" aria-label="Show candidates">
              {(['all', 'unreviewed', 'relevant', 'unsure', 'not relevant'] as Filter[]).map(f => (
                <button key={f} type="button" data-filter={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  <span>{FILTER_LABEL[f]}</span><span className="count">{count(f)}</span>
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby="h-route" className="route">
            <h2 id="h-route" className="sub-head">Send to a coordinator</h2>
            <p className="muted small">Practice only. This records an event in the log; nobody is notified.</p>
            <label htmlFor="route-record">Candidate</label>
            <select id="route-record" value={routeRecord} onChange={e => setRouteRecord(e.target.value)}>
              {top.map(x => <option key={x.record.id} value={x.record.id}>{x.record.id}: {x.record.title}</option>)}
            </select>
            <label htmlFor="route-owner">Coordinator</label>
            <select id="route-owner" value={routeOwner} onChange={e => setRouteOwner(e.target.value)}>
              {COORDINATORS.map(c => <option key={c}>{c}</option>)}
            </select>
            <button type="button" className="btn btn-quiet btn-block" onClick={route}>Record the hand-off</button>
            <p className="status-line" role="status" aria-live="polite">{routeStatus}</p>
          </section>
        </aside>
      </div>
    </>
  );
}
