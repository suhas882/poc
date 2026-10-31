// Browser API client: JSON in/out, CSRF header on writes, consistent errors.

export interface User { id: string; name: string; email: string; role: string; permissions: string[] }
export interface AuthStatus { demoOnly: boolean; setupRequired: boolean; consentRequired?: boolean; user: User | null; csrfToken: string | null; offline?: boolean }
export interface Page<T> { data: T; meta?: { page: number; pageSize: number; total: number; [k: string]: unknown } }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

let csrf: string | null = null;
let statusPromise: Promise<AuthStatus> | null = null;

export function authStatus(refresh = false): Promise<AuthStatus> {
  if (!statusPromise || refresh) {
    statusPromise = fetch('/api/auth/status', { credentials: 'same-origin' })
      .then(async r => {
        if (!r.ok) throw new Error('status unavailable');
        const body = await r.json();
        csrf = body.data.csrfToken;
        return body.data as AuthStatus;
      })
      .catch(() => ({ demoOnly: true, setupRequired: false, user: null, csrfToken: null, offline: true }));
  }
  return statusPromise;
}

export const can = (s: AuthStatus, perm: string) => Boolean(s.user?.permissions.includes(perm));

export async function api<T = unknown>(method: string, url: string, body?: unknown, opts: { raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<Page<T>> {
  if (method !== 'GET' && csrf === null) await authStatus();
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  let payload: BodyInit | undefined = opts.raw;
  if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
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
  return { data: json.data as T, meta: json.meta };
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const patch = <T>(url: string, body: unknown) => api<T>('PATCH', url, body);
export const put = <T>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T>(url: string) => api<T>('DELETE', url);

export function uploadFile<T>(file: File, query = ''): Promise<Page<T>> {
  return api<T>('POST', `/api/uploads${query}`, undefined, { raw: file, headers: { 'x-file-name': encodeURIComponent(file.name), 'content-type': file.type || 'application/octet-stream' } });
}

export async function signOut() {
  await api('POST', '/api/auth/logout').catch(() => undefined);
  location.href = '/login.html';
}
