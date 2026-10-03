CREATE TABLE medicine_create_receipts (
 family_id uuid NOT NULL REFERENCES families(id),
 user_id uuid NOT NULL REFERENCES users(id),
 request_key text NOT NULL,
 payload_hash text NOT NULL,
 response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (family_id, user_id, request_key)
);
