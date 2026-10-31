// @ts-check
/**
 * Android text messages through Microsoft Phone Link, with no export step.
 *
 * Phone Link (Windows) keeps a synced copy of the paired Android phone's SMS in a local SQLite file:
 *   %LOCALAPPDATA%\Packages\Microsoft.YourPhone_<id>\LocalCache\Indexed\<id>\System\Database\phone.db
 * Microsoft does not document this file, so nothing here assumes a fixed schema: the message table and its
 * columns are detected by name, and "Check this PC" reports what was found (names and counts only, never content).
 *
 * Safety:
 *  - It only works when this app runs on the same Windows PC, under the same Windows user, as Phone Link.
 *  - The live file is never opened. It is copied to a private temp folder, read there and the copy deleted.
 *  - Nothing is ever written to Phone Link or the phone.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../http.mjs';
import { parseJson } from '../db.mjs';
import { groupConversations } from '../ingest/messages.mjs';
import { upsertRecord } from '../ingest/pipeline.mjs';

const PKG_PREFIX = 'microsoft.yourphone_';

/** Running inside WSL (Linux on Windows)? Then the Windows drives are under /mnt. */
export const isWsl = () => process.platform === 'linux' && (() => { try { return /microsoft|wsl/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; } })();

/** Where Windows keeps per-user app data: %LOCALAPPDATA% natively, or C:\Users\*\AppData\Local seen from WSL. */
export function localAppDataDirs(env = process.env) {
  const dirs = [];
  if (process.platform === 'win32') {
    if (env.LOCALAPPDATA) dirs.push(env.LOCALAPPDATA);
    else if (env.USERPROFILE) dirs.push(path.join(env.USERPROFILE, 'AppData', 'Local'));
  } else if (isWsl()) {
    for (const drive of safeDir('/mnt').filter(d => /^[a-z]$/.test(d))) {
      const users = path.join('/mnt', drive, 'Users');
      for (const u of safeDir(users)) if (!/^(public|default|default user|all users)$/i.test(u)) dirs.push(path.join(users, u, 'AppData', 'Local'));
    }
  }
  return dirs;
}

/** Every phone.db Phone Link has on this PC, newest first. */
export function findPhoneLinkDatabases(config, env = process.env) {
  if (config.phonelink.dbPath) {
    const p = config.phonelink.dbPath;
    return fs.existsSync(p) ? [{ path: p, ...stat(p) }] : [];
  }
  const found = [];
  for (const local of localAppDataDirs(env)) {
    const pkgs = path.join(local, 'Packages');
    for (const pkg of safeDir(pkgs)) {
      if (!pkg.toLowerCase().startsWith(PKG_PREFIX)) continue;
      const indexed = path.join(pkgs, pkg, 'LocalCache', 'Indexed');
      for (const id of safeDir(indexed)) {
        const p = path.join(indexed, id, 'System', 'Database', 'phone.db');
        if (fs.existsSync(p)) found.push({ path: p, ...stat(p) });
      }
    }
  }
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

function safeDir(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function stat(p) {
  const s = fs.statSync(p);
  const wal = fs.existsSync(`${p}-wal`) ? fs.statSync(`${p}-wal`).mtimeMs : 0;
  return { bytes: s.size, modifiedMs: Math.max(s.mtimeMs, wal), modifiedAt: new Date(Math.max(s.mtimeMs, wal)).toISOString() };
}

/** Copy phone.db (plus its WAL journal, which holds the newest messages) somewhere private, open the copy, then clean up. */
export function withSnapshot(dbPath, tmpRoot, fn) {
  const dir = path.join(tmpRoot, `phonelink-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copy = path.join(dir, 'phone.db');
  let db;
  try {
    try {
      fs.copyFileSync(dbPath, copy);
      for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      throw new HttpError(409, 'phonelink_unreadable', code === 'EBUSY' || code === 'EPERM'
        ? 'Phone Link is holding its message file locked. Wait a few seconds and try again.'
        : 'The Phone Link message file could not be read. Check that Phone Link is set up for this Windows user.');
    }
    try { db = new DatabaseSync(copy); db.exec('PRAGMA query_only = ON'); }
    catch { throw new HttpError(409, 'phonelink_unreadable', 'The Phone Link message file is not a readable database. Open Phone Link once, let it sync, and try again.'); }
    return fn(db);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const pick = (cols, names) => { const lower = cols.map(c => c.toLowerCase()); for (const n of names) { const i = lower.indexOf(n); if (i >= 0) return cols[i]; } return null; };

/** Work out which table and columns hold the messages. Names only; no content is read. */
export function detectSchema(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => String(r.name));
  const columnsOf = (t) => db.prepare(`PRAGMA table_info(${q(t)})`).all().map(r => String(r.name));
  const BODY = ['body', 'text', 'message_body', 'msg_body', 'content', 'message_text'];
  const ranked = [...tables].sort((a, b) => score(b) - score(a));
  function score(t) {
    const n = t.toLowerCase();
    if (/mms|attach|part|notification|draft|fts/.test(n)) return -1;
    return n === 'message' ? 5 : n === 'messages' ? 4 : n === 'sms' ? 3 : n.includes('message') ? 2 : 0;
  }
  let table = null, cols = [];
  for (const t of ranked) {
    if (score(t) < 0) continue;
    const c = columnsOf(t);
    if (pick(c, BODY) && (score(t) > 0 || pick(c, ['thread_id', 'from_address', 'address']))) { table = t; cols = c; break; }
  }
  if (!table) return { tables, table: null, columns: null, contacts: null };
  const columns = {
    id: pick(cols, ['message_id', 'id', '_id', 'msg_id']),
    body: pick(cols, BODY),
    time: pick(cols, ['timestamp', 'date', 'sent_time', 'received_time', 'date_sent', 'time', 'created_at']),
    from: pick(cols, ['from_address', 'address', 'sender', 'sender_address', 'from', 'originator', 'phone_number']),
    to: pick(cols, ['recipient_list', 'to_address', 'recipients', 'to']),
    thread: pick(cols, ['thread_id', 'conversation_id', 'thread']),
    type: pick(cols, ['type', 'message_type', 'box', 'direction', 'folder'])
  };
  // Contact names: a table with display names, joined to phone numbers either directly or through an address table.
  let contacts = null;
  const lowerTables = tables.map(t => t.toLowerCase());
  const contactTable = tables[lowerTables.indexOf('contact')] ?? tables[lowerTables.indexOf('contacts')] ?? null;
  if (contactTable) {
    const cc = columnsOf(contactTable);
    const name = pick(cc, ['display_name', 'name', 'full_name']);
    const cid = pick(cc, ['contact_id', 'id', '_id']);
    const direct = pick(cc, ['phone_number', 'address', 'number']);
    const addrTable = tables[lowerTables.indexOf('address')] ?? tables[lowerTables.indexOf('phonenumber')] ?? tables[lowerTables.indexOf('phone_number')] ?? null;
    const ac = addrTable ? columnsOf(addrTable) : [];
    const addr = pick(ac, ['address', 'phone_number', 'number']);
    const acid = pick(ac, ['contact_id']);
    if (name && direct) contacts = { sql: `SELECT ${q(direct)} AS address, ${q(name)} AS name FROM ${q(contactTable)}` };
    else if (name && cid && addrTable && addr && acid) contacts = { sql: `SELECT a.${q(addr)} AS address, c.${q(name)} AS name FROM ${q(addrTable)} a JOIN ${q(contactTable)} c ON c.${q(cid)} = a.${q(acid)}` };
  }
  return { tables, table, columns, contacts };
}

/** Phone Link and Android store times in different units; tell them apart by size. */
export function toIsoTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'bigint') v = v > 10n ** 16n ? Number(v / 10000n - 11644473600000n) : Number(v);
  else if (typeof v === 'number' && v > 1e16) v = Math.round(v / 1e4 - 11644473600000);
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const ms = n > 1e16 ? n / 1e4 - 11644473600000 // Windows FILETIME (100 ns since 1601)
      : n > 1e14 ? n / 1000 // microseconds
      : n > 1e11 ? n // milliseconds
      : n * 1000; // seconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) || d.getFullYear() < 1995 ? null : d.toISOString();
  }
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const digits = (s) => String(s ?? '').replace(/\D/g, '').slice(-10);
/** Android message types: 1 received; 2 sent; 3 draft; 4 outbox; 5 failed; 6 queued. */
const isSent = (type, from) => {
  if (type == null || type === '') return !from;
  const n = Number(type);
  if (!Number.isNaN(n)) return n >= 2 && n !== 3;
  return /sent|out/i.test(String(type));
};

/** Read every message as plain objects (used by sync; check uses counts only). */
export function readMessages(db, schema, { ownerLabel = 'Me' } = {}) {
  const c = schema.columns;
  const sel = [`${c.body ? q(c.body) : "''"} AS body`, `${c.time ? q(c.time) : 'NULL'} AS at`, `${c.from ? q(c.from) : 'NULL'} AS sender`,
    `${c.to ? q(c.to) : 'NULL'} AS recips`, `${c.thread ? q(c.thread) : 'NULL'} AS thread`, `${c.type ? q(c.type) : 'NULL'} AS kind`];
  const stmt = db.prepare(`SELECT ${sel.join(', ')} FROM ${q(schema.table)}`);
  stmt.setReadBigInts(true);
  const rows = stmt.all()
    .map(r => ({ ...r, thread: typeof r.thread === 'bigint' ? String(r.thread) : r.thread, kind: typeof r.kind === 'bigint' ? Number(r.kind) : r.kind }));
  const names = new Map();
  if (schema.contacts) {
    try { for (const r of db.prepare(schema.contacts.sql).all()) if (r.address && r.name) names.set(digits(r.address), String(r.name)); } catch { /* names are optional */ }
  }
  const label = (addr) => { const a = String(addr ?? '').trim(); if (!a) return ''; const n = names.get(digits(a)); return n ? `${n} (${a})` : a; };
  // A thread's other party is whoever sent the received messages; recipients cover threads with only sent messages.
  const partyByThread = new Map();
  for (const r of rows) {
    if (r.thread == null) continue;
    const sent = isSent(r.kind, r.sender);
    const other = sent ? String(r.recips ?? '').split(/[;,\s]+/).filter(Boolean)[0] : r.sender;
    if (other && !partyByThread.has(String(r.thread))) partyByThread.set(String(r.thread), String(other));
  }
  return rows.filter(r => r.body != null && String(r.body).trim()).map(r => {
    const sent = isSent(r.kind, r.sender);
    const party = partyByThread.get(String(r.thread)) ?? (sent ? String(r.recips ?? '') : String(r.sender ?? '')) ?? '';
    return {
      conversation: label(party) || (r.thread != null ? `Thread ${r.thread}` : 'Unknown'),
      from: sent ? ownerLabel : label(r.sender) || 'Unknown',
      to: sent ? label(party) : ownerLabel,
      at: toIsoTime(r.at),
      body: String(r.body)
    };
  });
}

export class PhoneLinkConnector {
  /** @param {{db: import('../db.mjs').Database, config: any}} deps */
  constructor({ db, config }) { this.db = db; this.config = config; this.tmp = path.join(config.dataDir, 'tmp'); }

  get available() { return Boolean(this.config.phonelink.dbPath) || process.platform === 'win32' || isWsl(); }

  /** What is on this PC: where the file is, whether messages were recognized, counts and date range. Never message text. */
  check() {
    const dbs = findPhoneLinkDatabases(this.config);
    if (!dbs.length) {
      const where = process.platform === 'win32' ? 'Windows' : isWsl() ? 'WSL (Linux on Windows)' : process.platform;
      return { found: false, runningOn: where, reason: this.available
        ? 'Phone Link has no synced messages for this Windows user yet. Open Phone Link, pair your Android phone, turn on Messages, and let it sync.'
        : `This app is running on ${where}, not on Windows, so it cannot see Phone Link. Start it with start.bat on the Windows PC where Phone Link is set up.` };
    }
    const file = dbs[0];
    return withSnapshot(file.path, this.tmp, (db) => {
      const schema = detectSchema(db);
      const base = { found: true, file: { modifiedAt: file.modifiedAt, bytes: file.bytes }, tables: schema.tables };
      if (!schema.table) return { ...base, recognized: false, reason: 'Phone Link’s file was found, but no message table was recognized. Tell your developer the table names shown here.' };
      const c = schema.columns;
      const statsStmt = db.prepare(`SELECT COUNT(*) AS n${c.thread ? `, COUNT(DISTINCT ${q(c.thread)}) AS threads` : ''}${c.time ? `, MIN(${q(c.time)}) AS oldest, MAX(${q(c.time)}) AS newest` : ''} FROM ${q(schema.table)}`);
      statsStmt.setReadBigInts(true);
      const stats = statsStmt.get() ?? {};
      return { ...base, recognized: true, table: schema.table, columns: c, contactNames: Boolean(schema.contacts),
        messages: Number(stats.n ?? 0n), conversations: stats.threads != null ? Number(stats.threads) : null, oldest: toIsoTime(stats.oldest), newest: toIsoTime(stats.newest) };
    });
  }

  /** Re-read Phone Link's copy and index conversations (one record per conversation per day). Records are kept even if Phone Link later drops old messages. */
  sync(source) {
    const dbs = findPhoneLinkDatabases(this.config);
    if (!dbs.length) throw new HttpError(409, 'phonelink_missing', 'Phone Link’s message file was not found on this PC. Open Phone Link and check that Messages is turned on.');
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'messages' };
    const owner = this.db.get('SELECT name FROM users WHERE id = ?', source.owner_user_id)?.name || 'Me';
    const messages = withSnapshot(dbs[0].path, this.tmp, (db) => {
      const schema = detectSchema(db);
      if (!schema.table) throw new HttpError(409, 'phonelink_unrecognized', 'Phone Link’s file was found, but its message table was not recognized. Use “Check this PC” on Connected Sources to see what was found.');
      return readMessages(db, schema, { ownerLabel: owner });
    });
    const counts = { added: 0, updated: 0, deleted: 0, skipped: 0, truncated: false };
    for (const g of groupConversations(messages, 'SMS')) {
      const r = upsertRecord(this.db, ctx, { ...g, documentType: 'Text messages', accessPermissions: {} });
      counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
    }
    this.db.run('UPDATE sources SET config = json_set(config, \'$.lastFileTime\', ?) WHERE id = ?', dbs[0].modifiedAt, source.id);
    return counts;
  }

  /** True when Phone Link's file changed since the last sync of this source. */
  isStale(source) {
    const dbs = findPhoneLinkDatabases(this.config);
    if (!dbs.length) return false;
    return parseJson(source.config, {}).lastFileTime !== dbs[0].modifiedAt;
  }
}

export const isPhoneLink = (source) => source?.type === 'messages' && parseJson(source.config, {}).provider === 'phonelink';
