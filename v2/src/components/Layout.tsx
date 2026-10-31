import { useEffect, useRef, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { THEMES, useAppState } from '../state/AppState';

const STEPS = [
  { to: '/', label: 'Plan the search', short: 'Plan', end: true },
  { to: '/search', label: 'Review candidates', short: 'Review', end: false },
  { to: '/evaluation', label: 'Evaluate', short: 'Evaluate', end: false }
];

const TITLES: Record<string, string> = { '/': 'Plan the search', '/search': 'Review candidates', '/evaluation': 'Evaluate' };

export function Layout() {
  const { theme, setTheme, plan } = useAppState();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Client-side navigation: update the title and move focus to the new page.
  useEffect(() => {
    document.title = `${TITLES[pathname] ?? 'Page'} | Public Records Search`;
    window.scrollTo(0, 0);
    if (first.current) { first.current = false; return; }
    main.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to main content</a>
      <header className="masthead">
        <div className="wordmark">
          <svg className="wordmark-icon" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M3 9.5h10l2.5 3H29v14.5H3z" fill="var(--manila)" stroke="var(--manila-edge)" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M3 13.5h26" stroke="var(--manila-edge)" strokeWidth="1.5" />
          </svg>
          <span>Public Records Search</span>
          <span className="badge">Synthetic demo</span>
        </div>
        <div className="mode-switch" role="group" aria-label="Colour mode">
          {THEMES.map(t => (
            <button key={t.id} type="button" aria-pressed={theme === t.id} onClick={() => setTheme(t.id)}>{t.label}</button>
          ))}
        </div>
      </header>

      <nav className="tabs-nav" aria-label="Workflow steps">
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.to}>
              <NavLink to={s.to} end={s.end} className="folder-tab">
                <span className="tab-num" aria-hidden="true">{i === 0 && plan.confirmed && pathname !== '/' ? '✓' : i + 1}</span>
                <span className="long">{s.label}</span>
                <span className="short" aria-hidden="true">{s.short}</span>
              </NavLink>
            </li>
          ))}
        </ol>
      </nav>

      <main className="folder" id="main" tabIndex={-1} ref={main}>
        <Outlet />
      </main>
      <footer className="colophon">
        A City Clerk staff demo built on invented requests and synthetic records. No city systems, real records or AI services are connected.
      </footer>
    </div>
  );
}

/** Page heading inside the open folder. */
export function PageHead({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {children}
      </div>
      {aside}
    </div>
  );
}

export function SectionHead({ title, id, note, step }: { title: string; id?: string; note?: ReactNode; step?: number }) {
  return (
    <div className="section-head">
      <h2 id={id}>{step !== undefined && <span className="section-step" aria-hidden="true">{step}</span>}{title}</h2>
      {note && <p className="section-note">{note}</p>}
    </div>
  );
}

/** Metadata as separate items, not a joined string. */
export function Meta({ items }: { items: ReactNode[] }) {
  return <ul className="meta">{items.filter(Boolean).map((x, i) => <li key={i}>{x}</li>)}</ul>;
}
