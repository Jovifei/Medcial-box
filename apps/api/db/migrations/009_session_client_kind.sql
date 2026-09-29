-- Keep application sessions individually revocable by the family account owner.
ALTER TABLE sessions
  ADD COLUMN client_kind text NOT NULL DEFAULT 'miniprogram'
    CHECK (client_kind IN ('miniprogram', 'android'));

CREATE INDEX idx_sessions_user_client_expiry
  ON sessions(user_id, client_kind, expires_at);
