-- Optional package barcode captured by either client; it is only an identifier,
-- not proof that a scanned item or catalog candidate was verified.
ALTER TABLE medicines
  ADD COLUMN barcode_value text;

CREATE INDEX idx_medicines_family_barcode
  ON medicines(family_id, barcode_value)
  WHERE barcode_value IS NOT NULL AND deleted_at IS NULL;
