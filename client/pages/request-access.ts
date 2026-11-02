// Access Request: someone signed in with Google or Microsoft but has no account here. They can ask a Supervisor
// for one. The name and email come from the verified sign-in and cannot be edited.
import { ApiError, get, post } from '../api.js';
import { $, alertBox, busy, field, fmtDate, h, replace } from '../ui.js';

interface Req { status: 'pending' | 'approved' | 'rejected'; organization: string; createdAt: string; decidedAt: string | null; note: string | null }
interface Me { identity: { name: string; email: string; provider: 'google' | 'microsoft' }; request: Req | null }

const SUBMITTED = 'Your access request has been submitted. A Supervisor must approve it before you can access the application.';
const root = $('#request-root')!;
const brand = () => h('div', { class: 'brand-row' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'B'), h('div', null, h('h1', null, 'Request access'), h('p', { class: 'helper' }, 'Public Records Search')));
const back = () => h('p', null, h('a', { href: '/login.html' }, 'Back to sign in'));

async function main() {
  let me: Me;
  try { me = (await get<Me>('/api/access-requests/me')).data; }
  catch (e) { replace(root, brand(), alertBox(e instanceof ApiError ? e.message : 'Your sign-in could not be read.'), back()); return; }
  const who = h('dl', { class: 'source-facts' },
    h('dt', null, 'Name'), h('dd', null, me.identity.name),
    h('dt', null, 'Email'), h('dd', null, me.identity.email),
    h('dt', null, 'Verified by'), h('dd', null, me.identity.provider === 'google' ? 'Google' : 'Microsoft'));
  const r = me.request;
  if (r?.status === 'pending') { replace(root, brand(), who, alertBox(`${SUBMITTED} (Sent ${fmtDate(r.createdAt)}.)`, 'info'), back()); return; }
  if (r?.status === 'approved') { replace(root, brand(), who, alertBox('Your request was approved. Sign in again with the same account.', 'ok'), h('p', null, h('a', { class: 'button primary', href: '/login.html' }, 'Sign in'))); return; }
  form(me, who, r?.status === 'rejected' ? r : null);
}

function form(me: Me, who: HTMLElement, rejected: Req | null) {
  const org = h('input', { autocomplete: 'organization', maxlength: 120 }) as HTMLInputElement;
  const reason = h('textarea', { rows: 4, maxlength: 1000 }) as HTMLTextAreaElement;
  const btn = h('button', { type: 'submit', class: 'button primary' }, 'Submit access request');
  const out = h('div');
  const f = h('form', { novalidate: true },
    h('p', null, `You signed in with ${me.identity.provider === 'google' ? 'Google' : 'Microsoft'}, but there is no account for this address here. You can ask a Supervisor for access. Nothing is created until they approve.`),
    who,
    rejected ? alertBox(`An earlier request was declined on ${fmtDate(rejected.decidedAt || rejected.createdAt)}${rejected.note ? `: ${rejected.note}` : ''}. You can ask again.`, 'warn') : null,
    field('Organization', org, 'The organization you work for.'),
    field('Reason for access', reason, 'What you need to search, and in what role.'),
    out, h('div', { class: 'form-row' }, btn, h('a', { class: 'button secondary', href: '/login.html' }, 'Cancel')));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    replace(out);
    try {
      await busy(btn, 'Sending…', () => post('/api/access-requests/me', { organization: org.value.trim(), reason: reason.value.trim() }));
      replace(root, brand(), who, alertBox(SUBMITTED, 'ok'), back());
    } catch (err) { replace(out, alertBox(err instanceof ApiError ? err.message : 'The request could not be sent.')); }
  });
  replace(root, brand(), f);
  org.focus();
}

main();
