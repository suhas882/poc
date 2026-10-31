-- Demo mode workspace (plans, review marks, notes, labels, activity log), saved on the server so it survives reloads.
-- owner is 'user:<id>' when signed in, otherwise 'device:<random id from the prs_device cookie>'.
CREATE TABLE demo_state (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner, key)
);
