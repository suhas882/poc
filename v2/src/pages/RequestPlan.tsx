import { useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { records } from '../data/records';
import { scenarios } from '../data/scenarios';
import { PageHead, SectionHead } from '../components/Layout';
import { CLARIFICATION_DRAFT, draftTopics, isBroadRequest, repositories, splitTerms, suggestedConcepts } from '../lib/search';
import { ACTORS, useAppState } from '../state/AppState';
import type { SearchPlan } from '../lib/types';

/** Shows how the plan's terms fan out into alternates, and lets staff add or remove them. */
function TermExpansion() {
  const { scenario, plan, updatePlan } = useAppState();
  const request = plan.requestText.trim() || scenario.request;
  const custom = request !== scenario.request;
  const terms = splitTerms(plan.topics.trim() || scenario.topics || request);
  const inPlan = splitTerms(plan.alternateTerms);
  const suggestions = suggestedConcepts(terms.join(', ')).filter(s => !inPlan.some(x => x.toLowerCase() === s.toLowerCase()));
  const remove = (t: string) => updatePlan({ alternateTerms: inPlan.filter(x => x !== t).join(', '), confirmed: false });
  const add = (t: string) => updatePlan({ alternateTerms: [...inPlan, t].join(', '), confirmed: false });
  const example = records.find(r => r.id === scenario.relevant[0]);

  return (
    <section className="expansion" aria-labelledby="h-expansion">
      <h2 id="h-expansion" className="sub-head">How the search widens</h2>
      <div className="expansion-row">
        <span className="expansion-label">Searches for</span>
        <div className="chips">{terms.length ? terms.map(t => <span key={t} className="chip chip-term">{t}</span>) : <span className="muted">Add topics to the plan</span>}</div>
      </div>
      <div className="expansion-row">
        <span className="expansion-label">Also matches</span>
        <div className="chips">
          {inPlan.map(t => (
            <button key={t} type="button" className="chip chip-alt" onClick={() => remove(t)} aria-label={`Remove ${t} from alternate terms`}>
              {t}<span aria-hidden="true" className="chip-x">×</span>
            </button>
          ))}
          {!inPlan.length && <span className="muted">No alternate terms yet</span>}
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="expansion-row">
          <span className="expansion-label">Suggested</span>
          <div className="chips">
            {suggestions.map(t => (
              <button key={t} type="button" className="chip chip-suggest" onClick={() => add(t)} aria-label={`Add ${t} to alternate terms`}>
                <span aria-hidden="true">+</span> {t}
              </button>
            ))}
          </div>
        </div>
      )}
      <p className="expansion-foot">
        {custom
          ? 'You edited the request, so candidates will appear after you search.'
          : example ? <>A labeled record for this request: <cite>{example.title}</cite></> : 'This request has no labeled example.'}
      </p>
    </section>
  );
}

type FieldKey = keyof Omit<SearchPlan, 'confirmed'>;
const FIELDS: { key: FieldKey; label: string; placeholder: string; hint?: string }[] = [
  { key: 'topics', label: 'Topics and terms', placeholder: 'road closure, right-of-way work', hint: 'Separate terms with commas.' },
  { key: 'alternateTerms', label: 'Alternate terms', placeholder: 'Other words people use for the same thing' },
  { key: 'peopleOrgs', label: 'People or organizations', placeholder: 'Optional' },
  { key: 'dateFilter', label: 'Year', placeholder: 'Optional, for example 2024' },
  { key: 'departmentFilter', label: 'Department', placeholder: 'Optional, for example Transportation' },
  { key: 'recordFilter', label: 'Record type', placeholder: 'Optional, for example email' }
];

export default function RequestPlan() {
  const { scenario, plan, updatePlan, selectScenario, actor, setActor, addEvent } = useAppState();
  const navigate = useNavigate();
  const [error, setError] = useState<{ field: 'topics' | 'confirm'; text: string } | null>(null);
  const [showClarification, setShowClarification] = useState(Boolean(scenario.needsClarification));
  const topicsRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const field = (key: FieldKey) => ({ id: key, value: plan[key], onChange: (e: { target: { value: string } }) => updatePlan({ [key]: e.target.value, confirmed: false }) });

  const draft = () => {
    const broad = isBroadRequest(plan.requestText);
    const patch: Partial<SearchPlan> = { confirmed: false };
    if (!plan.topics.trim()) patch.topics = draftTopics(plan.requestText);
    if (broad && !plan.clarificationQuestions) patch.clarificationQuestions = CLARIFICATION_DRAFT;
    updatePlan(patch);
    setShowClarification(broad);
    addEvent('plan_drafted', { topics: patch.topics ?? plan.topics, clarification_draft: broad });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!plan.topics.trim()) { setError({ field: 'topics', text: 'Add at least one topic before searching.' }); topicsRef.current?.focus(); return; }
    if (!plan.confirmed) { setError({ field: 'confirm', text: 'Confirm you have reviewed the plan before searching.' }); confirmRef.current?.focus(); return; }
    setError(null);
    const filters = { date: plan.dateFilter, department: plan.departmentFilter, record_type: plan.recordFilter, repository: plan.repositoryFilter, exclusions: plan.exclusions };
    addEvent('plan_confirmed', { scenario: scenario.id, request: plan.requestText, plan });
    addEvent('search_run', { scenario: scenario.id, request: plan.requestText, plan, filters, method: 'hybrid', corpus: 'Synthetic demo corpus' });
    navigate('/search');
  };

  return (
    <>
      <PageHead title="Plan the search">
        <p className="lead">Pick an invented request, shape the search plan, and confirm it. The tool only ranks candidates; staff decide what is responsive.</p>
      </PageHead>

      <form className="plan-layout" onSubmit={submit} noValidate>
        <div className="plan-side">
          <section aria-labelledby="h-request">
            <SectionHead title="Request" id="h-request" step={1} />
            <label htmlFor="request-select">Example request</label>
            <select id="request-select" value={scenario.id} onChange={e => { selectScenario(e.target.value); setShowClarification(Boolean(scenarios.find(s => s.id === e.target.value)?.needsClarification)); setError(null); }}>
              {['Exact keyword', 'Different wording', 'Vague request'].map(type => (
                <optgroup key={type} label={type}>
                  {scenarios.filter(s => s.type === type).map(s => <option key={s.id} value={s.id}>{s.label.replace(/^.*?·\s*/, '')}</option>)}
                </optgroup>
              ))}
            </select>
            <label htmlFor="request-text">What the requester asked for</label>
            <textarea id="request-text" className="request-text" rows={4} value={plan.requestText} onChange={e => updatePlan({ requestText: e.target.value, confirmed: false })} />
            <div className="row-actions">
              <button type="button" className="btn btn-quiet" onClick={draft}>Draft plan from request</button>
              <span className="type-tag" data-type={scenario.type}>{scenario.type}</span>
            </div>
          </section>
          <TermExpansion />
        </div>

        <section className="plan-sheet" aria-labelledby="h-plan">
          <SectionHead title="Search plan" id="h-plan" step={2} note="Drafted by local rules. Change anything before you confirm." />
          <div className="ledger">
            {FIELDS.map(f => (
              <div className="ledger-row" key={f.key}>
                <label htmlFor={f.key}>{f.label}{f.key === 'topics' && <span className="req"> (required)</span>}</label>
                <div>
                  <input {...field(f.key)} ref={f.key === 'topics' ? topicsRef : undefined} placeholder={f.placeholder}
                    aria-invalid={error?.field === 'topics' && f.key === 'topics' ? true : undefined}
                    aria-describedby={error?.field === 'topics' && f.key === 'topics' ? errorId : undefined} />
                  {f.hint && <p className="hint">{f.hint}</p>}
                </div>
              </div>
            ))}
            <div className="ledger-row">
              <label htmlFor="repositoryFilter">Repository</label>
              <select {...field('repositoryFilter')}>
                <option value="">All synthetic repositories</option>
                {repositories.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
            <div className="ledger-row">
              <label htmlFor="exclusions">Leave out</label>
              <input {...field('exclusions')} placeholder="Terms that rule a record out" />
            </div>
            <div className="ledger-row">
              <label htmlFor="demo-actor">Acting as</label>
              <select id="demo-actor" value={actor} onChange={e => setActor(e.target.value)}>
                {ACTORS.map(a => <option key={a}>{a}</option>)}
              </select>
            </div>
          </div>

          {showClarification && (
            <div className="clarify">
              <label htmlFor="clarificationQuestions">This request is broad. Questions to ask the requester:</label>
              <textarea {...field('clarificationQuestions')} rows={4} />
              <p className="hint">A draft for staff to edit. Nothing is sent from this demo.</p>
            </div>
          )}

          <div className="confirm-block">
            <label className={`confirm${plan.confirmed ? ' is-on' : ''}`}>
              <input ref={confirmRef} type="checkbox" checked={plan.confirmed}
                onChange={e => { updatePlan({ confirmed: e.target.checked }); setError(null); }}
                aria-describedby={error?.field === 'confirm' ? errorId : undefined} />
              <span>I reviewed this plan and want to search the synthetic records.</span>
            </label>
            {error && <p className="form-error" id={errorId} role="alert">{error.text}</p>}
            <div className="row-actions">
              <button type="submit" className="btn btn-primary">Search records</button>
              <span className="muted small">Searches 18 synthetic records on this device.</span>
            </div>
          </div>
        </section>
      </form>
    </>
  );
}
