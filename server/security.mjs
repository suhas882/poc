// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ---------------- passwords (scrypt) ---------------- */

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** @param {string} password */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** @param {string} password @param {string} stored */
export function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** A hash to compare against when the email is unknown, so timing doesn't reveal which accounts exist. */
export const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** @param {string} pw */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (/^(.)\1+$/.test(pw)) return 'Use a password that is not one repeated character.';
  return null;
}

/* ---------------- tokens and hashing ---------------- */

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ---------------- credential encryption (AES-256-GCM) ---------------- */

/**
 * Encrypts connector secrets. The key comes from CREDENTIAL_ENCRYPTION_KEY
 * (32 bytes, base64). In development only, a key file is generated beside the
 * database (data/.credential-key, mode 0600) so the app works out of the box.
 */
export class Vault {
  /** @param {Buffer} key @param {string} keyId */
  constructor(key, keyId) {
    if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (use: openssl rand -base64 32).');
    this.key = key;
    this.keyId = keyId;
  }

  /** @param {import('./config.mjs').AppConfig} config @param {(m: string) => void} [warn] */
  static fromConfig(config, warn = console.warn) {
    if (config.encryptionKey) {
      const key = Buffer.from(config.encryptionKey, 'base64');
      return new Vault(key, sha256(key).slice(0, 12));
    }
    if (config.production) return null; // connectors that need secrets will refuse to connect
    const file = path.join(config.dataDir, '.credential-key');
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
      warn(`[security] No CREDENTIAL_ENCRYPTION_KEY set. Generated a development key at ${file}. Set the variable in production.`);
    }
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    return new Vault(key, sha256(key).slice(0, 12));
  }

  /** @param {unknown} value any JSON-serialisable secret */
  seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
  }

  /** @param {string} sealed */
  open(sealed) {
    const [v, iv, tag, data] = String(sealed).split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised credential format.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8'));
  }
}

/* ---------------- rate limiting ---------------- */

/** Fixed-window counter per key, in memory. Fine for one process; use a shared store if you run several. */
export class RateLimiter {
  /** @param {number} limit @param {number} windowMs */
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** @type {Map<string, {count: number, reset: number}>} */
    this.hits = new Map();
  }
  /** @param {string} key @returns {{allowed: boolean, retryAfter: number}} */
  take(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.count++;
    if (this.hits.size > 50000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    return { allowed: e.count <= this.limit, retryAfter: Math.ceil((e.reset - now) / 1000) };
  }
  reset(key) { this.hits.delete(key); }
}

/* ---------------- privacy helpers ---------------- */

/** One-way hash of an IP for audit logs, so logs show patterns without storing addresses. */
export function hashIp(ip, salt) {
  if (!ip) return null;
  return sha256(`${salt}|${ip}`).slice(0, 16);
}

const SECRET_KEY = /(token|secret|password|authorization|cookie|verifier|api[_-]?key|credential)/i;

/** Remove secret-looking keys and truncate long strings before anything is logged. */
export function scrub(value, depth = 0) {
  if (depth > 4) return '[…]';
  if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (Array.isArray(value)) return value.slice(0, 25).map(v => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    return out;
  }
  return value;
}
