-- Code-based pairing for the PC sync helper, so nobody has to copy a long key between the website and the PC.
-- The helper asks for a pairing, shows a short code (ABCD-2345) and waits. A signed-in person types that code on the
-- website; the helper then collects its key once. Only hashes of the code and of the helper's secret are stored.
CREATE TABLE agent_pairings (
  id TEXT PRIMARY KEY,
  user_code_hash TEXT NOT NULL UNIQUE,
  device_code_hash TEXT NOT NULL UNIQUE,
  pc_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'claimed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  approved_at TEXT,
  token_id TEXT REFERENCES agent_tokens(id) ON DELETE SET NULL
);
CREATE INDEX idx_agent_pairings_expires ON agent_pairings(expires_at);
