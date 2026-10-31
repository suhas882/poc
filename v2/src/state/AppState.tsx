import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { scenarios } from '../data/scenarios';
import { CLARIFICATION_DRAFT } from '../lib/search';
import { KEYS, load, remove, save } from '../lib/storage';
import type { LabelVotes, LogEvent, ReviewMark, ReviewerRole, Scenario, SearchPlan, Theme } from '../lib/types';

export const ACTORS = ['Clerk reviewer A', 'Clerk reviewer B', 'Records coordinator'] as const;
export const THEMES: { id: Theme; label: string }[] = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

export function planFromScenario(s: Scenario): SearchPlan {
  return {
    requestText: s.request, topics: s.topics, alternateTerms: s.alternate ?? '', peopleOrgs: '',
    dateFilter: s.date ?? '', departmentFilter: '', recordFilter: '', repositoryFilter: '', exclusions: '',
    clarificationQuestions: s.needsClarification ? CLARIFICATION_DRAFT : '', confirmed: false
  };
}

const findScenario = (id: string) => scenarios.find(s => s.id === id) ?? scenarios[0]!;

export function initialTheme(): Theme {
  const t = load<string>(KEYS.theme, '');
  if (t === 'light' || t === 'dark') return t;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
}

interface AppState {
  scenario: Scenario;
  plan: SearchPlan;
  actor: string;
  theme: Theme;
  events: LogEvent[];
  marks: Record<string, ReviewMark>;
  notes: Record<string, string>;
  labelVotes: LabelVotes;
  selectScenario: (id: string) => void;
  updatePlan: (patch: Partial<SearchPlan>) => void;
  setActor: (a: string) => void;
  setTheme: (t: Theme) => void;
  addEvent: (type: string, details?: Record<string, unknown>) => void;
  setMark: (recordId: string, mark: ReviewMark) => void;
  setNote: (recordId: string, note: string) => void;
  setLabel: (scenarioId: string, recordId: string, role: ReviewerRole, value: ReviewMark | '') => void;
  clearSession: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [scenarioId, setScenarioId] = useState(() => findScenario(load(KEYS.scenario, scenarios[0]!.id)).id);
  const scenario = findScenario(scenarioId);
  const [plan, setPlan] = useState<SearchPlan>(() => ({ ...planFromScenario(scenario), ...load<Partial<SearchPlan>>(KEYS.plan, {}) }));
  const [actor, setActorState] = useState(() => load<string>(KEYS.actor, ACTORS[0]));
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [events, setEvents] = useState<LogEvent[]>(() => load(KEYS.events, []));
  const [marks, setMarks] = useState<Record<string, ReviewMark>>(() => load(KEYS.marks, {}));
  const [notes, setNotes] = useState<Record<string, string>>(() => load(KEYS.notes, {}));
  const [labelVotes, setLabelVotes] = useState<LabelVotes>(() => load(KEYS.labels, {}));

  // Persist each slice when it changes.
  useEffect(() => save(KEYS.scenario, scenarioId), [scenarioId]);
  useEffect(() => save(KEYS.plan, plan), [plan]);
  useEffect(() => save(KEYS.actor, actor), [actor]);
  useEffect(() => save(KEYS.events, events), [events]);
  useEffect(() => save(KEYS.marks, marks), [marks]);
  useEffect(() => save(KEYS.notes, notes), [notes]);
  useEffect(() => save(KEYS.labels, labelVotes), [labelVotes]);
  useEffect(() => { document.documentElement.dataset.theme = theme; save(KEYS.theme, theme); }, [theme]);

  const addEvent = useCallback((type: string, details: Record<string, unknown> = {}) => {
    setEvents(prev => [...prev, { time: new Date().toISOString(), actor, type, details }]);
  }, [actor]);

  const value = useMemo<AppState>(() => ({
    scenario, plan, actor, theme, events, marks, notes, labelVotes,
    selectScenario: id => {
      const next = findScenario(id);
      setScenarioId(next.id);
      setPlan(planFromScenario(next));
      addEvent('scenario_selected', { scenario: next.id });
    },
    updatePlan: patch => setPlan(prev => ({ ...prev, ...patch })),
    setActor: setActorState,
    setTheme: setThemeState,
    addEvent,
    setMark: (recordId, mark) => {
      setMarks(prev => ({ ...prev, [recordId]: mark }));
      addEvent('candidate_review_marked', { record_id: recordId, mark });
    },
    setNote: (recordId, note) => {
      setNotes(prev => ({ ...prev, [recordId]: note }));
      addEvent('candidate_note_saved', { record_id: recordId });
    },
    setLabel: (sid, rid, role, v) => {
      setLabelVotes(prev => ({ ...prev, [sid]: { ...prev[sid], [rid]: { ...prev[sid]?.[rid], [role]: v } } }));
      addEvent('label_record_saved', { scenario: sid, record_id: rid, reviewer_role: role, label: v });
    },
    clearSession: () => {
      setEvents([]); setMarks({}); setNotes({});
      remove(KEYS.events, KEYS.marks, KEYS.notes);
    }
  }), [scenario, plan, actor, theme, events, marks, notes, labelVotes, addEvent]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider');
  return ctx;
}
