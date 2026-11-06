-- migrate: foreign_keys off
-- 1. Microsoft Teams chats as a source type (Microsoft Graph, delegated Chat.Read, work or school accounts).
-- 2. QR-assisted connections: a signed-in person starts a connection on the computer, scans a QR code, and finishes
--    the provider's own OAuth sign-in on the phone. Each attempt belongs to one user and one browser session, expires
--    within minutes, works once, and is marked connected only by a valid OAuth callback carrying its own state.

CREATE TABLE sources_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('synthetic', 'gmail', 'gdrive', 'uploads', 'messages', 'database', 'outlook', 'onedrive', 'sharepoint', 'teams')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'needs_attention', 'disconnected', 'syncing', 'pending_approval')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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

CREATE TABLE qr_connect_attempts (
  id TEXT PRIMARY KEY,                       -- shown to the computer that started it; never in the QR code
  ref_hash TEXT NOT NULL UNIQUE,             -- SHA-256 of the unguessable reference in the QR code
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,                -- the browser session that started it; only it can watch or cancel
  app TEXT NOT NULL CHECK (app IN ('gmail', 'gdrive', 'outlook', 'onedrive', 'sharepoint', 'teams')),
  options TEXT NOT NULL DEFAULT '{}',        -- sharing and SharePoint site; no secrets
  match_code TEXT NOT NULL,                  -- two digits shown on both screens, so a forwarded code is noticed
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'authorizing', 'connected', 'failed', 'cancelled', 'expired')),
  state_hash TEXT,                           -- SHA-256 of the OAuth state sent to the provider for this attempt
  account TEXT,                              -- the provider account that was connected (for display)
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,                  -- the QR code must be opened before this
  opened_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_qr_attempts_user ON qr_connect_attempts(user_id, created_at);
CREATE INDEX idx_qr_attempts_state ON qr_connect_attempts(state_hash);
