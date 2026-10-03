ALTER TABLE medicine_batches DROP CONSTRAINT IF EXISTS medicine_batches_unit_check;
ALTER TABLE medicine_batches ADD CONSTRAINT medicine_batches_unit_check
  CHECK (unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'tube', 'box', 'blister', 'ml', 'other'));

ALTER TABLE restock_items DROP CONSTRAINT IF EXISTS restock_items_unit_check;
ALTER TABLE restock_items ADD CONSTRAINT restock_items_unit_check
  CHECK (unit IN ('tablet', 'capsule', 'sachet', 'bottle', 'tube', 'box', 'blister', 'ml', 'other'));

ALTER TABLE medicines DROP CONSTRAINT IF EXISTS medicines_low_stock_threshold_pair;
ALTER TABLE medicines ADD CONSTRAINT medicines_low_stock_threshold_pair CHECK (
  ((low_stock_threshold_quantity IS NULL) = (low_stock_threshold_unit IS NULL))
  AND (low_stock_threshold_quantity IS NULL OR low_stock_threshold_quantity >= 0)
  AND (low_stock_threshold_unit IS NULL OR low_stock_threshold_unit IN
       ('tablet', 'capsule', 'sachet', 'bottle', 'tube', 'box', 'blister', 'ml', 'other'))
);

ALTER TABLE medicine_batches DROP CONSTRAINT IF EXISTS batch_conversion_target_valid;
ALTER TABLE medicine_batches ADD CONSTRAINT batch_conversion_target_valid CHECK (
  conversion_unit IS NULL OR
  (unit = 'box' AND conversion_unit IN ('tablet', 'capsule', 'sachet', 'blister', 'bottle', 'tube')) OR
  (unit = 'blister' AND conversion_unit IN ('tablet', 'capsule')) OR
  (unit = 'bottle' AND conversion_unit = 'ml')
);
