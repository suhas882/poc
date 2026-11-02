-- migrate: foreign_keys off
-- Microsoft sources: Outlook mail and OneDrive through Microsoft Graph. SQLite cannot change a CHECK constraint
-- in place, so the sources table is rebuilt with the same columns and rows (SQLite's 12-step procedure).

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('synthetic', 'gmail', 'uploads', 'messages', 'database', 'outlook', 'onedrive')),
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
INSERT INTO sources_new (id, tenant_id, type, name, status, owner_user_id, visibility, allowed_roles, config, scopes, account_label,
  last_sync_at, last_sync_status, last_error, sync_cursor, created_at, updated_at)
  SELECT id, tenant_id, type, name, status, owner_user_id, visibility, allowed_roles, config, scopes, account_label,
  last_sync_at, last_sync_status, last_error, sync_cursor, created_at, updated_at FROM sources;
DROP TABLE sources;
ALTER TABLE sources_new RENAME TO sources;
CREATE INDEX idx_sources_tenant ON sources(tenant_id, type);
