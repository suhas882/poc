// @ts-check
/**
 * Read-only database connector for PostgreSQL, MySQL and SQLite.
 *  - Only SELECT statements that this module builds itself; no user-supplied SQL.
 *  - Tables and columns must be on the source's allowlist AND exist in the live schema.
 *  - Identifiers are validated and quoted; values are always bound parameters.
 *  - Sessions are read-only with a statement timeout; transactions are rolled back.
 *  - An optional tenant column/value pair is added to every WHERE clause.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http.mjs';
import { parseJson } from '../db.mjs';
import { deleteRecord, upsertRecord } from '../ingest/pipeline.mjs';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const DIALECTS = ['postgres', 'mysql', 'sqlite'];

/** @param {string} dialect @param {string} name */
export function quoteIdent(dialect, name) {
  if (!IDENT.test(name)) throw new HttpError(400, 'invalid_identifier', `"${name}" is not an allowed table or column name.`);
  return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`;
}

/**
 * Build a parameterised SELECT.
 * @param {{dialect: string, table: string, columns: string[], idColumn: string, dateColumn?: string, since?: string | null,
 *   keyword?: string, keywordColumns?: string[], tenantColumn?: string, tenantValue?: string, limit: number, offset: number}} q
 */
export function buildSelect(q) {
  const qi = (n) => quoteIdent(q.dialect, n);
  const params = [];
  const where = [];
  const bind = (v) => { params.push(v); return q.dialect === 'postgres' ? `$${params.length}` : '?'; };
  if (q.tenantColumn) where.push(`${qi(q.tenantColumn)} = ${bind(q.tenantValue ?? '')}`);
  if (q.dateColumn && q.since) where.push(`${qi(q.dateColumn)} >= ${bind(q.since)}`);
  if (q.keyword && q.keywordColumns?.length) {
    const like = q.dialect === 'postgres' ? 'ILIKE' : 'LIKE';
    const term = `%${q.keyword.replace(/[\\%_]/g, m => '\\' + m)}%`;
    where.push('(' + q.keywordColumns.map(c => `${q.dialect === 'postgres' ? `CAST(${qi(c)} AS TEXT)` : qi(c)} ${like} ${bind(term)}${q.dialect === 'mysql' ? '' : " ESCAPE '\\'"}`).join(' OR ') + ')');
  }
  const cols = [...new Set(q.columns)].map(qi).join(', ');
  const text = `SELECT ${cols} FROM ${qi(q.table)}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${qi(q.idColumn)} LIMIT ${bind(Math.max(1, Math.min(1000, q.limit)))} OFFSET ${bind(Math.max(0, q.offset))}`;
  if (!/^SELECT /.test(text)) throw new Error('Only SELECT statements are allowed.');
  return { text, params };
}

/* ---------------- driver adapters ---------------- */

/**
 * A read-only session: {query(text, params) → rows[], columns(table?) → {table, column}[], close()}.
 * @param {{driver: string, host?: string, port?: number, database?: string, user?: string, ssl?: boolean, file?: string}} cfg
 * @param {{password?: string, connectionString?: string}} secret
 * @param {{timeoutMs: number, sqliteDir: string, connectOverride?: Function}} opts
 */
export async function openReadOnly(cfg, secret, opts) {
  if (opts.connectOverride) return opts.connectOverride(cfg, secret, opts);
  if (cfg.driver === 'sqlite') {
    const file = path.resolve(opts.sqliteDir, String(cfg.file || ''));
    if (!file.startsWith(path.resolve(opts.sqliteDir) + path.sep)) throw new HttpError(400, 'invalid_path', 'SQLite files must be inside the configured connector folder (DB_CONNECTOR_SQLITE_DIR).');
    if (!fs.existsSync(file)) throw new HttpError(400, 'not_found', 'That SQLite file does not exist in the connector folder.');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      dialect: 'sqlite',
      async query(text, params) { return db.prepare(text).all(...params); },
      async columns() {
        const out = [];
        for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all()) {
          for (const c of db.prepare('SELECT name, type FROM pragma_table_info(?)').all(t.name)) out.push({ table: String(t.name), column: String(c.name), type: String(c.type) });
        }
        return out;
      },
      async close() { db.close(); }
    };
  }
  if (cfg.driver === 'postgres') {
    let pg;
    try { pg = (await import('pg')).default; } catch { throw new HttpError(503, 'driver_missing', 'The PostgreSQL driver is not installed. Run "npm install pg".'); }
    const client = new pg.Client({
      ...(secret.connectionString ? { connectionString: secret.connectionString } : { host: cfg.host, port: cfg.port || 5432, database: cfg.database, user: cfg.user, password: secret.password }),
      ssl: cfg.ssl ? { rejectUnauthorized: true } : undefined, statement_timeout: opts.timeoutMs, query_timeout: opts.timeoutMs + 1000, connectionTimeoutMillis: 10000
    });
    await client.connect();
    return makePgSession(client, opts.timeoutMs, () => client.end());
  }
  if (cfg.driver === 'mysql') {
    let mysql;
    try { mysql = await import('mysql2/promise'); } catch { throw new HttpError(503, 'driver_missing', 'The MySQL driver is not installed. Run "npm install mysql2".'); }
    const conn = await mysql.createConnection({
      ...(secret.connectionString ? { uri: secret.connectionString } : { host: cfg.host, port: cfg.port || 3306, database: cfg.database, user: cfg.user, password: secret.password }),
      ssl: cfg.ssl ? {} : undefined, multipleStatements: false, connectTimeout: 10000
    });
    return makeMysqlSession(conn, opts.timeoutMs, () => conn.end());
  }
  throw new HttpError(400, 'unsupported_driver', `Unsupported database type "${cfg.driver}". Use postgres, mysql or sqlite.`);
}

/**
 * Read-only PostgreSQL session over any client with query(text, params) → {rows}.
 * @param {{query: (text: string, params?: unknown[]) => Promise<{rows: any[]}>}} client
 */
export async function makePgSession(client, timeoutMs, end) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
  return {
    dialect: 'postgres',
    async query(text, params) { return (await client.query(text, params)).rows; },
    async columns() {
      const rows = (await client.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position")).rows;
      return rows.map(r => ({ table: r.table_name, column: r.column_name, type: r.data_type }));
    },
    async close() { try { await client.query('ROLLBACK'); } finally { await end(); } }
  };
}

/**
 * Read-only MySQL session over a mysql2/promise connection.
 * @param {{query: Function}} conn
 */
export async function makeMysqlSession(conn, timeoutMs, end) {
  await conn.query('SET SESSION TRANSACTION READ ONLY');
  await conn.query('START TRANSACTION READ ONLY');
  return {
    dialect: 'mysql',
    async query(text, params) { const [rows] = await conn.query({ sql: text, timeout: timeoutMs }, params); return /** @type {any[]} */ (rows); },
    async columns() {
      const [rows] = await conn.query('SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS d FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
      return /** @type {any[]} */ (rows).map(r => ({ table: r.t, column: r.c, type: r.d }));
    },
    async close() { try { await conn.query('ROLLBACK'); } finally { await end(); } }
  };
}

/* ---------------- connector ---------------- */

/** Check a table mapping against the live schema; returns problems in plain language. */
export function checkMapping(mapping, schemaColumns) {
  const cols = new Set(schemaColumns.filter(c => c.table === mapping.name).map(c => c.column));
  if (!cols.size) return [`Table "${mapping.name}" was not found.`];
  const needed = [mapping.idColumn, mapping.titleColumn, ...(mapping.contentColumns || []), mapping.dateColumn, mapping.departmentColumn, mapping.typeColumn].filter(Boolean);
  return needed.filter(c => !cols.has(c)).map(c => `Column "${c}" was not found in "${mapping.name}".`);
}

export class DatabaseConnector {
  /** @param {{db: import('../db.mjs').Database, config: import('../config.mjs').AppConfig, vault: import('../security.mjs').Vault | null, connectOverride?: Function, sqliteDir?: string}} deps */
  constructor({ db, config, vault, connectOverride, sqliteDir }) {
    this.db = db;
    this.config = config;
    this.vault = vault;
    this.connectOverride = connectOverride;
    this.sqliteDir = sqliteDir ?? path.join(config.dataDir, 'connectors');
  }

  opts() { return { timeoutMs: this.config.database.queryTimeoutMs, sqliteDir: this.sqliteDir, connectOverride: this.connectOverride }; }

  secretFor(sourceId) {
    const row = this.db.get('SELECT ciphertext FROM source_credentials WHERE source_id = ?', sourceId);
    return row && this.vault ? this.vault.open(row.ciphertext) : {};
  }

  /** Connect with the given settings and list tables/columns (used before saving a source). */
  async inspect(cfg, secret) {
    const session = await openReadOnly(cfg, secret, this.opts());
    try { return await session.columns(); } finally { await session.close(); }
  }

  /** Run a bounded preview with optional keyword/date filters. Read-only. */
  async preview(source, { table, keyword, since, limit = 20 }) {
    const cfg = parseJson(source.config, {});
    const mapping = (cfg.tables || []).find(t => t.name === table);
    if (!mapping) throw new HttpError(400, 'table_not_allowed', 'That table is not on this source’s allowlist.');
    const session = await openReadOnly(cfg, this.secretFor(source.id), this.opts());
    try {
      const problems = checkMapping(mapping, await session.columns());
      if (problems.length) throw new HttpError(409, 'schema_changed', problems.join(' '));
      const q = buildSelect({ dialect: session.dialect, table, columns: columnsFor(mapping), idColumn: mapping.idColumn, dateColumn: mapping.dateColumn, since,
        keyword, keywordColumns: [mapping.titleColumn, ...(mapping.contentColumns || [])], tenantColumn: cfg.tenantColumn, tenantValue: cfg.tenantValue, limit, offset: 0 });
      return (await session.query(q.text, q.params)).map(row => toRecord(row, mapping, source).preview);
    } finally { await session.close(); }
  }

  /** Copy allowlisted rows into the index; remove rows that disappeared (full sync only). */
  async sync(source) {
    const cfg = parseJson(source.config, {});
    const ctx = { tenantId: source.tenant_id, sourceId: source.id, sourceType: 'database' };
    const counts = { added: 0, updated: 0, deleted: 0, skipped: 0, truncated: false };
    const session = await openReadOnly(cfg, this.secretFor(source.id), this.opts());
    const seen = new Set();
    try {
      const schema = await session.columns();
      for (const mapping of cfg.tables || []) {
        const problems = checkMapping(mapping, schema);
        if (problems.length) throw new HttpError(409, 'schema_changed', problems.join(' '));
        for (let offset = 0; ; offset += 500) {
          if (counts.added + counts.updated + counts.skipped >= this.config.database.maxRowsPerSync) { counts.truncated = true; break; }
          const q = buildSelect({ dialect: session.dialect, table: mapping.name, columns: columnsFor(mapping), idColumn: mapping.idColumn,
            tenantColumn: cfg.tenantColumn, tenantValue: cfg.tenantValue, limit: 500, offset });
          const rows = await session.query(q.text, q.params);
          for (const row of rows) {
            const { record } = toRecord(row, mapping, source);
            seen.add(record.sourceRecordId);
            const r = upsertRecord(this.db, ctx, record);
            counts[r.status === 'unchanged' ? 'skipped' : r.status]++;
          }
          if (rows.length < 500) break;
        }
      }
    } finally { await session.close(); }
    if (!counts.truncated) {
      for (const row of this.db.all('SELECT id, source_record_id FROM records WHERE source_id = ?', source.id)) {
        if (!seen.has(row.source_record_id)) { deleteRecord(this.db, row.id); counts.deleted++; }
      }
    }
    return counts;
  }
}

function columnsFor(m) {
  return [m.idColumn, m.titleColumn, ...(m.contentColumns || []), m.dateColumn, m.departmentColumn, m.typeColumn].filter(Boolean);
}

function toRecord(row, m, source) {
  const id = String(row[m.idColumn]);
  const content = (m.contentColumns || []).map(c => row[c] == null || row[c] === '' ? '' : `${c}: ${row[c] instanceof Date ? row[c].toISOString() : row[c]}`).filter(Boolean).join('\n');
  const date = m.dateColumn && row[m.dateColumn] != null ? new Date(row[m.dateColumn]).toISOString() : null;
  const record = {
    sourceRecordId: `${m.name}:${id}`,
    title: String(row[m.titleColumn] ?? `${m.name} ${id}`),
    content,
    createdAt: date,
    modifiedAt: date,
    department: m.departmentColumn ? String(row[m.departmentColumn] ?? '') || null : null,
    documentType: m.typeColumn ? String(row[m.typeColumn] ?? '') || m.label || m.name : m.label || m.name,
    sourceUrl: m.urlTemplate ? m.urlTemplate.replace('{id}', encodeURIComponent(id)) : null
  };
  return { record, preview: { id, title: record.title, date, department: record.department, excerpt: content.slice(0, 300) } };
}
