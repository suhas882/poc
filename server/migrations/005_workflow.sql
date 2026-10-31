-- Round 2 workflow: request intake and deadline, versioned and locked plans, per-source status,
-- staff marks with routing, tamper-evident audit chain, city packs, review options.

ALTER TABLE tenants ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;

ALTER TABLE search_requests ADD COLUMN ref TEXT;
ALTER TABLE search_requests ADD COLUMN received_at TEXT;
ALTER TABLE search_requests ADD COLUMN channel TEXT;
ALTER TABLE search_requests ADD COLUMN requester_label TEXT;
ALTER TABLE search_requests ADD COLUMN due_date TEXT;
ALTER TABLE search_requests ADD COLUMN assigned_to TEXT;
ALTER TABLE search_requests ADD COLUMN handed_off_at TEXT;
ALTER TABLE search_requests ADD COLUMN handed_off_by TEXT;
ALTER TABLE search_requests ADD COLUMN approved_at TEXT;
ALTER TABLE search_requests ADD COLUMN approved_by TEXT;
ALTER TABLE search_requests ADD COLUMN pack TEXT;

CREATE TABLE plan_versions (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  plan TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed')),
  origin TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  UNIQUE (search_id, version)
);

CREATE TABLE search_runs (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('full', 'added_terms')),
  run_by TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  model TEXT,
  prompt_version TEXT,
  index_time TEXT,
  candidates INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  terms TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE source_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('searched', 'partial', 'failed', 'not_connected')),
  error TEXT,
  candidates INTEGER NOT NULL DEFAULT 0,
  query TEXT
);
CREATE INDEX idx_source_runs_search ON source_runs(search_id);

ALTER TABLE search_results ADD COLUMN found_in_version INTEGER;

CREATE TABLE candidate_routes (
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  routed_to TEXT NOT NULL,
  note TEXT,
  routed_by TEXT,
  routed_at TEXT NOT NULL,
  PRIMARY KEY (search_id, record_id)
);

CREATE TABLE custodian_checks (
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  department TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed')),
  note TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  PRIMARY KEY (search_id, department)
);

CREATE TABLE expansion_terms (
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_record_ids TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by TEXT,
  decided_at TEXT NOT NULL,
  plan_version INTEGER,
  PRIMARY KEY (search_id, term)
);

CREATE TABLE export_checks (
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  file_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scan_pending', 'scanned', 'plain_table')),
  reviewer TEXT,
  reviewed_on TEXT,
  note TEXT,
  recorded_by TEXT,
  recorded_at TEXT,
  PRIMARY KEY (search_id, file_kind)
);

CREATE TABLE text_reviews (
  search_id TEXT NOT NULL REFERENCES search_requests(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('city', 'personal', 'unsure')),
  decided_at TEXT,
  sent_at TEXT,
  PRIMARY KEY (search_id, record_id)
);

CREATE TABLE eval_labels (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reviewer1', 'reviewer2', 'adjudicator')),
  label TEXT NOT NULL CHECK (label IN ('relevant', 'not_relevant', 'unsure')),
  user_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scenario_id, record_id, role)
);

ALTER TABLE audit_events ADD COLUMN before_value TEXT;
ALTER TABLE audit_events ADD COLUMN after_value TEXT;
ALTER TABLE audit_events ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_events ADD COLUMN hash TEXT;
