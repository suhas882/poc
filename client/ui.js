// DOM helpers. Everything is built with createElement/textContent, never innerHTML,
// so record content and user input can't inject markup.
export function h(tag, props = null, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [k, v] of Object.entries(props)) {
            if (v === undefined || v === null || v === false)
                continue;
            if (k === 'class')
                el.className = String(v);
            else if (k === 'dataset')
                Object.assign(el.dataset, v);
            else if (k === 'on')
                for (const [ev, fn] of Object.entries(v))
                    el.addEventListener(ev, fn);
            else if (k in el && typeof v !== 'string')
                el[k] = v;
            else
                el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    append(el, children);
    return el;
}
export function append(parent, children) {
    for (const c of children.flat(5)) {
        if (c === null || c === undefined || c === false)
            continue;
        parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { while (el.firstChild)
    el.removeChild(el.firstChild); return el; };
export const replace = (el, ...children) => { clear(el); append(el, children); return el; };
export function fmtDate(iso, withTime = false) {
    if (!iso)
        return 'No date';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return 'No date';
    return d.toLocaleString(undefined, withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' });
}
export const fmtNum = (n) => (n ?? 0).toLocaleString();
export function fmtBytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
export const fmtMs = (ms) => ms == null ? '–' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
export const splitList = (s) => s.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
export const joinList = (xs) => (xs || []).join(', ');
/** Render text with the given terms wrapped in <mark>. */
export function highlighted(text, terms) {
    const span = h('span');
    const clean = terms.map(t => t.trim()).filter(t => t.length > 1).sort((a, b) => b.length - a.length);
    if (!clean.length) {
        span.textContent = text;
        return span;
    }
    const re = new RegExp(`(${clean.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})`, 'gi');
    for (const part of text.split(re)) {
        if (!part)
            continue;
        span.appendChild(clean.some(t => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}$`, 'i').test(part)) ? h('mark', null, part) : document.createTextNode(part));
    }
    return span;
}
let toastTimer = 0;
export function toast(message, kind = 'ok') {
    let el = $('#toast');
    if (!el) {
        el = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el?.classList.remove('is-visible'), 4200);
}
/** An inline alert block for errors and notices. */
export function alertBox(message, kind = 'error', action) {
    return h('div', { class: `alert alert-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('p', null, message), action ?? null);
}
/** Run an async action with the button showing a busy state. */
export async function busy(button, label, fn) {
    const old = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = label;
    try {
        return await fn();
    }
    finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = old;
    }
}
export function empty(title, body, action) {
    return h('div', { class: 'empty-state' }, h('p', { class: 'empty-title' }, title), h('p', null, body), action ?? null);
}
export function pager(meta, onPage) {
    if (!meta || meta.total <= meta.pageSize)
        return null;
    const pages = Math.ceil(meta.total / meta.pageSize);
    return h('nav', { class: 'pager', 'aria-label': 'Pages' }, h('button', { type: 'button', class: 'button secondary', disabled: meta.page <= 1, on: { click: () => onPage(meta.page - 1) } }, 'Previous'), h('span', null, `Page ${meta.page} of ${pages} · ${fmtNum(meta.total)} total`), h('button', { type: 'button', class: 'button secondary', disabled: meta.page >= pages, on: { click: () => onPage(meta.page + 1) } }, 'Next'));
}
/** Modal dialog using the native <dialog> element (focus trapping and Esc handled by the browser). */
export function openDialog(title, body, opts = {}) {
    const dlg = h('dialog', { class: `modal${opts.wide ? ' modal-wide' : ''}`, 'aria-labelledby': 'dlg-title' }, h('div', { class: 'modal-head' }, h('h2', { id: 'dlg-title' }, title), h('button', { type: 'button', class: 'icon-button', 'aria-label': 'Close', on: { click: () => dlg.close() } }, '×')), h('div', { class: 'modal-body' }, body));
    dlg.addEventListener('close', () => { dlg.remove(); opts.onClose?.(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    return dlg;
}
export function field(label, control, hint) {
    const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
    control.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}
export const ROLE_LABEL = { admin: 'Administrator', records_officer: 'Records officer', reviewer: 'Reviewer', auditor: 'Auditor' };
export const SOURCE_LABEL = { gmail: 'Gmail', uploads: 'Uploaded document', messages: 'Message import', database: 'Database', synthetic: 'Synthetic demo' };
