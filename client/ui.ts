// DOM helpers. Everything is built with createElement/textContent, never innerHTML,
// so record content and user input can't inject markup.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; dataset?: Record<string, string>; on?: Record<string, EventListener> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]) {
  for (const c of children.flat(5 as 1)) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
export const clear = (el: Element) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const replace = (el: Element, ...children: Child[]) => { clear(el); append(el, children); return el; };

export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return 'No date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No date';
  return d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();
export function fmtBytes(n: number) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
export const fmtMs = (ms: number | null | undefined) => ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const splitList = (s: string) => s.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
export const joinList = (xs: string[] | undefined) => (xs || []).join(', ');

/** Render text with the given terms wrapped in <mark>. */
export function highlighted(text: string, terms: string[]): Node {
  const span = h('span');
  const clean = terms.map(t => t.trim()).filter(t => t.length > 1).sort((a, b) => b.length - a.length);
  if (!clean.length) { span.textContent = text; return span; }
  const re = new RegExp(`(${clean.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})`, 'gi');
  for (const part of text.split(re)) {
    if (!part) continue;
    span.appendChild(clean.some(t => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}$`, 'i').test(part)) ? h('mark', null, part) : document.createTextNode(part));
  }
  return span;
}

let toastTimer = 0;
export function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(el); }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove('is-visible'), 4200);
}

/** An inline alert block for errors and notices. */
export function alertBox(message: string, kind: 'error' | 'info' | 'warn' | 'ok' = 'error', action?: Node) {
  return h('div', { class: `alert alert-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('p', null, message), action ?? null);
}

/** Run an async action with the button showing a busy state. */
export async function busy<T>(button: HTMLButtonElement, label: string, fn: () => Promise<T>): Promise<T> {
  const old = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try { return await fn(); } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = old;
  }
}

export function empty(title: string, body: string, action?: Node) {
  return h('div', { class: 'empty-state' }, h('p', { class: 'empty-title' }, title), h('p', null, body), action ?? null);
}

export function pager(meta: { page: number; pageSize: number; total: number } | undefined, onPage: (p: number) => void) {
  if (!meta || meta.total <= meta.pageSize) return null;
  const pages = Math.ceil(meta.total / meta.pageSize);
  return h('nav', { class: 'pager', 'aria-label': 'Pages' },
    h('button', { type: 'button', class: 'button secondary', disabled: meta.page <= 1, on: { click: () => onPage(meta.page - 1) } }, 'Previous'),
    h('span', null, `Page ${meta.page} of ${pages} · ${fmtNum(meta.total)} total`),
    h('button', { type: 'button', class: 'button secondary', disabled: meta.page >= pages, on: { click: () => onPage(meta.page + 1) } }, 'Next'));
}

/** Modal dialog using the native <dialog> element (focus trapping and Esc handled by the browser). */
export function openDialog(title: string, body: Node, opts: { wide?: boolean; onClose?: () => void } = {}) {
  const dlg = h('dialog', { class: `modal${opts.wide ? ' modal-wide' : ''}`, 'aria-labelledby': 'dlg-title' },
    h('div', { class: 'modal-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close', on: { click: () => dlg.close() } }, '×')),
    h('div', { class: 'modal-body' }, body));
  dlg.addEventListener('close', () => { dlg.remove(); opts.onClose?.(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  return dlg;
}

export function field(label: string, control: HTMLElement, hint?: string) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

export const ROLE_LABEL: Record<string, string> = { admin: 'Supervisor', records_officer: 'Clerk', reviewer: 'Records Coordinator', auditor: 'Auditor' };
export const SOURCE_LABEL: Record<string, string> = { gmail: 'Gmail', uploads: 'Uploaded document', messages: 'Message import', database: 'Database', synthetic: 'Synthetic corpus', stub: 'Not connected' };
export const MARK_LABEL: Record<string, string> = { relevant: 'Relevant', not_relevant: 'Not relevant', unsure: 'Unsure' };

/** Status pill: an icon character plus words, never color alone. */
export function pill(kind: 'ok' | 'bad' | 'warn' | 'info' | 'teal' | 'gray' | 'draft', text: string, icon = '') {
  return h('span', { class: `pill ${kind}` }, icon ? h('span', { 'aria-hidden': 'true' }, icon) : null, text);
}

/** Five-step tracker: Request, Search plan, Search, Review, Report. */
export function tracker(current: number, requestId?: string) {
  const steps: [string, string][] = [['Request', '/'], ['Search plan', '/'], ['Search', '/search.html'], ['Review', '/search.html'], ['Report', '/report.html']];
  return h('ol', { class: 'tracker', 'aria-label': 'Progress' }, steps.map(([name, href], i) => {
    const n = i + 1, state = n < current ? 'done' : n === current ? 'current' : '';
    const label = [h('span', { class: 'num', 'aria-hidden': 'true' }, n < current ? '\u2713' : String(n)), h('span', { class: 'step-name' }, name)];
    return h('li', { class: state, 'aria-current': n === current ? 'step' : undefined },
      requestId && n <= Math.max(current, 2) ? h('a', { href: `${href}?id=${encodeURIComponent(requestId)}`, class: 'tracker-link' }, ...label) : label,
      h('span', { class: 'visually-hidden' }, state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''));
  }));
}

/** Days-left ring for the response clock. Words always accompany the number. */
export function deadlineRing(daysLeft: number | null, total = 5) {
  const pct = daysLeft === null ? 0 : Math.max(0, Math.min(100, (daysLeft / total) * 100));
  const ring = h('div', { class: `ring${daysLeft !== null && daysLeft < 0 ? ' late' : daysLeft !== null && daysLeft <= 1 ? ' warn' : ''}`, role: 'img', 'aria-label': daysLeft === null ? 'No due date' : `${daysLeft} business days left` }, h('span', null, daysLeft === null ? '?' : String(Math.max(daysLeft, 0))));
  ring.style.setProperty('--p', String(daysLeft !== null && daysLeft < 0 ? 100 : pct));
  return ring;
}

export function deadlinePill(label: string, daysLeft: number | null) {
  if (daysLeft === null) return pill('gray', 'No date');
  return daysLeft < 0 ? pill('bad', label, '!') : daysLeft === 0 ? pill('warn', label, '!') : daysLeft <= 2 ? pill('warn', label) : pill('ok', label);
}

export function download(url: string) {
  const a = h('a', { href: url, download: '' });
  document.body.appendChild(a); a.click(); a.remove();
}
