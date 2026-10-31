-- Public Records Search: initial schema.
-- Every tenant-owned row carries tenant_id; every query filters on it.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL
);
INSERT INTO roles (id, label, description) VALUES
  ('admin', 'Administrator', 'Manages users, settings and every source. Can search and export.'),
  ('records_officer', 'Records officer', 'Connects sources, uploads files, searches, reviews and exports.'),
  ('reviewer', 'Reviewer', 'Searches sources shared with reviewers and records relevance decisions.'),
  ('auditor', 'Auditor', 'Reads audit logs and search history. Cannot search or change anything.');

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL REFERENCES roles(id),
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  UNIQUE (email)
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- A connected source: one Gmail mailbox, one upload collection, one database, etc.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('synthetic', 'gmail', 'uploads', 'messages', 'database')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_attention', 'disconnected', 'syncing')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- 'owner': only the connecting user can search it. 'roles': users whose role is in allowed_roles (empty = every role that can search).
  visibility TEXT NOT NULL DEFAULT 'owner' CHECK (visibility IN ('owner', 'roles')),
  allowed_roles TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL DEFAULT '{}',
  scopes TEXT NOT NULL DEFAULT '[]',
  account_label TEXT,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_error TEXT,
  sync_cursor TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sources_tenant ON sources(tenant_id, type);

-- Encrypted secrets (OAuth tokens, database passwords). The key lives outside the database.
CREATE TABLE source_credentials (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL
);

-- Sub-units inside a source that can be switched on or off (Gmail labels, database tables).
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  UNIQUE (source_id, name)
);

-- The common record shape every connector normalizes into.
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK (is_synthetic IN (0, 1)),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  sender TEXT,
  recipients TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  modified_at TEXT,
  department TEXT,
  document_type TEXT,
  keywords TEXT NOT NULL DEFAULT '[]',
  extracted_entities TEXT NOT NULL DEFAULT '{}',
  access_permissions TEXT NOT NULL DEFAULT '{}',
  source_url TEXT,
  parent_record_id TEXT,
  thread_key TEXT,
  checksum TEXT NOT NULL,
  duplicate_of TEXT,
  ingestion_timestamp TEXT NOT NULL,
  UNIQUE (source_id, source_record_id)
);
CREATE INDEX idx_records_tenant ON records(tenant_id, is_synthetic);
CREATE INDEX idx_records_source ON records(source_id);
CREATE INDEX idx_records_checksum ON records(tenant_id, checksum);
CREATE INDEX idx_records_created ON records(tenant_id, created_at);
CREATE INDEX idx_records_thread ON records(tenant_id, thread_key);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  UNIQUE (record_id, ordinal)
);
CREATE INDEX idx_chunks_tenant ON chunks(tenant_id);

-- Full-text index over chunk text plus the record title. rowid = chunks.id.
CREATE VIRTUAL TABLE chunk_fts USING fts5(title, text, tokenize = 'porter unicode61');

CREATE TABLE embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL
);

CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_sync_jobs_source ON sync_jobs(source_id, started_at);

CREATE TABLE search_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'real')),
  request_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  result_count INTEGER,
  error TEXT
);
CREATE INDEX idx_search_requests_tenant ON search_requests(tenant_id, created_at);

CREATE TABLE search_plans (
  search_id TEXT PRIMARY KEY REFERENCES search_requests(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('claude', 'rules')),
  model TEXT,
  plan TEXT NOT NULL,
  confirmed_plan TEXT,
  confirmed_at TEXT
);

CREATE TABLE search_results (
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  match TEXT NOT NULL,
  group_key TEXT,
  PRIMARY KEY (search_id, record_id)
);
CREATE INDEX idx_search_results_rank ON search_results(search_id, rank);

CREATE TABLE search_summaries (
  search_id TEXT PRIMARY KEY REFERENCES search_requests(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  judgment TEXT NOT NULL CHECK (judgment IN ('relevant', 'not_relevant', 'unsure')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (search_id, record_id, user_id)
);
CREATE INDEX idx_evaluations_tenant ON evaluations(tenant_id, created_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  ip_hash TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_tenant ON audit_events(tenant_id, created_at);
CREATE INDEX idx_audit_action ON audit_events(tenant_id, action);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  user_id TEXT,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  attempts INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_usage_tenant ON ai_usage(tenant_id, created_at);

CREATE TABLE settings (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
