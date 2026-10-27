-- Separate, optional evidence: older medicine and photo clients remain unchanged.
CREATE TABLE medicine_recognition_evidence (
  medicine_id uuid PRIMARY KEY REFERENCES medicines(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  medicine_version integer CHECK (medicine_version IS NULL OR medicine_version > 0),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Immutable acknowledgements allow a lost response to be retried without a second write.
CREATE TABLE medicine_recognition_evidence_receipts (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_key text NOT NULL CHECK (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  payload_hash text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  medicine_version integer NOT NULL CHECK (medicine_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id, request_key)
);
