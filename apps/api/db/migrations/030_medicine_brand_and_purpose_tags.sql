-- 品牌独立于生产厂家；旧客户端未提供品牌时不清空。
ALTER TABLE medicines ADD COLUMN brand text;
ALTER TABLE medicines DROP CONSTRAINT medicines_purpose_tags_valid;
ALTER TABLE medicines ADD CONSTRAINT medicines_purpose_tags_valid
  CHECK (purpose_tags <@ ARRAY['fever','cough','throat','nasal','gastro','pain','topical','allergy','itch','eye','oral','constipation','diarrhea','other']::text[]);
