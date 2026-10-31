import { ApiError, authStatus, post } from '../api.js';
import { $, alertBox, busy, field, h, replace } from '../ui.js';

const next = (() => { const n = new URLSearchParams(location.search).get('next') || '/'; return n.startsWith('/') && !n.startsWith('//') ? n : '/'; })();

async function main() {
  const root = $('#login-root')!;
  const status = await authStatus();
  if (status.user) { location.replace(next); return; }
  if (status.demoOnly) {
    replace(root, h('h1', null, 'Demo only'), h('p', null, status.offline ? 'The server could not be reached, so only the synthetic demo is available.' : 'This server runs the synthetic demo only. Sign-in and real data are switched off.'), h('a', { class: 'button primary link-button', href: '/' }, 'Open the demo'));
    return;
  }
  if (status.setupRequired) return setupForm(root);
  loginForm(root);
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
  const form = h('form', { novalidate: true }, h('h1', null, 'Create the first administrator'),
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
