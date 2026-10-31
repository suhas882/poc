-- Keys for the PC sync helper, which sends Phone Link texts from a Windows PC to a hosted server.
-- Only a SHA-256 hash of each key is stored; the key itself is shown once when created.
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_agent_tokens_user ON agent_tokens(user_id);
