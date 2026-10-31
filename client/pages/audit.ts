// Screen 7: Audit Logs. Tamper-evident (hash-chained), filterable, exportable. Never "tamper-proof".
import { ApiError, get } from '../api.js';
import { initShell } from '../shell.js';
import { $, alertBox, busy, download, empty, fmtDate, h, pager, replace } from '../ui.js';

interface Ev { id: number; at: string; label: string; action: string; outcome: string; user: { name: string } | null; targetType: string | null; targetId: string | null; details: Record<string, unknown>; before: unknown; after: unknown; fingerprint: string | null }
interface Verify { ok: boolean; checked: number; firstBroken: { id: number; createdAt: string; action: string; problem: string } | null; anchor: string | null; wording: string; checkedAt: string }

const root = $('#root')!;
let page = 1;
const filters = { userId: '', category: '', from: '', to: '' };

const show = (v: unknown) => v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(', ') : typeof x === 'object' && x ? JSON.stringify(x) : String(x)}`).join('; ') : String(v);

async function main() {
  const st = await initShell({ title: 'Audit Logs' });
  if (!st.user!.permissions.includes('audit.read')) { replace(root, alertBox('Your role cannot read the audit log.')); return; }
  replace(root, h('section', { class: 'card', id: 'verify', 'aria-live': 'polite' }), h('div', { id: 'filters' }), h('section', { class: 'card', id: 'events' }));
  verify();
  load(true);
}

async function verify() {
  const box = $('#verify')!;
  const again = h('button', { type: 'button', class: 'button secondary small' }, 'Verify again');
  again.addEventListener('click', () => busy(again, 'Checking…', verify));
  try {
    const v = (await get<Verify>('/api/audit/verify')).data;
    replace(box, h('div', { class: `verify-bar banner ${v.ok ? 'ok' : 'bad'}`, role: 'status' },
      h('span', null, v.ok ? `✓ Chain verified: ${v.checked} entries, checked ${fmtDate(v.checkedAt, true)}.`
        : `✕ Chain broken at entry #${v.firstBroken!.id} (${v.firstBroken!.action}, ${fmtDate(v.firstBroken!.createdAt, true)}). ${v.firstBroken!.problem}`), again),
    h('p', { class: 'hint' }, `${v.wording}${v.anchor ? ` Oldest entry kept: ${fmtDate(v.anchor, true)}.` : ''}`));
  } catch (e) { replace(box, alertBox(e instanceof ApiError ? e.message : 'Could not verify the chain.'), again); }
}

async function load(drawFilters = false) {
  const p = new URLSearchParams({ page: String(page), pageSize: '50' });
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  let res;
  try { res = await get<Ev[]>(`/api/audit?${p}`); } catch (e) { replace($('#events')!, alertBox(e instanceof ApiError ? e.message : 'Could not load the log.')); return; }
  const meta = res.meta as unknown as { users: { id: string; name: string }[]; actions: Record<string, string> };
  if (drawFilters) {
    const who = h('select', { id: 'a-who' }, h('option', { value: '' }, 'Anyone'), meta.users.map(u => h('option', { value: u.id }, u.name))) as HTMLSelectElement;
    const what = h('select', { id: 'a-what' }, h('option', { value: '' }, 'Anything'), ...[['request', 'Requests'], ['plan', 'Plans'], ['search', 'Searches'], ['mark', 'Marks and routing'], ['consent', 'Search permission'], ['export', 'Exports'], ['source', 'Sources'], ['settings', 'Settings'], ['auth', 'Sign-ins'], ['report', 'Handoff and approval'], ['texts', 'Phone Link review']].map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    const from = h('input', { type: 'date', id: 'a-from' }) as HTMLInputElement;
    const to = h('input', { type: 'date', id: 'a-to' }) as HTMLInputElement;
    const form = h('form', { class: 'filter-bar' },
      h('label', { for: 'a-who' }, 'Who'), who, h('label', { for: 'a-what' }, 'What happened'), what, h('label', { for: 'a-from' }, 'From'), from, h('label', { for: 'a-to' }, 'To'), to,
      h('button', { type: 'submit', class: 'button small secondary' }, 'Filter'),
      h('button', { type: 'button', class: 'button small quiet', on: { click: () => { const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)); download(`/api/audit/export?${q}`); } } }, 'Export CSV'));
    form.addEventListener('submit', (e) => { e.preventDefault(); Object.assign(filters, { userId: who.value, category: what.value, from: from.value, to: to.value }); page = 1; load(); });
    replace($('#filters')!, form);
  }
  replace($('#events')!, res.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'audit-table' },
    h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Who'), h('th', null, 'What'), h('th', null, 'Item'), h('th', null, 'Before'), h('th', null, 'After'), h('th', null, 'Fingerprint'))),
    h('tbody', null, res.data.map(e => h('tr', null,
      h('td', null, fmtDate(e.at, true)), h('td', null, e.user?.name || 'System'),
      h('td', null, e.label, e.outcome !== 'success' ? h('span', null, ' ', h('b', null, `(${e.outcome})`)) : null, Object.keys(e.details).length ? h('div', { class: 'details-cell' }, show(e.details)) : null),
      h('td', { class: 'details-cell' }, [e.targetType, e.targetId].filter(Boolean).join(' ')),
      h('td', { class: 'details-cell' }, show(e.before)), h('td', { class: 'details-cell' }, show(e.after)),
      h('td', { class: 'mono' }, e.fingerprint || '')))))) : empty('No entries', 'Nothing matches these filters.'),
  pager(res.meta, (n) => { page = n; load(); }));
}

main();
