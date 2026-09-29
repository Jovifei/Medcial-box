-- Inventory lifecycle, stocktaking, restock, recoverable deletion and device linking.
-- Existing inventory remains explicitly unknown/unconfigured after migration.

ALTER TABLE medicines
  ADD COLUMN low_stock_threshold_quantity integer,
  ADD COLUMN low_stock_threshold_unit text,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id),
  ADD CONSTRAINT medicines_low_stock_threshold_pair CHECK (
    ((low_stock_threshold_quantity IS NULL) = (low_stock_threshold_unit IS NULL))
    AND (low_stock_threshold_quantity IS NULL OR low_stock_threshold_quantity >= 0)
    AND (low_stock_threshold_unit IS NULL OR low_stock_threshold_unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'box', 'other'))
  );

ALTER TABLE medicine_batches
  ADD COLUMN opened_state text NOT NULL DEFAULT 'unknown'
    CHECK (opened_state IN ('unknown', 'unopened', 'opened')),
  ADD COLUMN opened_at date,
  ADD COLUMN after_opening_limit jsonb,
  ADD COLUMN disposition_status text NOT NULL DEFAULT 'active'
    CHECK (disposition_status IN ('active', 'handled')),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid REFERENCES users(id),
  ADD CONSTRAINT medicine_batches_opening_date_state CHECK (
    opened_at IS NULL OR opened_state = 'opened'
  ),
  ADD CONSTRAINT medicine_batches_after_opening_limit_object CHECK (
    after_opening_limit IS NULL OR jsonb_typeof(after_opening_limit) = 'object'
  );

CREATE INDEX idx_medicines_trash ON medicines(family_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_batches_trash ON medicine_batches(family_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE family_inventory_settings (
  family_id uuid PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  stocktake_interval text NOT NULL DEFAULT 'monthly'
    CHECK (stocktake_interval IN ('weekly', 'monthly', 'disabled')),
  last_stocktake_at timestamptz,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stocktake_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  started_by uuid NOT NULL REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX idx_stocktakes_family_started ON stocktake_sessions(family_id, started_at DESC);

CREATE TABLE stocktake_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES medicine_batches(id) ON DELETE SET NULL,
  medicine_id uuid REFERENCES medicines(id) ON DELETE SET NULL,
  expected_version integer NOT NULL,
  expected_quantity integer,
  outcome text CHECK (outcome IN ('unchanged', 'adjusted', 'empty', 'handled', 'deferred')),
  observed_quantity integer,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'saved', 'conflict', 'not_found')),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, batch_id)
);
CREATE INDEX idx_stocktake_items_family ON stocktake_items(family_id, session_id);

CREATE TABLE restock_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  medicine_id uuid NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  desired_quantity integer CHECK (desired_quantity IS NULL OR desired_quantity >= 0),
  unit text NOT NULL CHECK (unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'box', 'other')),
  status text NOT NULL DEFAULT 'needed' CHECK (status IN ('needed', 'purchased', 'dismissed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX idx_restock_family_created ON restock_items(family_id, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_events_family_created ON audit_events(family_id, created_at DESC, id DESC);

CREATE TABLE device_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash char(64) NOT NULL,
  poll_token_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'exchanged')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid REFERENCES families(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  exchanged_at timestamptz,
  CHECK ((status = 'pending' AND user_id IS NULL AND family_id IS NULL) OR (status <> 'pending' AND user_id IS NOT NULL AND family_id IS NOT NULL))
);
CREATE INDEX idx_device_links_code ON device_link_requests(code_hash, expires_at);
CREATE INDEX idx_device_links_expiry ON device_link_requests(expires_at);

-- Keep a compact, family-scoped field diff for changes to inventory records.
CREATE FUNCTION record_inventory_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_data jsonb;
  new_data jsonb;
  field_changes jsonb;
  actor uuid;
  family uuid;
  record_id uuid;
  event_action text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_data := to_jsonb(NEW);
    actor := COALESCE((new_data ->> 'created_by')::uuid, (new_data ->> 'updated_by')::uuid);
    family := (new_data ->> 'family_id')::uuid;
    record_id := (new_data ->> 'id')::uuid;
    event_action := 'created';
    field_changes := jsonb_build_object('after', new_data);
  ELSE
    old_data := to_jsonb(OLD);
    new_data := to_jsonb(NEW);
    actor := (new_data ->> 'updated_by')::uuid;
    family := (new_data ->> 'family_id')::uuid;
    record_id := (new_data ->> 'id')::uuid;
    event_action := 'updated';
    IF old_data -> 'deleted_at' IS DISTINCT FROM new_data -> 'deleted_at' THEN
      event_action := CASE WHEN new_data -> 'deleted_at' = 'null'::jsonb THEN 'restored' ELSE 'trashed' END;
    ELSIF old_data -> 'is_archived' IS DISTINCT FROM new_data -> 'is_archived' THEN
      event_action := CASE WHEN new_data ->> 'is_archived' = 'true' THEN 'archived' ELSE 'unarchived' END;
    ELSIF old_data -> 'disposition_status' IS DISTINCT FROM new_data -> 'disposition_status' THEN
      event_action := CASE WHEN new_data ->> 'disposition_status' = 'handled' THEN 'handled' ELSE 'reopened' END;
    END IF;
    SELECT jsonb_object_agg(keys.key, jsonb_build_object('before', old_data -> keys.key, 'after', new_data -> keys.key))
      INTO field_changes
      FROM jsonb_object_keys(new_data) AS keys(key)
      WHERE old_data -> keys.key IS DISTINCT FROM new_data -> keys.key
        AND keys.key NOT IN ('updated_at', 'updated_by', 'version');
    field_changes := COALESCE(field_changes, '{}'::jsonb);
    IF field_changes = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO audit_events (family_id, actor_id, entity_type, entity_id, action, changes)
  VALUES (family, actor, CASE WHEN TG_TABLE_NAME = 'medicines' THEN 'medicine' ELSE 'batch' END, record_id, event_action, field_changes);
  RETURN NEW;
END;
$$;

CREATE TRIGGER medicines_audit AFTER INSERT OR UPDATE ON medicines
  FOR EACH ROW EXECUTE FUNCTION record_inventory_audit_event();
CREATE TRIGGER medicine_batches_audit AFTER INSERT OR UPDATE ON medicine_batches
  FOR EACH ROW EXECUTE FUNCTION record_inventory_audit_event();
