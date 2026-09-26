-- 审核修复 #2：medicines / medicine_batches / dosage_notes 查询使用
-- ORDER BY created_at，但 002 建表时漏掉该列。统一补齐（存量行用 now() 回填）。
ALTER TABLE medicines       ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE medicine_batches ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE dosage_notes    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
