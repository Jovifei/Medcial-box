-- Bind restore confirmation to one authenticated user, family and exact snapshot.
CREATE TABLE backup_restore_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  backup_id uuid NOT NULL,
  payload_hash char(64) NOT NULL,
  confirmation_token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);

CREATE INDEX idx_backup_restore_previews_family_expiry
  ON backup_restore_previews(family_id, expires_at);
