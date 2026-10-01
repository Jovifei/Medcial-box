-- 015 照片用途与药盒封面引用。
-- 复用既有的私有存储、家庭鉴权、配额与清理机制（medicine_leaflet_photos），
-- 只增加"用途"维度：药盒正面（可作封面）、有效期（绑定具体库存批次）、说明书。
-- 说明书图片仍然单独展示，不会自动充当药盒封面。

ALTER TABLE medicine_leaflet_photos
  ADD COLUMN purpose text NOT NULL DEFAULT 'leaflet'
    CHECK (purpose IN ('leaflet', 'box_front', 'expiry')),
  ADD COLUMN batch_id uuid REFERENCES medicine_batches(id) ON DELETE SET NULL;

-- 有效期照片必须绑定具体库存记录，否则"这张照片对应哪一盒"无法回答。
ALTER TABLE medicine_leaflet_photos ADD CONSTRAINT medicine_leaflet_photos_expiry_needs_batch
  CHECK (purpose <> 'expiry' OR batch_id IS NOT NULL);

-- 药盒封面引用：指向本药品的一张药盒正面照片；未设置表示没有照片。
ALTER TABLE medicines
  ADD COLUMN cover_photo_id uuid REFERENCES medicine_leaflet_photos(id) ON DELETE SET NULL;

CREATE INDEX idx_leaflet_photos_purpose
  ON medicine_leaflet_photos(family_id, medicine_id, purpose)
  WHERE deleted_at IS NULL;
