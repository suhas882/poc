// Browser API client: JSON in/out, CSRF header on writes, consistent errors.
export class ApiError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
let csrf = null;
let statusPromise = null;
export function authStatus(refresh = false) {
    if (!statusPromise || refresh) {
        statusPromise = fetch('/api/auth/status', { credentials: 'same-origin' })
            .then(async (r) => {
            if (!r.ok)
                throw new Error('status unavailable');
            const body = await r.json();
            csrf = body.data.csrfToken;
            return body.data;
        })
            .catch(() => ({ demoOnly: true, setupRequired: false, user: null, csrfToken: null, offline: true }));
    }
    return statusPromise;
}
export const can = (s, perm) => Boolean(s.user?.permissions.includes(perm));
export async function api(method, url, body, opts = {}) {
    if (method !== 'GET' && csrf === null)
        await authStatus();
    const headers = { ...(opts.headers || {}) };
    if (method !== 'GET' && csrf)
        headers['x-csrf-token'] = csrf;
    let payload = opts.raw;
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    let res;
    try {
        res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    }
    catch {
        throw new ApiError(0, 'network', 'The server could not be reached. Check that it is running and try again.');
    }
    const type = res.headers.get('content-type') || '';
    const json = type.includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok || !json?.ok) {
        const err = json?.error;
        if (res.status === 401 && !url.startsWith('/api/auth/')) {
            location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
        }
        if (res.status === 428 && err?.code === 'consent_required') {
            location.href = `/consent.html?next=${encodeURIComponent(location.pathname + location.search)}`;
        }
        throw new ApiError(res.status, err?.code || 'error', err?.message || `The request failed (HTTP ${res.status}).`, err?.details);
    }
    return { data: json.data, meta: json.meta };
}
export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body ?? {});
export const patch = (url, body) => api('PATCH', url, body);
export const put = (url, body) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);
export function uploadFile(file, query = '') {
    return api('POST', `/api/uploads${query}`, undefined, { raw: file, headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' } });
}
export async function signOut() {
    await api('POST', '/api/auth/logout').catch(() => undefined);
    location.href = '/login.html';
}
