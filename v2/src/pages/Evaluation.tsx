import { useState } from 'react';
import { records } from '../data/records';
import { scenarios } from '../data/scenarios';
import { PageHead, SectionHead } from '../components/Layout';
import { compareMethods, runFullEvaluation, type FullEvaluation, type MethodComparison } from '../lib/evaluation';
import { labelWorksheetCsv, statusFor } from '../lib/labels';
import { download } from '../lib/storage';
import type { ReviewMark, ReviewerRole, SearchMethod } from '../lib/types';
import { useAppState } from '../state/AppState';

const SECTIONS = [['compare', 'This request'], ['all', 'All 18 requests'], ['labels', 'Label worksheet'], ['log', 'Activity log'], ['a11y', 'Accessibility check']] as const;
const METHOD_LABEL: Record<SearchMethod, string> = { hybrid: 'With alternate terms', keyword: 'Exact keywords only' };
const pct = (n: number) => `${n}%`;
const ms = (n: number | null) => n === null ? 'Not found' : `${n.toFixed(1)} ms`;

interface Row { r10: number; p10: number; r50: number; p50: number; first: string; time: string }

function Bar({ value, tone }: { value: number; tone: SearchMethod }) {
  return <span className="bar" data-tone={tone} aria-hidden="true"><span style={{ width: `${Math.min(100, value)}%` }} /></span>;
}

function CompareTable({ rows, caption }: { rows: { tone: SearchMethod; m: Row }[]; caption: string }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr><th scope="col">Method</th><th scope="col">Recall, top 10</th><th scope="col">Precision, top 10</th><th scope="col">Recall, top 50</th><th scope="col">Precision, top 50</th><th scope="col">First labeled record</th><th scope="col">Ranking time</th></tr></thead>
        <tbody>
          {rows.map(({ tone, m }) => (
            <tr key={tone} data-tone={tone}>
              <th scope="row"><span className="swatch" data-tone={tone} aria-hidden="true" />{METHOD_LABEL[tone]}</th>
              <td><span className="num">{pct(m.r10)}</span><Bar value={m.r10} tone={tone} /></td>
              <td><span className="num">{pct(m.p10)}</span><Bar value={m.p10} tone={tone} /></td>
              <td><span className="num">{pct(m.r50)}</span><Bar value={m.r50} tone={tone} /></td>
              <td><span className="num">{pct(m.p50)}</span><Bar value={m.p50} tone={tone} /></td>
              <td className="num">{m.first}</td>
              <td className="num">{m.time}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const rowFrom = (c: MethodComparison): Row => ({ r10: c.at10.recall, p10: c.at10.precision, r50: c.at50.recall, p50: c.at50.precision, first: c.at10.firstRank ? `Rank ${c.at10.firstRank}` : 'Not found', time: ms(c.timeToFirstMs) });

function CurrentComparison() {
  const { scenario, plan, addEvent } = useAppState();
  const [result, setResult] = useState<ReturnType<typeof compareMethods> | null>(null);
  const run = () => {
    const r = compareMethods(scenario, plan);
    setResult(r);
    const flat = (c: MethodComparison) => ({ recall_at10: pct(c.at10.recall), precision_at10: pct(c.at10.precision), recall_at50: pct(c.at50.recall), precision_at50: pct(c.at50.precision), first_relevant_rank: c.at10.firstRank ? `Rank ${c.at10.firstRank}` : 'Not found', time_to_first_relevant_ms: ms(c.timeToFirstMs) });
    addEvent('comparison_run', { scenario: scenario.id, keyword: flat(r.keyword), hybrid: flat(r.hybrid) });
  };
  const figures: [string, string, (c: MethodComparison) => number][] = [
    ['Recall', 'top 10', c => c.at10.recall], ['Precision', 'top 10', c => c.at10.precision],
    ['Recall', 'top 50', c => c.at50.recall], ['Precision', 'top 50', c => c.at50.precision]
  ];

  return (
    <section className="eval-section" id="compare" aria-labelledby="h-compare">
      <SectionHead title="This request" id="h-compare" note={<>Compares the two search methods on <q>{scenario.label.replace(/^.*?·\s*/, '')}</q>, using your saved plan.</>} />
      <div className="figures">
        {figures.map(([name, cut, get]) => {
          const h = result ? get(result.hybrid) : null, k = result ? get(result.keyword) : null;
          const delta = h !== null && k !== null ? h - k : null;
          return (
            <div className="figure" key={name + cut}>
              <p className="figure-name">{name} <span>{cut}</span></p>
              <p className="figure-value">{h === null ? '–' : pct(h)}</p>
              <p className="figure-sub">
                {k === null ? 'Not run yet' : <>Exact keywords: {pct(k)}{delta ? <span className="delta" data-up={delta > 0}>{delta > 0 ? '+' : '−'}{Math.abs(delta)} points</span> : null}</>}
              </p>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn btn-quiet" onClick={run}>{result ? 'Compare again' : 'Compare methods'}</button>
      {result && <CompareTable caption="Method comparison for this request" rows={[{ tone: 'hybrid', m: rowFrom(result.hybrid) }, { tone: 'keyword', m: rowFrom(result.keyword) }]} />}
      <p className="fine">Synthetic labels only; these are targets to validate during discovery. Top 50 covers all 18 records. Ranking time is computer time, not staff time.</p>
    </section>
  );
}

function FullEvaluationSection() {
  const { addEvent } = useAppState();
  const [result, setResult] = useState<FullEvaluation | null>(null);
  const run = () => {
    const r = runFullEvaluation();
    setResult(r);
    addEvent('full_evaluation_completed', { scenario_count: r.scenario_count, corpus_size: r.corpus_size, metrics: ['recall@10', 'precision@10', 'recall@50', 'precision@50', 'first relevant rank', 'time to first relevant result'] });
  };
  return (
    <section className="eval-section" id="all" aria-labelledby="h-all">
      <SectionHead title="All 18 requests" id="h-all" note="Averages for each kind of request: exact keywords, different wording, and vague asks." />
      <div className="row-actions">
        <button type="button" className="btn btn-quiet" onClick={run}>{result ? 'Run again' : 'Run all requests'}</button>
        <button type="button" className="btn btn-quiet" disabled={!result} onClick={() => result && download(JSON.stringify(result, null, 2), 'synthetic-full-evaluation.json', 'application/json')}>Download results (JSON)</button>
      </div>
      {result && (
        <>
          {Object.entries(result.groups).map(([type, g]) => (
            <div key={type} className="group">
              <h3>{type} <span className="muted">{g.hybrid.count} requests</span></h3>
              <CompareTable caption={`${type} averages`} rows={(['hybrid', 'keyword'] as SearchMethod[]).map(m => ({
                tone: m,
                m: { r10: g[m].recallAt10, p10: g[m].precisionAt10, r50: g[m].recallAt50, p50: g[m].precisionAt50, first: g[m].meanFirstRank === null ? 'Not found' : `Rank ${g[m].meanFirstRank} on average`, time: ms(g[m].meanTimeToFirstMs) }
              }))} />
            </div>
          ))}
          <details className="disclosure">
            <summary>Results for each request</summary>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Results for each request">
              <table className="data-table compact">
                <thead><tr><th scope="col">Request</th><th scope="col">Method</th><th scope="col">Recall 10</th><th scope="col">Precision 10</th><th scope="col">Recall 50</th><th scope="col">Precision 50</th><th scope="col">First rank</th><th scope="col">Time</th></tr></thead>
                <tbody>
                  {result.scenarios.flatMap(c => (['keyword', 'hybrid'] as SearchMethod[]).map(m => (
                    <tr key={c.id + m}><td>{c.label}</td><td>{METHOD_LABEL[m]}</td><td className="num">{pct(c.methods[m].at10.recall)}</td><td className="num">{pct(c.methods[m].at10.precision)}</td><td className="num">{pct(c.methods[m].at50.recall)}</td><td className="num">{pct(c.methods[m].at50.precision)}</td><td className="num">{c.methods[m].at10.firstRank ?? 'Not found'}</td><td className="num">{ms(c.methods[m].timeToFirstMs)}</td></tr>
                  )))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="fine">{result.notice}</p>
        </>
      )}
    </section>
  );
}

const ROLES: { id: ReviewerRole; label: string }[] = [{ id: 'reviewer1', label: 'Reviewer 1' }, { id: 'reviewer2', label: 'Reviewer 2' }, { id: 'adjudicator', label: 'Adjudicator' }];

function LabelWorksheet() {
  const { labelVotes, setLabel, scenario: active } = useAppState();
  const [sid, setSid] = useState(active.id);
  const [role, setRole] = useState<ReviewerRole>('reviewer1');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const scenario = scenarios.find(s => s.id === sid) ?? scenarios[0]!;
  const votes = labelVotes[sid] ?? {};
  const marked = records.filter(r => votes[r.id]?.[role]).length;
  const roleLabel = ROLES.find(r => r.id === role)!.label;
  const rows = records.filter(r => !onlyOpen || !votes[r.id]?.[role]);
  const differences = role === 'adjudicator' ? records.filter(r => statusFor(labelVotes, sid, r.id) === 'Difference').length : 0;

  return (
    <section className="eval-section" id="labels" aria-labelledby="h-labels">
      <SectionHead title="Label worksheet" id="h-labels" note="Two reviewers label each record on their own, then an adjudicator settles differences. This demo can’t check who is who or that reviews were independent." />
      <div className="worksheet-controls">
        <div>
          <label htmlFor="label-scenario">Request</label>
          <select id="label-scenario" value={sid} onChange={e => setSid(e.target.value)}>
            {scenarios.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <span className="field-label" id="role-label">Working as</span>
          <div className="segmented" role="group" aria-labelledby="role-label">
            {ROLES.map(r => <button key={r.id} type="button" aria-pressed={role === r.id} onClick={() => setRole(r.id)}>{r.label}</button>)}
          </div>
        </div>
      </div>
      <div className="worksheet-status">
        <span><strong>{marked}</strong> of {records.length} labeled</span>
        <progress max={records.length} value={marked} aria-label="Records labeled" />
        {differences > 0 && <span className="pill pill-bad">{differences} to settle</span>}
        <label className="check"><input type="checkbox" checked={onlyOpen} onChange={e => setOnlyOpen(e.target.checked)} /> Hide labeled records</label>
      </div>
      <div className="table-scroll tall" tabIndex={0} role="region" aria-label="Label worksheet">
        <table className="data-table worksheet">
          <thead><tr><th scope="col">Record</th><th scope="col">{role === 'adjudicator' ? 'Final label' : `${roleLabel} label`}</th><th scope="col">Example label</th><th scope="col">Agreement</th></tr></thead>
          <tbody>
            {rows.map(r => {
              const status = role === 'adjudicator' ? statusFor(labelVotes, sid, r.id) : null;
              return (
                <tr key={r.id}>
                  <td><span className="rec-id">{r.id}</span> {r.title}<span className="rec-meta">{r.department}, {r.type.toLowerCase()}, {r.date}</span></td>
                  <td>
                    <select aria-label={`${role === 'adjudicator' ? 'Final' : roleLabel} label for ${r.title}`} value={votes[r.id]?.[role] ?? ''}
                      onChange={e => setLabel(sid, r.id, role, e.target.value as ReviewMark | '')}>
                      <option value="">Not labeled</option><option value="relevant">Relevant</option><option value="not relevant">Not relevant</option><option value="unsure">Unsure</option>
                    </select>
                  </td>
                  <td>{role === 'adjudicator' ? (scenario.relevant.includes(r.id) ? 'Relevant' : 'Not relevant') : <span className="muted">Hidden while labeling</span>}</td>
                  <td>{status ? <span className="pill" data-status={status}>{status === 'Pending' ? 'Waiting' : status === 'Difference' ? 'Differs' : 'Agree'}</span> : <span className="muted">Adjudicator only</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <div className="empty"><p>Every record is labeled in this view.</p></div>}
      </div>
      <button type="button" className="btn btn-quiet" onClick={() => download(labelWorksheetCsv(labelVotes), 'synthetic-label-review.csv', 'text/csv;charset=utf-8')}>Download worksheet (CSV)</button>
    </section>
  );
}

function ActivityLog() {
  const { events, addEvent, clearSession, scenario } = useAppState();
  const exportLog = () => {
    addEvent('log_exported', { event_count: events.length });
    download(JSON.stringify({ notice: 'Synthetic local POC event log. Not a legal search declaration.', exported_at: new Date().toISOString(), scenario: scenario.id, events }, null, 2), 'public-records-search-log.json', 'application/json');
  };
  const recent = events.slice(-12).reverse();
  return (
    <section className="eval-section" id="log" aria-labelledby="h-log">
      <SectionHead title="Activity log" id="h-log" note="Every search, decision and hand-off in this browser. A working draft, not an official diligent-search record." />
      {recent.length ? (
        <ol className="log" aria-label={`${events.length} events, most recent first`}>
          {recent.map((e, i) => (
            <li key={e.time + i}>
              <time dateTime={e.time}>{new Date(e.time).toLocaleTimeString()}</time>
              <span className="log-type">{e.type.replace(/_/g, ' ')}</span>
              <span className="log-actor">{e.actor}</span>
              <code className="log-detail">{JSON.stringify(e.details)}</code>
            </li>
          ))}
        </ol>
      ) : <div className="empty"><p>No activity yet. Run a search to start the log.</p></div>}
      <div className="row-actions">
        <button type="button" className="btn btn-quiet" disabled={!events.length} onClick={exportLog}>Download log (JSON)</button>
        <span className="muted small">{events.length} event{events.length === 1 ? '' : 's'}{events.length > 12 ? ', latest 12 shown' : ''}</span>
        <button type="button" className="link-btn push-right" onClick={clearSession}>Clear log and decisions</button>
      </div>
    </section>
  );
}

function AccessibilityCheck() {
  const { addEvent } = useAppState();
  const [msg, setMsg] = useState('');
  const run = () => {
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')];
    const unlabeled = fields.filter(el => !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.labels && el.labels.length));
    const buttons = [...document.querySelectorAll('button')];
    const unnamed = buttons.filter(el => !el.getAttribute('aria-label') && !el.textContent?.trim());
    const h1 = document.querySelectorAll('h1').length;
    const issues: string[] = [];
    if (unlabeled.length) issues.push(`${unlabeled.length} form controls lack a label`);
    if (unnamed.length) issues.push(`${unnamed.length} buttons lack accessible names`);
    if (h1 !== 1) issues.push(`Expected one page heading, found ${h1}`);
    setMsg(`${issues.length ? `Found: ${issues.join('; ')}.` : `Passed for ${fields.length} fields, ${buttons.length} buttons and one page heading.`} This is not a SureAccess result or a conformance finding.`);
    addEvent('basic_accessibility_self_check', { fields: fields.length, buttons: buttons.length, issues });
  };
  return (
    <section className="eval-section" id="a11y" aria-labelledby="h-a11y">
      <SectionHead title="Accessibility check" id="h-a11y" note="Checks labels, button names and headings on this page only." />
      <div className="row-actions">
        <button type="button" className="btn btn-quiet" onClick={run}>Check this page</button>
        <p className="status-line" role="status" aria-live="polite">{msg}</p>
      </div>
    </section>
  );
}

export default function Evaluation() {
  return (
    <>
      <PageHead title="Evaluate">
        <p className="lead">See how often each search method surfaces the labeled records, label records yourself, and download the activity log. All figures come from 18 invented requests; none describe Bellevue records.</p>
      </PageHead>
      <div className="eval-layout">
        <nav className="contents" aria-label="On this page">
          <ul>{SECTIONS.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul>
        </nav>
        <div className="eval-body">
          <CurrentComparison />
          <FullEvaluationSection />
          <LabelWorksheet />
          <ActivityLog />
          <AccessibilityCheck />
        </div>
      </div>
    </>
  );
}
