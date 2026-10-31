// Screen 17: Bellevue AI review package. A checklist of what the city's AI review will want, with owners and status.
// Facts come from how this build works. Open items stay [NEEDS HUMAN INPUT]. No model is stated as approved.
import { get } from '../api.js';
import { initShell } from '../shell.js';
import { $, h, pill, replace } from '../ui.js';

const root = $('#root')!;
const NEEDS = (t: string) => h('span', { class: 'needs-input' }, `[NEEDS HUMAN INPUT: ${t}]`);

function diagram() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 760 250'); svg.setAttribute('class', 'diagram'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Data flow: request text goes to the model, which returns a draft plan. Staff confirm the plan. The search runs on this server against read-only sources. Record content never goes to the model.');
  const box = (x: number, y: number, w: number, label: string[], fill: string) => {
    const g = document.createElementNS(ns, 'g');
    const r = document.createElementNS(ns, 'rect'); Object.entries({ x, y, width: w, height: 64, rx: 12, fill, stroke: '#243b6b', 'stroke-width': 1.5 }).forEach(([k, v]) => r.setAttribute(k, String(v)));
    g.appendChild(r);
    label.forEach((t, i) => { const tx = document.createElementNS(ns, 'text'); Object.entries({ x: x + w / 2, y: y + 28 + i * 18, 'text-anchor': 'middle', 'font-size': 13, fill: '#17223b', 'font-weight': i ? 400 : 700 }).forEach(([k, v]) => tx.setAttribute(k, String(v))); tx.textContent = t; g.appendChild(tx); });
    svg.appendChild(g);
  };
  const arrow = (x1: number, y1: number, x2: number, y2: number, label: string, color = '#2556c5') => {
    const l = document.createElementNS(ns, 'line'); Object.entries({ x1, y1, x2, y2, stroke: color, 'stroke-width': 2, 'marker-end': 'url(#a)' }).forEach(([k, v]) => l.setAttribute(k, String(v))); svg.appendChild(l);
    const t = document.createElementNS(ns, 'text'); Object.entries({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#535d70' }).forEach(([k, v]) => t.setAttribute(k, String(v))); t.textContent = label; svg.appendChild(t);
  };
  const defs = document.createElementNS(ns, 'defs');
  const m = document.createElementNS(ns, 'marker'); Object.entries({ id: 'a', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }).forEach(([k, v]) => m.setAttribute(k, String(v)));
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M0,0 L10,5 L0,10 z'); p.setAttribute('fill', '#2556c5'); m.appendChild(p); defs.appendChild(m); svg.appendChild(defs);
  box(20, 20, 150, ['Clerk', 'request text'], '#e8eefb');
  box(300, 20, 170, ['AI model', 'drafts plan only'], '#fdf1e2');
  box(590, 20, 150, ['Staff', 'edit, confirm, lock'], '#e8eefb');
  box(300, 160, 170, ['This server', 'search, rank, log'], '#e3f4f3');
  box(590, 160, 150, ['Sources', 'read-only'], '#f2f4f8');
  box(20, 160, 150, ['Staff', 'mark, report'], '#e8eefb');
  arrow(170, 52, 300, 52, 'request text only');
  arrow(470, 52, 590, 52, 'draft plan');
  arrow(665, 84, 470, 175, 'confirmed plan');
  arrow(590, 192, 470, 192, 'records stay here', '#0f8b8d');
  arrow(300, 192, 170, 192, 'candidates, reasons');
  return svg;
}

async function main() {
  const st = await initShell({ title: 'Bellevue AI review package' });
  void st;
  const sys = await get<{ ai: { configured: boolean; model: string | null } }>('/api/system/status').then(r => r.data).catch(() => null);
  const card = (title: string, status: Node, ...body: (Node | string | null)[]) => h('section', { class: 'card' }, h('h2', null, title, status), ...body);
  replace(root,
    h('p', { class: 'banner info' }, 'Pre-drafted for the city’s AI review. AI records (prompts, logs) are public records, so every piece here can be exported. Nothing here states that any model or hosting is approved.'),
    h('div', { class: 'cols-main-side' },
      h('div', { class: 'package-grid' },
        card('Data flow diagram', pill('ok', 'Drafted'), diagram()),
        card('What the model sees', pill('ok', 'Drafted'), h('ul', { class: 'plain-list' },
          h('li', null, 'Search plans: the request text, the department and record-type lists, and source names.'),
          h('li', null, 'Clarification drafts: the request text only.'),
          h('li', null, 'Never: record content, candidate text, staff marks, or texts from phones.'),
          h('li', null, `Model in this build: ${sys?.ai.configured ? sys.ai.model : 'none (local rules draft plans)'}. Logged with a prompt version on every plan.`))),
        card('Human review steps', pill('ok', 'Drafted'), h('ol', { class: 'guide-steps' },
          h('li', null, 'Clerk edits and confirms the plan. Nothing is searched before that.'),
          h('li', null, 'Staff mark each candidate: relevant, not relevant, unsure.'),
          h('li', null, 'Optional second-person approval by a Supervisor.'),
          h('li', null, 'Exemptions, redaction and release stay in the city’s process.'))),
        card('Logging and exports', pill('ok', 'Built'), h('p', null, 'Append-only audit log, hash-chained so changes are detectable (tamper-evident, not tamper-proof). One-click CSV export of the audit log, search log and candidates; PDF of the search record.')),
        card('Approved models and hosting', pill('warn', 'Open'), h('p', null, NEEDS('which models and hosting Bellevue approves'))),
        card('CIO exception template', pill('ok', 'Drafted'), h('p', null, 'Template fields: purpose, data tier, data that reaches the model (request text and plan only), retention, logging, human review, contact. ', NEEDS('Bellevue CIO contact and form number'))),
        card('Bias and fairness check', pill('info', 'Approach drafted'), h('p', null, 'Compare recall across request kinds and departments on the labeled test set; check plain-language and Spanish drafts with a human reviewer. Targets are outcomes to be validated during discovery [est.].')),
        card('Data retention', pill('warn', 'Open'), h('p', null, 'This build deletes search history after 365 days and audit events after 730 days by default (configurable). ', NEEDS('Bellevue retention schedule for AI records')))),
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h2', null, 'AI Questionnaire'), h('dl', { class: 'meta-list' }, h('dt', null, 'Due'), h('dd', null, 'November 3, 2026'), h('dt', null, 'Owner'), h('dd', null, 'Madhu'), h('dt', null, 'Facts from'), h('dd', null, 'Suhas'))),
        h('section', { class: 'card' }, h('h2', null, 'Later phase (not built, not claimed)'), h('ul', { class: 'plain-list' },
          h('li', null, 'Redaction support'), h('li', null, 'Exemption-log drafting'), h('li', null, 'Native-format production'), h('li', null, 'Portal integration (GovQA or other)'),
          h('li', null, 'Sensitive-content heads-up for reviewers (roadmap text only)'))),
        h('button', { type: 'button', class: 'button secondary no-print', on: { click: () => window.print() } }, 'Print or save as PDF'))));
}

main();
