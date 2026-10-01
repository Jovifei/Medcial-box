-- 014 药品整理标签：人群（成人／儿童，可多选）与用途（多选）。
-- 标签是家庭整理信息，不是适龄或适应症判断；来源单独记录，避免把整理标签
-- 当成供应商结论。旧的 purpose_category 自由文本原样保留并继续返回。

ALTER TABLE medicines
  ADD COLUMN population_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN purpose_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN tag_source text NOT NULL DEFAULT 'manual'
    CHECK (tag_source IN ('manual', 'catalog', 'imported'));

-- 元素白名单：空数组表示"未标注"，与显式标签区分开。
ALTER TABLE medicines ADD CONSTRAINT medicines_population_tags_valid
  CHECK (population_tags <@ ARRAY['adult', 'child']::text[]);

ALTER TABLE medicines ADD CONSTRAINT medicines_purpose_tags_valid
  CHECK (purpose_tags <@ ARRAY['fever', 'cough', 'throat', 'nasal', 'gastro', 'pain', 'topical', 'allergy', 'other']::text[]);

-- 药箱按用途／人群筛选时使用包含查询。
CREATE INDEX idx_medicines_population_tags ON medicines USING gin (population_tags);
CREATE INDEX idx_medicines_purpose_tags ON medicines USING gin (purpose_tags);
