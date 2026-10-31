// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite prints an ExperimentalWarning on load; silence only that one.
const originalEmitWarning = process.emitWarning;
process.emitWarning = /** @type {typeof process.emitWarning} */ (function (warning, ...rest) {
  const message = typeof warning === 'string' ? warning : warning?.message;
  if (message && /SQLite is an experimental feature/.test(message)) return;
  // @ts-ignore - forwarding the original arguments
  return originalEmitWarning.call(process, warning, ...rest);
});
const { DatabaseSync } = await import('node:sqlite');

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Thin wrapper over node:sqlite with migrations and transactions.
 * All SQL uses bound parameters; identifiers are never built from user input.
 */
export class Database {
  /** @param {string} file ':memory:' or a path */
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.depth = 0;
  }

  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT name FROM schema_migrations').map(r => r.name));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    const ran = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      this.tx(() => {
        this.db.exec(sql);
        this.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', file, new Date().toISOString());
      });
      ran.push(file);
    }
    return ran;
  }

  /** @returns {any[]} */
  all(sql, ...params) { return /** @type {any[]} */ (this.db.prepare(sql).all(...params)); }
  /** @returns {any} */
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  exec(sql) { this.db.exec(sql); }

  /**
   * Run fn inside a transaction (nested calls use savepoints).
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  tx(fn) {
    const sp = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  close() { this.db.close(); }
}

export const nowIso = () => new Date().toISOString();
export const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };
