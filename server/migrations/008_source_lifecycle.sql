-- migrate: foreign_keys off
-- Source lifecycle: 'pending_approval' (connected by a non-Supervisor while approval is required; never searched or
-- synced until a Supervisor approves), and the Google Drive and SharePoint source types. Rebuilt like 007.

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('synthetic', 'gmail', 'gdrive', 'uploads', 'messages', 'database', 'outlook', 'onedrive', 'sharepoint')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_attention', 'disconnected', 'syncing', 'pending_approval')),
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

-- Automatic retries of a failed sync (throttling, temporary outages) are recorded on the job.
ALTER TABLE sync_jobs ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
