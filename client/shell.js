// Shared page chrome: mode switch (Demo / Real data), signed-in user, navigation, mode banner.
import { authStatus, can, signOut } from './api.js';
import { $, $$, h, replace, ROLE_LABEL } from './ui.js';
const MODE_KEY = 'prs-mode';
export function currentMode() {
    try {
        return localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'demo';
    }
    catch {
        return 'demo';
    }
}
// Set the mode attribute immediately so the right panels show before data loads.
document.body.dataset.mode = currentMode();
export const NAV = [
    { href: '/', label: 'Request & Plan', page: 'request' },
    { href: '/search.html', label: 'Search Results', page: 'search' },
    { href: '/sources.html', label: 'Connected Sources', page: 'sources' },
    { href: '/history.html', label: 'Search History', page: 'history' },
    { href: '/evaluation.html', label: 'Evaluation', page: 'evaluation' },
    { href: '/audit.html', label: 'Audit Logs', page: 'audit' },
    { href: '/settings.html', label: 'Settings', page: 'settings' }
];
function setMode(mode) {
    try {
        localStorage.setItem(MODE_KEY, mode);
    }
    catch { /* storage blocked: mode resets on reload */ }
    location.reload();
}
/** Render shared chrome and return auth status. Pages with `realOnly` show a sign-in prompt instead of content when signed out. */
export async function initShell(opts = {}) {
    const status = await authStatus();
    const mode = currentMode();
    const page = document.body.dataset.page || '';
    // Ask for search permission right after sign-in, before anything else.
    if (status.user && status.consentRequired && page !== 'consent' && (opts.realOnly || mode === 'real')) {
        location.replace(`/consent.html?next=${encodeURIComponent(location.pathname + location.search)}`);
        return new Promise(() => { });
    }
    const nav = $('#main-nav');
    if (nav)
        replace(nav, ...NAV.map(n => h('a', { href: n.href, class: n.page === page ? 'active' : undefined, 'aria-current': n.page === page ? 'page' : undefined }, n.label)));
    const modeSwitch = $('#mode-switch');
    if (modeSwitch) {
        const disabledReal = status.demoOnly;
        replace(modeSwitch, h('span', { class: 'theme-picker-label' }, 'MODE'), h('button', { type: 'button', 'aria-pressed': String(mode === 'demo'), on: { click: () => mode !== 'demo' && setMode('demo') } }, 'Demo'), h('button', { type: 'button', 'aria-pressed': String(mode === 'real'), disabled: disabledReal, title: disabledReal ? 'This server runs the synthetic demo only.' : undefined, on: { click: () => mode !== 'real' && setMode('real') } }, 'Real data'));
    }
    const userBox = $('#user-box');
    if (userBox) {
        if (status.user) {
            replace(userBox, h('span', { class: 'user-name' }, h('b', null, status.user.name), h('small', null, ROLE_LABEL[status.user.role] || status.user.role)), h('button', { type: 'button', class: 'user-signout', on: { click: () => signOut() } }, 'Sign out'));
        }
        else if (!status.demoOnly && !status.offline) {
            replace(userBox, h('a', { class: 'user-signin', href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign in'));
        }
        else {
            replace(userBox, h('span', { class: 'local-tag' }, h('i'), ' Local demo'));
        }
    }
    const banner = $('#mode-banner');
    if (banner) {
        const realPage = opts.realOnly;
        const text = realPage
            ? status.user ? `Signed in to ${status.user.email}. Only records your role may see are shown.` : 'Sign in to use this page. It works with real connected sources.'
            : mode === 'demo'
                ? 'Demo mode: 18 invented requests and synthetic records. Nothing is sent to a server or an AI service.'
                : status.user ? 'Real data mode: searches run over your connected sources, with access checks and an audit trail.' : 'Real data mode: sign in to search your connected sources.';
        banner.dataset.kind = realPage ? 'real' : mode;
        replace(banner, h('span', { class: 'mode-pill' }, realPage ? 'Real data' : mode === 'demo' ? 'Synthetic' : 'Real data'), h('span', null, text));
    }
    // Hide nav entries a signed-in role can never use.
    if (status.user) {
        for (const a of $$('#main-nav a')) {
            if (a.getAttribute('href') === '/audit.html' && !can(status, 'audit.read'))
                a.hidden = true;
        }
    }
    if ((opts.realOnly || mode === 'real') && !status.user) {
        const gate = $('#signin-gate');
        if (gate) {
            gate.hidden = false;
            replace(gate, h('div', { class: 'card gate-card' }, h('h2', null, status.demoOnly ? 'Real data is switched off on this server' : status.setupRequired ? 'Set up the first administrator' : 'Sign in to continue'), h('p', { class: 'helper' }, status.demoOnly
                ? 'This server runs with DEMO_ONLY=true, so only the synthetic demo is available.'
                : status.setupRequired ? 'No accounts exist yet. Create the first administrator from this computer.' : 'Connected sources, search history and audit logs are only available to signed-in staff.'), status.demoOnly ? h('a', { class: 'button secondary link-button', href: '/' }, 'Open the demo')
                : h('a', { class: 'button primary link-button', href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}` }, status.setupRequired ? 'Create administrator' : 'Sign in')));
            for (const el of $$('.needs-auth'))
                el.hidden = true;
        }
    }
    return status;
}
