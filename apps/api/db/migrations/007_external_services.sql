-- Private leaflet uploads, one-time WeChat grants and retryable reminder deliveries.

CREATE TABLE medicine_leaflet_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  source text NOT NULL DEFAULT 'package_leaflet',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users(id)
);
CREATE INDEX idx_leaflet_photos_medicine ON medicine_leaflet_photos(family_id, medicine_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- One accepted one-time subscription authorizes one message. A future reminder
-- needs another user consent unless the platform account has an eligible
-- long-term template configured.
CREATE TABLE wechat_subscription_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
CREATE INDEX idx_subscription_grants_available
  ON wechat_subscription_grants(family_id, user_id, template_id, accepted_at)
  WHERE consumed_at IS NULL;

CREATE TABLE reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES medicine_batches(id) ON DELETE CASCADE,
  deadline_date date NOT NULL,
  days_before smallint NOT NULL CHECK (days_before IN (30, 7, 1, 0)),
  template_id text NOT NULL,
  subscription_grant_id uuid REFERENCES wechat_subscription_grants(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'blocked')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (user_id, batch_id, deadline_date, days_before)
);
CREATE INDEX idx_reminder_deliveries_due ON reminder_deliveries(status, next_attempt_at)
  WHERE status IN ('queued', 'failed');

CREATE TABLE backup_restore_receipts (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  backup_id uuid NOT NULL,
  restored_by uuid NOT NULL REFERENCES users(id),
  restored_at timestamptz NOT NULL DEFAULT now(),
  imported_medicine_count integer NOT NULL DEFAULT 0 CHECK (imported_medicine_count >= 0),
  PRIMARY KEY (family_id, backup_id)
);
