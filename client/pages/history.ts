// Screen 6: Search History. A work queue and an archive in one screen.
import { ApiError, get } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, deadlinePill, download, empty, fmtDate, fmtNum, h, pager, pill, replace } from '../ui.js';

interface Row { id: string; ref: string; text: string; mode: string; createdAt: string; createdBy: string; clock: { dueDate: string; daysLeft: number; label: string };
  stage: { key: string; label: string }; review: { total: number; marked: number }; resultCount: number | null; sourcesSearched: number; sourcesNotSearched: number; lastRunAt: string | null }
interface Tiles { open: number; dueSoon: number; dueToday: number; late: number; ready: number }

const root = $('#root')!;
let q = '', status = '', due = '', page = 1;
let canExport = false;

const STAGE_PILL: Record<string, 'draft' | 'info' | 'warn' | 'ok' | 'gray'> = { draft: 'draft', confirmed: 'info', review: 'warn', ready: 'ok', handed_off: 'gray' };

async function main() {
  const st = await initShell({ title: 'Search History' });
  canExport = st.user!.permissions.includes('export.create');
  const search = h('input', { type: 'search', id: 'h-q', placeholder: 'Request text or number' }) as HTMLInputElement;
  const stSel = h('select', { id: 'h-status' }, h('option', { value: '' }, 'Any status'), h('option', { value: 'draft' }, 'Draft plan'), h('option', { value: 'confirmed' }, 'Plan confirmed'),
    h('option', { value: 'review' }, 'In review'), h('option', { value: 'ready' }, 'Ready for report'), h('option', { value: 'handed_off' }, 'Handed off')) as HTMLSelectElement;
  const dueSel = h('select', { id: 'h-due' }, h('option', { value: '' }, 'Any due date'), h('option', { value: 'open' }, 'Open requests'), h('option', { value: 'soon' }, 'Due in 0 to 2 days'), h('option', { value: 'late' }, 'Late')) as HTMLSelectElement;
  const form = h('form', { class: 'filter-bar', role: 'search' },
    h('label', { class: 'visually-hidden', for: 'h-q' }, 'Search requests'), search,
    h('label', { class: 'visually-hidden', for: 'h-status' }, 'Status'), stSel, h('label', { class: 'visually-hidden', for: 'h-due' }, 'Due'), dueSel,
    h('button', { type: 'submit', class: 'button small secondary' }, 'Filter'));
  form.addEventListener('submit', (e) => { e.preventDefault(); q = search.value.trim(); status = stSel.value; due = dueSel.value; page = 1; load(); });
  replace(root, h('div', { class: 'tiles', id: 'tiles' }), form, h('section', { class: 'card', id: 'list', 'aria-label': 'Requests' }),
    h('div', { class: 'form-row' }, h('a', { class: 'button primary link-button', href: '/' }, 'New request')));
  load();
}

async function load() {
  const p = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (q) p.set('q', q); if (status) p.set('status', status); if (due) p.set('due', due);
  let res;
  try { res = await get<Row[]>(`/api/requests?${p}`); } catch (e) { replace($('#list')!, alertBox(e instanceof ApiError ? e.message : 'Could not load requests.')); return; }
  const t = (res.meta as unknown as { tiles: Tiles }).tiles;
  replace($('#tiles')!,
    h('div', { class: 'tile' }, h('b', null, String(t.open)), h('span', null, 'Open requests')),
    h('div', { class: 'tile warn' }, h('b', null, String(t.dueSoon + t.dueToday)), h('span', null, `Due in 0 to 2 days${t.dueToday ? ` (${t.dueToday} today)` : ''}`)),
    h('div', { class: 'tile late' }, h('b', null, String(t.late)), h('span', null, 'Late')),
    h('div', { class: 'tile ok' }, h('b', null, String(t.ready)), h('span', null, 'Search records ready')));
  const rows = res.data;
  replace($('#list')!, rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
    h('caption', { class: 'visually-hidden' }, 'Requests, newest first'),
    h('thead', null, h('tr', null, h('th', null, 'Request'), h('th', null, 'Deadline'), h('th', null, 'Status'), h('th', null, 'Review'), h('th', null, 'Results'), h('th', null, 'Sources'), h('th', null, h('span', { class: 'visually-hidden' }, 'Actions')))),
    h('tbody', null, rows.map(r => {
      const prog = h('span', { class: 'mini-progress', 'aria-hidden': 'true' }, h('i'));
      (prog.firstChild as HTMLElement).style.width = `${r.review.total ? Math.round(100 * r.review.marked / r.review.total) : 0}%`;
      return h('tr', null,
        h('td', null, h('a', { href: `/?id=${r.id}` }, h('b', null, r.ref)), r.mode === 'real' ? h('span', null, ' ', pill('teal', 'Real')) : null, h('br'), h('span', { class: 'muted' }, r.text.length > 90 ? `${r.text.slice(0, 90)}…` : r.text), h('br'), h('small', { class: 'muted' }, `${r.createdBy}, ${fmtDate(r.createdAt)}`)),
        h('td', null, r.stage.key === 'handed_off' ? pill('gray', 'Closed') : deadlinePill(r.clock.label, r.clock.daysLeft), h('br'), h('small', { class: 'muted' }, `Due ${fmtDate(r.clock.dueDate)}`)),
        h('td', null, pill(STAGE_PILL[r.stage.key] || 'gray', r.stage.label)),
        h('td', null, prog, `${r.review.marked} of ${r.review.total}`),
        h('td', { class: 'num' }, r.resultCount == null ? '' : fmtNum(r.resultCount)),
        h('td', null, r.lastRunAt ? `${r.sourcesSearched} searched` : 'Not searched', r.sourcesNotSearched ? h('span', null, h('br'), h('small', { class: 'muted' }, `${r.sourcesNotSearched} NOT searched`)) : null),
        h('td', null, h('div', { class: 'chips' },
          h('a', { class: 'button small secondary link-button', href: `/report.html?id=${r.id}` }, 'Open'),
          canExport && r.lastRunAt ? h('button', { type: 'button', class: 'button small quiet', on: { click: () => download(`/api/requests/${r.id}/export/log.csv`) } }, 'CSV') : null,
          r.lastRunAt ? h('a', { class: 'button small quiet link-button', href: `/report.html?id=${r.id}&print=1`, target: '_blank', rel: 'noopener' }, 'PDF') : null)));
    })))) : empty('No requests found', q || status || due ? 'Try different filters.' : 'Start a new request on Request & Plan.'),
  pager(res.meta, (n) => { page = n; load(); }));
}

main();
