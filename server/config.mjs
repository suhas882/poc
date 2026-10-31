// @ts-check
/**
 * Configuration comes only from environment variables (or a local .env file in
 * development). Secrets are read here, kept on the server, and never sent to
 * the browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Google's downloaded OAuth client file ("client_secret_....json"), used when GOOGLE_CLIENT_ID is not set.
 * Looked for at GOOGLE_CLIENT_FILE, then in the data folder, then in the project folder. Both places are git-ignored.
 */
const googleCache = new Map();
function googleFile(env, dataDir) {
  const key = `${env.GOOGLE_CLIENT_FILE || ''}|${dataDir}`;
  if (googleCache.has(key)) return googleCache.get(key);
  let out = { clientId: '', clientSecret: '', file: null };
  const candidates = env.GOOGLE_CLIENT_FILE ? [env.GOOGLE_CLIENT_FILE] : [dataDir, ROOT].flatMap(dir => {
    try { return fs.readdirSync(dir).filter(f => /^client_secret.*\.json$/i.test(f)).sort().map(f => path.join(dir, f)); } catch { return []; }
  });
  for (const file of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const c = j.web || j.installed;
      if (c?.client_id && c?.client_secret) { out = { clientId: c.client_id, clientSecret: c.client_secret, file }; break; }
    } catch { /* not a Google client file */ }
  }
  googleCache.set(key, out);
  return out;
}

/** Minimal .env loader: KEY=VALUE lines, optional quotes, # comments. Never overrides real env vars. */
export function loadDotEnv(file = path.join(ROOT, '.env'), env = process.env) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in env)) env[key] = value;
  }
}

const int = (v, d) => { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) ? n : d; };
const num = (v) => { const n = Number.parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };
const bool = (v, d = false) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v));

/** @param {NodeJS.ProcessEnv} env */
export function getConfig(env = process.env) {
  const port = int(env.PORT ?? env.POC_PORT, 8765);
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const production = env.NODE_ENV === 'production';
  return Object.freeze({
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    production,
    secureCookies: publicUrl.startsWith('https://'),
    trustProxy: bool(env.TRUST_PROXY, false),
    dataDir,
    dbPath: env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.join(dataDir, 'records.db'),
    /**
     * Real sources (mail, uploads of staff files, databases, Phone Link) are off unless REAL_SOURCES=true is set on the
     * server. The hosted demo leaves it unset, so it only ever holds Tier 0 data: invented records and public documents.
     * Nothing in the web interface can turn it on. DEMO_ONLY=true (older setting) always forces it off.
     */
    realSources: bool(env.REAL_SOURCES, false) && !bool(env.DEMO_ONLY, false),
    demoOnly: false,
    setupToken: env.SETUP_TOKEN || '',
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
    encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY || '',
    ipHashSalt: env.IP_HASH_SALT || '',
    anthropic: Object.freeze({
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      maxTokens: int(env.ANTHROPIC_MAX_TOKENS, 2048),
      timeoutMs: int(env.ANTHROPIC_TIMEOUT_MS, 60000),
      maxRetries: int(env.ANTHROPIC_MAX_RETRIES, 3),
      /** USD per million tokens; leave unset to record tokens without a cost estimate. */
      priceInputPerMTok: num(env.ANTHROPIC_PRICE_INPUT_PER_MTOK),
      priceOutputPerMTok: num(env.ANTHROPIC_PRICE_OUTPUT_PER_MTOK),
      summarizeTopK: int(env.AI_SUMMARY_TOP_K, 8)
    }),
    embeddings: Object.freeze({
      /** none | voyage | openai-compatible */
      provider: (env.EMBEDDINGS_PROVIDER || 'none').toLowerCase(),
      apiKey: env.EMBEDDINGS_API_KEY || env.VOYAGE_API_KEY || '',
      model: env.EMBEDDINGS_MODEL || '',
      baseUrl: (env.EMBEDDINGS_BASE_URL || '').replace(/\/+$/, ''),
      batchSize: int(env.EMBEDDINGS_BATCH_SIZE, 64),
      /** Record text is sent to an outside embedding service only after an approved model and hosting are named. */
      recordContentApproved: bool(env.EMBEDDINGS_RECORD_CONTENT_APPROVED, false)
    }),
    google: Object.freeze({
      clientId: env.GOOGLE_CLIENT_ID || googleFile(env, dataDir).clientId,
      clientSecret: env.GOOGLE_CLIENT_SECRET || googleFile(env, dataDir).clientSecret,
      redirectUri: env.GOOGLE_REDIRECT_URI || `${publicUrl}/oauth/google/callback`,
      authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
      revokeUrl: env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
      gmailApiBase: (env.GMAIL_API_BASE || 'https://gmail.googleapis.com/gmail/v1').replace(/\/+$/, '')
    }),
    gmail: Object.freeze({
      maxMessagesPerSync: int(env.GMAIL_MAX_MESSAGES_PER_SYNC, 500),
      defaultQuery: env.GMAIL_DEFAULT_QUERY ?? 'newer_than:2y',
      indexAttachments: bool(env.GMAIL_INDEX_ATTACHMENTS, true),
      maxAttachmentBytes: int(env.GMAIL_MAX_ATTACHMENT_BYTES, 10 * 1024 * 1024)
    }),
    uploads: Object.freeze({ maxBytes: int(env.UPLOAD_MAX_BYTES, 25 * 1024 * 1024) }),
    ocr: Object.freeze({ enabled: bool(env.OCR_ENABLED, true), lang: env.OCR_LANG || 'eng', langPath: env.OCR_LANG_PATH || '' }),
    phonelink: Object.freeze({ dbPath: env.PHONELINK_DB_PATH || null, syncMinutes: int(env.PHONELINK_SYNC_MINUTES, 5) }),
    database: Object.freeze({ queryTimeoutMs: int(env.DB_CONNECTOR_TIMEOUT_MS, 15000), maxRowsPerSync: int(env.DB_CONNECTOR_MAX_ROWS, 5000) }),
    retention: Object.freeze({
      searchHistoryDays: int(env.RETENTION_SEARCH_HISTORY_DAYS, 365),
      auditDays: int(env.RETENTION_AUDIT_DAYS, 730),
      aiUsageDays: int(env.RETENTION_AI_USAGE_DAYS, 365)
    }),
    rateLimits: Object.freeze({
      loginPerWindow: int(env.RATE_LIMIT_LOGIN, 10),
      apiPerMinute: int(env.RATE_LIMIT_API_PER_MINUTE, 240),
      searchPerMinute: int(env.RATE_LIMIT_SEARCH_PER_MINUTE, 30)
    })
  });
}

/** @typedef {ReturnType<typeof getConfig>} AppConfig */
