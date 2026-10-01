-- 013 定点数量与新单位：ml（毫升，最多 3 位小数）与 blister（板）。
-- 数量列 integer → numeric(14,3)：毫升可带小数，计件单位仍然必须整数。
-- 只做增量 ALTER，不修改任何已执行迁移；既有整数数据原样保留。

-- 1) 单位枚举扩展（三处）
ALTER TABLE medicine_batches DROP CONSTRAINT IF EXISTS medicine_batches_unit_check;
ALTER TABLE medicine_batches ADD CONSTRAINT medicine_batches_unit_check
  CHECK (unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'box', 'blister', 'ml', 'other'));

ALTER TABLE restock_items DROP CONSTRAINT IF EXISTS restock_items_unit_check;
ALTER TABLE restock_items ADD CONSTRAINT restock_items_unit_check
  CHECK (unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'box', 'blister', 'ml', 'other'));

ALTER TABLE medicines DROP CONSTRAINT IF EXISTS medicines_low_stock_threshold_pair;
ALTER TABLE medicines ADD CONSTRAINT medicines_low_stock_threshold_pair CHECK (
  ((low_stock_threshold_quantity IS NULL) = (low_stock_threshold_unit IS NULL))
  AND (low_stock_threshold_quantity IS NULL OR low_stock_threshold_quantity >= 0)
  AND (low_stock_threshold_unit IS NULL
       OR low_stock_threshold_unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'box', 'blister', 'ml', 'other'))
);

-- 2) 数量列定点化（既有整数值无损转换）
ALTER TABLE medicine_batches
  ALTER COLUMN quantity TYPE numeric(14, 3) USING quantity::numeric(14, 3),
  ALTER COLUMN confirmed_units_per_package TYPE numeric(14, 3) USING confirmed_units_per_package::numeric(14, 3);

ALTER TABLE medicines
  ALTER COLUMN low_stock_threshold_quantity TYPE numeric(14, 3) USING low_stock_threshold_quantity::numeric(14, 3);

ALTER TABLE stocktake_items
  ALTER COLUMN expected_quantity TYPE numeric(14, 3) USING expected_quantity::numeric(14, 3),
  ALTER COLUMN observed_quantity TYPE numeric(14, 3) USING observed_quantity::numeric(14, 3);

ALTER TABLE restock_items
  ALTER COLUMN desired_quantity TYPE numeric(14, 3) USING desired_quantity::numeric(14, 3);

-- 3) 精度约束：只有 ml 允许小数，计件单位必须整数
ALTER TABLE medicine_batches DROP CONSTRAINT IF EXISTS medicine_batches_unit_fraction_check;
ALTER TABLE medicine_batches ADD CONSTRAINT medicine_batches_unit_fraction_check CHECK (
  unit = 'ml' OR quantity IS NULL OR quantity = trunc(quantity)
);

ALTER TABLE restock_items DROP CONSTRAINT IF EXISTS restock_items_unit_fraction_check;
ALTER TABLE restock_items ADD CONSTRAINT restock_items_unit_fraction_check CHECK (
  unit = 'ml' OR desired_quantity IS NULL OR desired_quantity = trunc(desired_quantity)
);

ALTER TABLE medicines DROP CONSTRAINT IF EXISTS medicines_threshold_unit_fraction_check;
ALTER TABLE medicines ADD CONSTRAINT medicines_threshold_unit_fraction_check CHECK (
  low_stock_threshold_unit = 'ml'
  OR low_stock_threshold_quantity IS NULL
  OR low_stock_threshold_quantity = trunc(low_stock_threshold_quantity)
);
