import { ApiError, can, get } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, empty, fmtDate, fmtMs, h, pager, replace } from '../ui.js';

interface Item { id: string; mode: string; requestText: string; status: string; createdAt: string; durationMs: number | null; resultCount: number | null; user: { name: string }; planOrigin: string; judged: number; hasSummary: boolean }
const state = { page: 1, scope: 'mine', mode: '', q: '' };

async function main() {
  const status = await initShell({ realOnly: true });
  if (!status.user) return;
  const canAll = can(status, 'history.read_all');
  if (!can(status, 'history.read_own') && canAll) state.scope = 'all';
  const q = h('input', { type: 'search', placeholder: 'Search request text', 'aria-label': 'Search request text' }) as HTMLInputElement;
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(() => { state.q = q.value.trim(); state.page = 1; load(); }, 300); });
  const mode = h('select', { 'aria-label': 'Mode', on: { change: (e: Event) => { state.mode = (e.target as HTMLSelectElement).value; state.page = 1; load(); } } }, h('option', { value: '' }, 'Real and demo'), h('option', { value: 'real' }, 'Real data only'), h('option', { value: 'demo' }, 'Demo only'));
  const scope = canAll ? h('select', { 'aria-label': 'Whose searches', on: { change: (e: Event) => { state.scope = (e.target as HTMLSelectElement).value; state.page = 1; load(); } } }, ...(can(status, 'history.read_own') ? [h('option', { value: 'mine' }, 'My searches')] : []), h('option', { value: 'all', selected: state.scope === 'all' }, 'Everyone’s searches')) : null;
  replace($('#h-filters')!, h('label', { class: 'filter grow' }, h('span', null, 'Find'), q), h('label', { class: 'filter' }, h('span', null, 'Mode'), mode), scope ? h('label', { class: 'filter' }, h('span', null, 'Scope'), scope) : null);
  load();
}

async function load() {
  const list = $('#h-list')!;
  const p = new URLSearchParams({ page: String(state.page), pageSize: '20', ...(state.scope === 'all' ? { scope: 'all' } : {}), ...(state.mode ? { mode: state.mode } : {}), ...(state.q ? { q: state.q } : {}) });
  try {
    const res = await get<Item[]>(`/api/searches?${p}`);
    replace(list, res.data.length ? h('table', { class: 'data-table history-table' },
      h('thead', null, h('tr', null, ...['Request', 'When', 'By', 'Mode', 'Results', 'Reviewed', 'Plan', ''].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, res.data.map(r => h('tr', null,
        h('td', { class: 'request-cell' }, r.requestText),
        h('td', null, fmtDate(r.createdAt, true)),
        h('td', null, r.user.name || '—'),
        h('td', null, h('span', { class: `mode-chip mode-${r.mode}` }, r.mode === 'demo' ? 'Synthetic' : 'Real')),
        h('td', null, r.status === 'completed' ? `${r.resultCount} · ${fmtMs(r.durationMs)}` : r.status === 'planned' ? 'Planned, not run' : 'Failed'),
        h('td', null, r.judged ? `${r.judged} decisions` : '—', r.hasSummary ? ' · summary' : ''),
        h('td', null, r.planOrigin === 'claude' ? 'Claude' : 'Rules'),
        h('td', null, r.status === 'completed' ? h('a', { class: 'button secondary link-button small', href: `/search.html?search=${encodeURIComponent(r.id)}` }, 'Open') : h('a', { class: 'button secondary link-button small', href: `/?request=${encodeURIComponent(r.requestText)}` }, 'Plan again'))))))
      : empty('No searches yet', state.q || state.mode ? 'Nothing matches these filters.' : 'Searches you plan and run appear here.', h('a', { class: 'button primary link-button', href: '/' }, 'Plan a search')));
    replace($('#h-pager')!, pager(res.meta, (pg) => { state.page = pg; load(); }));
  } catch (e) { replace(list, alertBox(e instanceof ApiError ? e.message : 'History could not be loaded.')); }
}

main();
