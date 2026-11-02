-- Sign in with Google or Microsoft. The first sign-in links the provider's stable account ID to an existing user
-- with the same verified email; later sign-ins match that ID, so changing an email at the provider cannot move
-- the link to someone else. Accounts are never created this way: a Supervisor adds users first.

CREATE TABLE user_identities (
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_user_identities_user ON user_identities(user_id);
