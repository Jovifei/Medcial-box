-- Quota reflects bytes that still occupy private storage, not merely visible rows.
ALTER TABLE medicine_leaflet_photos
  ADD COLUMN storage_removed_at timestamptz,
  ADD COLUMN upload_completed_at timestamptz;

-- Existing visible rows already have their private file; soft-deleted rows stay
-- pending cleanup and continue consuming quota until the file is removed.
UPDATE medicine_leaflet_photos
SET upload_completed_at = created_at
WHERE deleted_at IS NULL;

CREATE INDEX idx_leaflet_photo_storage_cleanup
  ON medicine_leaflet_photos(family_id, deleted_at, created_at)
  WHERE storage_removed_at IS NULL;
