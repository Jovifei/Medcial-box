-- 019: 服药实例不可变快照 + 系统作废标记（深审 B08/B06）。
-- 实例在物化时记录当时的计划信息（药名/剂量/照护对象显示名/计划版本），
-- 历史日期不再跟随计划当前值变化；过去日期不重新物化。
-- 改期/改星期/改时间点等编辑会把受影响的未来 pending 实例标记 superseded_at，
-- 与用户主动"跳过"区分；对应排队投递同事务取消并退还授权。
ALTER TABLE dose_occurrences
  ADD COLUMN IF NOT EXISTS medicine_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS dosage_text_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS care_profile_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS plan_version_snapshot INTEGER,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- 排队/复核高频条件：未作废实例才可排队与发送。
CREATE INDEX IF NOT EXISTS idx_dose_occurrences_active
  ON dose_occurrences (dose_date)
  WHERE superseded_at IS NULL;
