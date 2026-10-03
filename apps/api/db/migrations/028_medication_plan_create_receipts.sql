-- Preserve complete creation responses in the same transaction as plans and slots.
-- Scope remains the original family + actor even when family membership changes.
-- Never derive a replay from mutable current plan state or delete its receipt on edit/end.
CREATE TABLE medication_plan_create_receipts (
  family_id uuid NOT NULL REFERENCES families(id),
  user_id uuid NOT NULL REFERENCES users(id),
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id, request_key)
);
