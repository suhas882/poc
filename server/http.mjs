// @ts-check
/** HTTP plumbing: consistent JSON responses, body limits, cookies, routing and input validation. */

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code machine-readable, e.g. 'not_found'
   * @param {string} message plain-language explanation for the person using the app
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'"
});

/** @param {import('node:http').ServerResponse} res */
export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

export const ok = (res, data, meta, status = 200) => sendJson(res, status, meta ? { ok: true, data, meta } : { ok: true, data });

/** @param {import('node:http').ServerResponse} res @param {unknown} err */
export function sendError(res, err, log = console.error) {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  // Never leak stack traces or internal messages.
  log('[server] unexpected error:', err instanceof Error ? err.stack : err);
  sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: 'Something went wrong on the server. The error has been logged.' } });
}

/**
 * Read the raw body, enforcing a byte limit while streaming.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, 'payload_too_large', `The upload is larger than the ${Math.round(limit / 1048576)} MB limit.`)); }
    const parts = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { req.destroy(); reject(new HttpError(413, 'payload_too_large', `The upload is larger than the ${Math.round(limit / 1048576)} MB limit.`)); return; }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** @param {import('node:http').IncomingMessage} req */
export async function readJson(req, limit = 1024 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type', 'Send the request body as JSON.');
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.'); }
}

/** @param {string | undefined} header */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return out;
}

/** @param {string} name @param {string} value @param {{maxAge?: number, secure?: boolean, httpOnly?: boolean, sameSite?: string, path?: string}} o */
export function serializeCookie(name, value, o = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`, `SameSite=${o.sameSite ?? 'Lax'}`];
  if (o.httpOnly !== false) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAge)}`);
  return parts.join('; ');
}

/* ---------------- routing ---------------- */

export class Router {
  constructor() { /** @type {{method: string, re: RegExp, keys: string[], handler: Function}[]} */ this.routes = []; }
  /** @param {string} method @param {string} pattern e.g. /api/sources/:id/sync @param {Function} handler */
  on(method, pattern, handler) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }
  /** @param {string} method @param {string} pathname */
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      /** @type {Record<string, string>} */
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ''); });
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/* ---------------- validation ---------------- */

/**
 * Tiny declarative validator. Each field spec: {type, required?, max?, min?, values?, items?, pattern?, default?}.
 * Unknown fields are dropped. Throws a 400 listing every problem.
 * @param {Record<string, any>} spec
 * @param {any} input
 */
export function validate(spec, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invalid_input', 'Send a JSON object.');
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {Record<string, string>} */
  const errors = {};
  for (const [key, s] of Object.entries(spec)) {
    let v = input[key];
    if (v === undefined || v === null || v === '') {
      if (s.required) errors[key] = 'is required';
      else if ('default' in s) out[key] = s.default;
      continue;
    }
    const err = checkValue(s, v);
    if (typeof err === 'string') errors[key] = err;
    else out[key] = err.value;
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'invalid_input', 'Some fields need attention: ' + Object.entries(errors).map(([k, e]) => `${k} ${e}`).join('; ') + '.', { fields: errors });
  return out;
}

/** @returns {string | {value: any}} */
function checkValue(s, v) {
  switch (s.type) {
    case 'string': {
      if (typeof v !== 'string') return 'must be text';
      const t = s.trim === false ? v : v.trim();
      if (s.min && t.length < s.min) return `must be at least ${s.min} characters`;
      if (t.length > (s.max ?? 2000)) return `must be at most ${s.max ?? 2000} characters`;
      if (s.values && !s.values.includes(t)) return `must be one of: ${s.values.join(', ')}`;
      if (s.pattern && !s.pattern.test(t)) return s.patternMessage || 'has an invalid format';
      return { value: t };
    }
    case 'int': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n)) return 'must be a whole number';
      if (s.min !== undefined && n < s.min) return `must be at least ${s.min}`;
      if (s.max !== undefined && n > s.max) return `must be at most ${s.max}`;
      return { value: n };
    }
    case 'bool': return typeof v === 'boolean' ? { value: v } : 'must be true or false';
    case 'date': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return 'must be a date like 2025-01-31';
      return { value: v };
    }
    case 'array': {
      if (!Array.isArray(v)) return 'must be a list';
      if (v.length > (s.max ?? 100)) return `must have at most ${s.max ?? 100} items`;
      const items = [];
      for (const item of v) {
        const r = checkValue(s.items, item);
        if (typeof r === 'string') return `items ${r}`;
        items.push(r.value);
      }
      return { value: items };
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
      try { return { value: s.fields ? validate(s.fields, v) : v }; } catch (e) { return e instanceof HttpError ? e.message : 'is invalid'; }
    }
    default: return 'has an unsupported type';
  }
}

/** Pagination params from the query string, bounded. */
export function pageParams(url, defSize = 20, maxSize = 100) {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(maxSize, Math.max(1, Number.parseInt(url.searchParams.get('pageSize') || String(defSize), 10) || defSize));
  return { page, size, offset: (page - 1) * size };
}
