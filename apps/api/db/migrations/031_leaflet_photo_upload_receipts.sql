-- Idempotent photo upload receipt: keep a stable client intent across lost HTTP responses.
-- The request key is user-scoped within a family, not a global image hash.
ALTER TABLE medicine_leaflet_photos
  ADD COLUMN upload_intent_key text,
  ADD COLUMN upload_payload_hash text;
ALTER TABLE medicine_leaflet_photos ADD CONSTRAINT medicine_photo_upload_intent_key_valid
  CHECK (upload_intent_key IS NULL OR upload_intent_key ~ '^[A-Za-z0-9_-]{16,128}$');
CREATE UNIQUE INDEX medicine_photo_unique_upload_intent
  ON medicine_leaflet_photos (family_id, created_by, upload_intent_key)
  WHERE upload_intent_key IS NOT NULL;
