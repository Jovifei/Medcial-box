-- Confirmed mechanical packaging conversion, never a guessed dose conversion.
ALTER TABLE medicine_batches ADD COLUMN conversion_unit text;
ALTER TABLE medicine_batches ADD CONSTRAINT batch_conversion_target_valid CHECK (
  conversion_unit IS NULL OR
  (unit = 'box' AND conversion_unit IN ('tablet','capsule','sachet','blister','bottle')) OR
  (unit = 'blister' AND conversion_unit IN ('tablet','capsule')) OR
  (unit = 'bottle' AND conversion_unit = 'ml')
);
-- Ratios use the destination precision: a bottle may contain 12.5 ml.
ALTER TABLE medicine_batches ADD CONSTRAINT batch_conversion_precision_valid CHECK (
  confirmed_units_per_package IS NULL OR COALESCE(conversion_unit = 'ml', false) OR unit = 'ml'
  OR confirmed_units_per_package = trunc(confirmed_units_per_package)
);
