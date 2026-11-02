-- Access requests from people who signed in with Google or Microsoft but have no account here.
-- Nothing is created until a Supervisor approves; approval creates the user in the Supervisor's own organization
-- and links the exact provider account that asked (provider + subject), never an email match.

CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  organization TEXT NOT NULL,
  reason TEXT NOT NULL,
  -- When the organization typed matches one on this server, only that organization's Supervisors see the request.
  target_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  decided_at TEXT,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  decided_role TEXT,
  decision_note TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
-- One open request per provider account, and one per email address.
CREATE UNIQUE INDEX idx_access_requests_open_subject ON access_requests(provider, subject) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_access_requests_open_email ON access_requests(email) WHERE status = 'pending';
CREATE INDEX idx_access_requests_status ON access_requests(status, created_at);
