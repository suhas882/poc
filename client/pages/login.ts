import { ApiError, authStatus, post } from '../api.js';
import { $, alertBox, busy, field, h, replace } from '../ui.js';

const next = (() => { const n = new URLSearchParams(location.search).get('next') || '/'; return n.startsWith('/') && !n.startsWith('//') ? n : '/'; })();

async function main() {
  const root = $('#login-root')!;
  const status = await authStatus();
  if (status.user) { location.replace(next); return; }
  if (status.offline) { replace(root, h('h1', null, 'The server could not be reached'), h('p', null, 'Check that the server is running, then reload this page.')); return; }
  if (status.demoAccounts) return demoForm(root);
  if (status.setupRequired) return setupForm(root);
  loginForm(root);
}

const DEMO_ROLES: [string, string, string][] = [
  ['records_officer', 'Clerk', 'Log a request, edit and confirm the plan, review results, hand off.'],
  ['reviewer', 'Records Coordinator', 'Search and mark candidates routed to a department.'],
  ['admin', 'Supervisor', 'Everything, plus settings, city packs and second-person approval.'],
  ['auditor', 'Auditor', 'Read search history and the tamper-evident audit log.']];

function demoForm(root: HTMLElement) {
  const out = h('div');
  replace(root,
    h('div', { class: 'brand-row' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'B'), h('div', null, h('h1', null, 'Public Records Search'), h('p', { class: 'helper' }, 'City Clerk staff workspace \u00B7 proof of concept'))),
    h('p', { class: 'banner info' }, 'Tier 0 demo. Every request and record here is invented, or an openly published document. Real sources are off on this server.'),
    h('h2', { class: 'card-title' }, 'Try it as'),
    h('div', { class: 'role-grid' }, DEMO_ROLES.map(([role, label, text]) => h('button', { type: 'button', class: 'button secondary', on: { click: async (e: Event) => {
      try { await busy(e.currentTarget as HTMLButtonElement, 'Starting\u2026', () => post('/api/auth/demo', { role })); location.replace(next); }
      catch (err) { replace(out, alertBox(err instanceof ApiError ? err.message : 'Could not start the demo.')); }
    } } }, h('b', null, label), h('small', null, text)))),
    out,
    h('p', { class: 'hint' }, 'Each visitor gets a private demo workspace with invented accounts. It is removed after three days. You can switch roles from the sidebar.'),
    h('p', { class: 'hint' }, 'Staff decide. The tool finds, ranks and logs. WCAG 2.1 AA-aligned interface.'));
}

function loginForm(root: HTMLElement) {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true }) as HTMLInputElement;
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true }) as HTMLInputElement;
  const btn = h('button', { type: 'submit', class: 'button primary' }, 'Sign in');
  const out = h('div');
  const form = h('form', { novalidate: true }, h('h1', null, 'Sign in'), h('p', { class: 'helper' }, 'Use the account your administrator created for you.'), field('Email', email), field('Password', pw), out, h('div', { class: 'form-row' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    replace(out);
    if (!email.value || !pw.value) { replace(out, alertBox('Enter your email and password.')); return; }
    try {
      await busy(btn, 'Signing in…', () => post('/api/auth/login', { email: email.value.trim(), password: pw.value }));
      const st = await authStatus(true);
      location.replace(st.consentRequired ? `/consent.html?next=${encodeURIComponent(next)}` : next);
    }
    catch (err) { replace(out, alertBox(err instanceof ApiError ? err.message : 'Sign-in failed.')); pw.select(); }
  });
  replace(root, form);
  email.focus();
}

function setupForm(root: HTMLElement) {
  const org = h('input', { autocomplete: 'organization' }) as HTMLInputElement;
  const name = h('input', { autocomplete: 'name' }) as HTMLInputElement;
  const email = h('input', { type: 'email', autocomplete: 'username' }) as HTMLInputElement;
  const pw = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const token = h('input', { autocomplete: 'off' }) as HTMLInputElement;
  const btn = h('button', { type: 'submit', class: 'button primary' }, 'Create administrator');
  const out = h('div');
  const form = h('form', { novalidate: true }, h('h1', null, 'Create the first supervisor account'),
    h('p', { class: 'helper' }, 'No accounts exist yet. This form only works from the server’s own computer (localhost), or with the SETUP_TOKEN configured on the server.'),
    field('Organization name', org), field('Your name', name), field('Email', email), field('Password', pw, 'At least 12 characters.'),
    h('details', null, h('summary', null, 'Setting up from another computer?'), field('Setup token', token, 'The SETUP_TOKEN value from the server’s environment.')),
    out, h('div', { class: 'form-row' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    replace(out);
    try {
      await busy(btn, 'Creating…', () => post('/api/auth/setup', { orgName: org.value, name: name.value, email: email.value.trim(), password: pw.value, setupToken: token.value || undefined }));
      try { localStorage.setItem('prs-mode', 'real'); } catch { /* ignore */ }
      location.replace('/consent.html?next=%2Fsources.html');
    } catch (err) { replace(out, alertBox(err instanceof ApiError ? err.message : 'Setup failed.')); }
  });
  replace(root, form);
  org.focus();
}

main();
