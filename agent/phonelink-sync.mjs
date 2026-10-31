#!/usr/bin/env node
// PC sync helper: sends the Android texts that Windows Phone Link keeps on this PC to your hosted
// Public Records Search site (Render, AWS, ...), with no exporting. Run it with phonelink-sync.bat.
//
//   phonelink-sync.bat            set up on first run, then keep checking for new texts
//   phonelink-sync.bat --once     send what is new and exit
//   phonelink-sync.bat --full     send everything again (for example after the server's data was reset)
//   phonelink-sync.bat --setup    change the site address or key
//
// Safety: it only reads Phone Link's copy of your texts (never the live file, never your phone), only sends to
// the site you enter, only over HTTPS, and the key can only add texts to your own private source.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { detectSchema, findPhoneLinkDatabases, readMessages, withSnapshot } from '../server/connectors/phonelink.mjs';
import { groupConversations } from '../server/ingest/messages.mjs';

const VERSION = '1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF_DIR = process.env.PHONELINK_SYNC_DIR || HERE;
const CONFIG_FILE = path.join(CONF_DIR, 'phonelink-sync.json');
const STATE_FILE = path.join(CONF_DIR, 'phonelink-sync-state.json');
const BATCH = 1500;
const args = new Set(process.argv.slice(2));

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const readJsonFile = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJsonFile = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 });

async function setup(existing) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nSet up the PC sync helper. You need two things from the website:');
  console.log('  1. Its address, for example https://your-app.onrender.com');
  console.log('  2. A helper key from Connected Sources -> Android texts (Phone Link) -> PC sync helper\n');
  let url = (await rl.question(`Website address${existing?.url ? ` [${existing.url}]` : ''}: `)).trim() || existing?.url || '';
  url = url.replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  const key = (await rl.question('Helper key (starts with prs_agent_): ')).trim() || existing?.key || '';
  const minutes = Number((await rl.question('Check for new texts every how many minutes? [3]: ')).trim() || 3);
  rl.close();
  const cfg = { url, key, intervalMinutes: Number.isFinite(minutes) && minutes >= 1 ? Math.round(minutes) : 3 };
  writeJsonFile(CONFIG_FILE, cfg);
  console.log(`\nSaved to ${CONFIG_FILE}. Keep this file private: it contains your key.\n`);
  return cfg;
}

function checkConfig(cfg) {
  if (!/^https?:\/\/[^/\s]+/i.test(cfg.url || '')) throw new Error('The website address is missing. Run phonelink-sync.bat --setup.');
  if (!/^prs_agent_[A-Za-z0-9_-]{20,}$/.test(cfg.key || '')) throw new Error('The helper key is missing or incomplete. Run phonelink-sync.bat --setup.');
  const u = new URL(cfg.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error(`Refusing to send texts over plain http to ${u.host}. Use the https:// address of your site.`);
}

async function call(cfg, method, route, body) {
  let res;
  try {
    res = await fetch(cfg.url + route, {
      method, headers: { authorization: `Bearer ${cfg.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000)
    });
  } catch (err) {
    throw Object.assign(new Error(`Could not reach ${cfg.url} (${err?.cause?.code || err?.name || 'network error'}). Will try again.`), { retry: true });
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401) throw Object.assign(new Error(json?.error?.message || 'The helper key was refused.'), { fatal: true });
  if (!res.ok || !json?.ok) throw Object.assign(new Error(json?.error?.message || `The site answered HTTP ${res.status}.`), { retry: res.status >= 500 || res.status === 429 });
  return json.data;
}

const groupKey = (m) => `${m.conversation}|${m.at ? m.at.slice(0, 10) : 'undated'}`;
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

async function syncOnce(cfg, me, { full = false } = {}) {
  const dbs = findPhoneLinkDatabases({ phonelink: { dbPath: process.env.PHONELINK_DB_PATH || null } });
  if (!dbs.length) { log('Phone Link has no synced texts for this Windows user yet. Open Phone Link, pair your phone and turn on Messages.'); return; }
  const tmp = path.join(os.tmpdir(), 'prs-phonelink-sync');
  const messages = withSnapshot(dbs[0].path, tmp, (db) => {
    const schema = detectSchema(db);
    if (!schema.table) throw Object.assign(new Error(`Phone Link's message table was not recognized. Tables found: ${schema.tables.join(', ')}. Send this line to your developer.`), { fatal: true });
    return readMessages(db, schema, { ownerLabel: me.userName || 'Me' });
  });

  // Group the way the server does (one record per conversation per day) and only send days that changed.
  const state = full ? { sent: {} } : readJsonFile(STATE_FILE, { sent: {} });
  const byKey = new Map();
  for (const m of messages) (byKey.get(groupKey(m)) ?? byKey.set(groupKey(m), []).get(groupKey(m))).push(m);
  const changed = [];
  for (const g of groupConversations(messages, 'SMS')) {
    const h = hash(g.content);
    if (state.sent[g.sourceRecordId] !== h) changed.push({ key: g.sourceRecordId, h, msgs: byKey.get(g.sourceRecordId) || [] });
  }
  if (!changed.length) { log(`No new texts (${messages.length} in Phone Link).`); return; }

  let batch = [], keys = [], sentDays = 0;
  const flush = async () => {
    if (!batch.length) return;
    const r = await call(cfg, 'POST', '/api/agent/messages', { messages: batch, helperVersion: VERSION });
    for (const k of keys) state.sent[k.key] = k.h;
    writeJsonFile(STATE_FILE, state);
    sentDays += keys.length;
    log(`Sent ${r.received} texts: ${r.added} new and ${r.updated} updated conversation-days.`);
    batch = []; keys = [];
  };
  for (const c of changed) {
    const msgs = c.msgs.map(m => ({ conversation: m.conversation.slice(0, 200), from: (m.from || '').slice(0, 200), to: (m.to || '').slice(0, 200), at: m.at, body: m.body.slice(0, 20000) }));
    if (batch.length && batch.length + msgs.length > BATCH) await flush();
    batch.push(...msgs); keys.push(c);
  }
  await flush();
  log(`Up to date. ${sentDays} conversation-day(s) sent.`);
}

async function main() {
  console.log(`Public Records Search - PC sync helper ${VERSION}`);
  let cfg = readJsonFile(CONFIG_FILE, null);
  if (!cfg || args.has('--setup')) cfg = await setup(cfg);
  checkConfig(cfg);

  let me;
  for (;;) {
    try { me = await call(cfg, 'GET', '/api/agent/whoami'); break; }
    catch (err) {
      if (err.fatal) throw err;
      log(err.message); if (args.has('--once')) process.exit(1);
      await new Promise(r => setTimeout(r, 60_000));
    }
  }
  log(`Connected to ${cfg.url} as ${me.userName}. Texts go to "${me.sourceName}" (${me.records} records there now).`);
  // A hosted server may have lost its data (for example Render's free disk). If it has nothing, send everything again.
  let full = args.has('--full') || (me.records === 0 && Object.keys(readJsonFile(STATE_FILE, { sent: {} }).sent).length > 0);
  if (full && !args.has('--full')) log('The site has no texts from this PC yet, so everything will be sent.');

  let lastFile = '';
  for (;;) {
    try {
      const file = findPhoneLinkDatabases({ phonelink: { dbPath: process.env.PHONELINK_DB_PATH || null } })[0];
      const stamp = file ? `${file.path}|${file.modifiedAt}` : '';
      if (full || stamp !== lastFile || args.has('--once')) {
        await syncOnce(cfg, me, { full });
        lastFile = stamp; full = false;
      }
    } catch (err) {
      if (err.fatal) throw err;
      log(err.message);
    }
    if (args.has('--once')) break;
    await new Promise(r => setTimeout(r, cfg.intervalMinutes * 60_000));
  }
}

main().catch(err => { console.error(`\nStopped: ${err.message}\n`); process.exitCode = 1; });
