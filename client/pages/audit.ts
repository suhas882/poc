import { ApiError, can, get } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, empty, fmtDate, h, pager, replace } from '../ui.js';

interface Event { id: number; at: string; action: string; label: string; outcome: string; user: { id: string; name: string } | null; targetType: string | null; targetId: string | null; ipHash: string | null; details: Record<string, unknown> }
const CATEGORIES: [string, string][] = [['', 'All activity'], ['auth', 'Sign-ins'], ['search', 'Searches'], ['record', 'Record views'], ['export', 'Exports'], ['source', 'Source access and sync'], ['upload', 'Uploads'], ['evaluation', 'Relevance decisions'], ['user', 'User and permission changes'], ['settings', 'Settings'], ['access', 'Blocked actions'], ['retention', 'Retention']];
const state: Record<string, string> = { category: '', outcome: '', userId: '', from: '', to: '' };
let page = 1;

async function main() {
  const status = await initShell({ realOnly: true });
  if (!status.user) return;
  if (!can(status, 'audit.read')) { replace($('#a-list')!, alertBox('Only administrators and auditors can read the audit log.', 'info')); return; }
  load(true);
}

function filters(users: { id: string; name: string }[]) {
  const sel = (key: string, label: string, opts: [string, string][]) => h('label', { class: 'filter' }, h('span', null, label),
    h('select', { on: { change: (e: globalThis.Event) => { state[key] = (e.target as HTMLSelectElement).value; page = 1; load(); } } }, ...opts.map(([v, t]) => h('option', { value: v, selected: state[key] === v }, t))));
  const date = (key: string, label: string) => h('label', { class: 'filter' }, h('span', null, label), h('input', { type: 'date', value: state[key], on: { change: (e: globalThis.Event) => { state[key] = (e.target as HTMLInputElement).value; page = 1; load(); } } }));
  const q = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
  replace($('#a-filters')!,
    sel('category', 'Activity', CATEGORIES),
    sel('outcome', 'Outcome', [['', 'Any outcome'], ['success', 'Succeeded'], ['failure', 'Failed'], ['denied', 'Blocked']]),
    sel('userId', 'User', [['', 'Everyone'], ...users.map(u => [u.id, u.name] as [string, string])]),
    date('from', 'From'), date('to', 'To'),
    h('a', { class: 'button secondary link-button', href: `/api/audit/export?${q}`, download: '' }, 'Export CSV'));
}

function details(d: Record<string, unknown>) {
  const entries = Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!entries.length) return '';
  return entries.slice(0, 6).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ');
}

async function load(first = false) {
  const p = new URLSearchParams({ page: String(page), pageSize: '50', ...Object.fromEntries(Object.entries(state).filter(([, v]) => v)) });
  try {
    const res = await get<Event[]>(`/api/audit?${p}`);
    if (first) filters((res.meta as any).users);
    replace($('#a-list')!, res.data.length ? h('table', { class: 'data-table audit-table' },
      h('thead', null, h('tr', null, ...['Time', 'Activity', 'Outcome', 'User', 'Target', 'Details'].map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', null, res.data.map(e => h('tr', null,
        h('td', null, fmtDate(e.at, true)), h('td', null, e.label), h('td', null, h('span', { class: `status-pill out-${e.outcome}` }, e.outcome === 'success' ? 'Succeeded' : e.outcome === 'failure' ? 'Failed' : 'Blocked')),
        h('td', null, e.user?.name || 'System'), h('td', null, e.targetType ? `${e.targetType}${e.targetId ? ` ${e.targetId.slice(0, 8)}` : ''}` : ''), h('td', { class: 'details-cell' }, details(e.details))))))
      : empty('No matching activity', 'Try a wider date range or another activity type.'));
    replace($('#a-pager')!, pager(res.meta, (pg) => { page = pg; load(); }));
  } catch (e) { replace($('#a-list')!, alertBox(e instanceof ApiError ? e.message : 'The audit log could not be loaded.')); }
}

main();
