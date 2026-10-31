// Shared page frame: navy sidebar with the seven pages, top bar with the page title and the "Staff decide" badge,
// signed-in user (with a role switcher in the demo), and the Tier 0 / real-data banner.
import { authStatus, can, post, signOut, type AuthStatus } from './api.js';
import { $, h, replace, ROLE_LABEL, toast } from './ui.js';

export type Mode = 'demo' | 'real';
const MODE_KEY = 'prs-mode';

export const NAV: { href: string; label: string; page: string; icon: string; perm?: string }[] = [
  { href: '/', label: 'Request & Plan', page: 'request', icon: '▣' },
  { href: '/search.html', label: 'Search Results', page: 'search', icon: '≡' },
  { href: '/sources.html', label: 'Connected Sources', page: 'sources', icon: '⛁' },
  { href: '/history.html', label: 'Search History', page: 'history', icon: '↺' },
  { href: '/evaluation.html', label: 'Evaluation', page: 'evaluation', icon: '▲' },
  { href: '/audit.html', label: 'Audit Logs', page: 'audit', icon: '✓', perm: 'audit.read' },
  { href: '/settings.html', label: 'Settings', page: 'settings', icon: '⚙' }
];

let status: AuthStatus | null = null;

/** Which data new requests use: the Tier 0 demo corpus, or real sources (only when the server allows them). */
export function currentMode(): Mode {
  if (!status?.realSources || status.user?.isDemo) return 'demo';
  try { return localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'demo'; } catch { return 'demo'; }
}

/** Render the frame and return the auth status. Every page except sign-in needs a signed-in user. */
export async function initShell(opts: { title?: string } = {}): Promise<AuthStatus> {
  status = await authStatus();
  const page = document.body.dataset.page || '';
  const here = location.pathname + location.search;

  if (!status.user) {
    location.replace(`/login.html?next=${encodeURIComponent(here)}`);
    return new Promise<AuthStatus>(() => {});
  }
  if (status.consentRequired && page !== 'consent' && currentMode() === 'real') {
    location.replace(`/consent.html?next=${encodeURIComponent(here)}`);
    return new Promise<AuthStatus>(() => {});
  }
  if (opts.title) { const t = $('#page-title'); if (t) t.textContent = opts.title; document.title = `${opts.title} | Public Records Search`; }

  const user = status.user;
  const side = $('#sidebar');
  if (side) {
    const mode = currentMode();
    const modeToggle = status.realSources && !user.isDemo ? h('div', null,
      h('p', { class: 'mode-label', id: 'mode-label' }, 'Data for new requests'),
      h('div', { class: 'mode-toggle', role: 'group', 'aria-labelledby': 'mode-label' },
        h('button', { type: 'button', 'aria-pressed': String(mode === 'demo'), on: { click: () => setMode('demo') } }, 'Demo corpus'),
        h('button', { type: 'button', 'aria-pressed': String(mode === 'real'), on: { click: () => setMode('real') } }, 'Real sources'))) : null;
    const roleSwitch = user.isDemo ? h('label', null, h('span', { class: 'visually-hidden' }, 'Switch demo role'),
      h('select', { on: { change: async (e: Event) => {
        const role = (e.target as HTMLSelectElement).value;
        try { await post('/api/auth/demo', { role }); location.reload(); } catch { toast('Could not switch role.', 'error'); }
      } } }, ...Object.entries(ROLE_LABEL).map(([id, label]) => h('option', { value: id, selected: id === user.role }, `View as: ${label}`)))) : null;
    replace(side,
      h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'B'), h('span', null, h('b', null, 'Public Records Search'), h('small', null, 'City Clerk staff workspace'))),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, NAV.filter(n => !n.perm || can(status!, n.perm)).map(n =>
        h('a', { href: n.href, 'aria-current': n.page === page ? 'page' : undefined }, h('span', { class: 'ico', 'aria-hidden': 'true' }, n.icon), n.label))),
      h('div', { class: 'sidebar-foot' }, modeToggle,
        h('div', { class: 'user-card' }, h('b', null, user.name), h('small', null, `${ROLE_LABEL[user.role] || user.role}${user.isDemo ? ' · demo account' : ''}`), roleSwitch,
          h('button', { type: 'button', class: 'side-link', on: { click: () => signOut() } }, 'Sign out'))));
  }

  const top = $('.topbar');
  if (top && !$('.menu-button', top)) {
    const btn = h('button', { type: 'button', class: 'menu-button', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'sidebar' }, '☰');
    btn.addEventListener('click', () => { const open = side?.classList.toggle('open'); btn.setAttribute('aria-expanded', String(Boolean(open))); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && side?.classList.contains('open')) { side.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
    side?.addEventListener('click', (e) => { if (e.target === side) side.classList.remove('open'); });
    const title = $('#page-title', top);
    const wrap = h('div', { class: 'topbar-title' }, btn);
    title?.replaceWith(wrap); if (title) wrap.appendChild(title);
  }

  const tier = $('#tier');
  if (tier) {
    const real = currentMode() === 'real';
    replace(tier, h('div', { class: 'tier-banner', role: 'note' },
      real ? h('span', { class: 'pill teal' }, 'Real sources') : h('span', { class: 'pill gray' }, 'Tier 0'),
      h('span', null, real ? 'New requests search your connected, read-only sources. Access checks and the audit log apply.'
        : 'Demo data only: invented requests, invented records and openly published documents. Real sources are off.')));
  }
  return status;
}

function setMode(mode: Mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* storage blocked */ }
  location.reload();
}

export const shellStatus = () => status;
