-- Per-user search permission, asked after sign-in before any Real data search.
CREATE TABLE user_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'all': every source the user can access, including ones added later. 'selected': only source_ids.
  scope TEXT NOT NULL CHECK (scope IN ('all', 'selected')),
  source_ids TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
