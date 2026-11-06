-- Android companion app: the phone reads its own SMS (with the user's runtime permission) and sends them here.
-- It reuses agent_tokens for its revocable key (kind = 'phone'), so revocation, ownership and cascade-on-delete work
-- the same way as for the PC sync helper.
ALTER TABLE agent_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'pc';
-- What the phone reports about itself: {"model","androidVersion","appVersion"}. Never message content.
ALTER TABLE agent_tokens ADD COLUMN device_info TEXT NOT NULL DEFAULT '{}';
-- Latest state the phone reported: {"permission","pending","lastError","lastErrorAt","reportedAt"}. Never message content.
ALTER TABLE agent_tokens ADD COLUMN device_status TEXT NOT NULL DEFAULT '{}';

-- One-time codes shown on the website (as text and QR code) and typed or scanned on the phone.
-- Only a hash of the code is stored.
CREATE TABLE phone_pairings (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  token_id TEXT REFERENCES agent_tokens(id) ON DELETE SET NULL
);
CREATE INDEX idx_phone_pairings_user ON phone_pairings(user_id, created_at);

-- Individual texts received from a phone. They let the server merge new texts into the right conversation-day
-- record, and they make re-sending harmless: a text is stored once per source, by the phone's message id and by a
-- fingerprint (time, address, direction, body hash) that survives a reinstall. Deleted with the source.
CREATE TABLE phone_messages (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  device_msg_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  conv_key TEXT NOT NULL,
  conv_label TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (source_id, device_msg_id)
);
CREATE UNIQUE INDEX idx_phone_messages_fp ON phone_messages(source_id, fingerprint);
CREATE INDEX idx_phone_messages_conv ON phone_messages(source_id, conv_key, sent_at);
