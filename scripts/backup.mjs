#!/usr/bin/env node
// Back up the app's data: a consistent snapshot of the SQLite database (taken while the app keeps running) plus
// the stored originals of uploaded files. Works the same on any host; copy the result off the server
// (Azure Blob Storage, AWS S3, or anywhere) for real protection.
//
//   node scripts/backup.mjs                        # writes DATA_DIR/backups/<timestamp>/
//   BACKUP_DIR=/mnt/backups BACKUP_KEEP=30 node scripts/backup.mjs
//   docker compose --env-file .env.production exec app node scripts/backup.mjs
//
// The credential encryption key is NOT included on purpose: keep it in your secret store. A restore needs the
// same CREDENTIAL_ENCRYPTION_KEY, or stored Google/Microsoft connections must be reconnected.
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, loadDotEnv } from '../server/config.mjs';
import { Database } from '../server/db.mjs';

loadDotEnv();
const config = getConfig();
const root = path.resolve(process.env.BACKUP_DIR || path.join(config.dataDir, 'backups'));
const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || '14', 10) || 14);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.join(root, stamp);
fs.mkdirSync(dir, { recursive: true });

// VACUUM INTO writes a complete, consistent copy even while the server is writing (no WAL files to carry along).
const db = new Database(config.dbPath);
const target = path.join(dir, 'records.db');
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
const counts = Object.fromEntries(['users', 'sources', 'records', 'audit_events'].map(t => [t, db.get(`SELECT COUNT(*) AS n FROM ${t}`).n]));

const uploads = path.join(config.dataDir, 'uploads');
if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(dir, 'uploads'), { recursive: true });

// Verify the snapshot opens and matches before calling it good.
const check = new Database(target);
const ok = check.get('PRAGMA integrity_check').integrity_check === 'ok' && Object.entries(counts).every(([t, n]) => check.get(`SELECT COUNT(*) AS n FROM ${t}`).n === n);
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), counts, integrity: ok ? 'ok' : 'FAILED', includesKey: false }, null, 2));
if (!ok) { console.error(`Backup ${dir} FAILED its integrity check.`); process.exit(1); }

// Keep the newest `keep` backups.
const all = fs.readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}T/.test(d)).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
console.log(`Backup written to ${dir} (${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')}). Keeping the newest ${keep}.`);
