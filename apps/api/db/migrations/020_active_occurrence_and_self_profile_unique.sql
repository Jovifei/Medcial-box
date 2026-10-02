-- 020: 服药实例生命周期与本人档案并发修复（深审 R01/R02/R06）。
--
-- R01：旧全局 UNIQUE(slot_id, dose_date) 使"改期作废后同一时间点无法再物化新实例"——
--   作废行仍占用 (slot_id, dose_date)，重新 INSERT 撞旧唯一键被 DO NOTHING 吞掉，
--   今日读回又排除作废行，导致"只改剂量后相同时间安排消失"。
--   改为"活动实例"部分唯一索引：只有 superseded_at IS NULL 的行参与唯一约束，
--   作废行让位，同一时间点可重新物化出新的活动实例（支持 A→B→A 改回复原）。
ALTER TABLE dose_occurrences
  DROP CONSTRAINT IF EXISTS dose_occurrences_slot_id_dose_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dose_occurrences_active_slot_date
  ON dose_occurrences (slot_id, dose_date) WHERE superseded_at IS NULL;

-- R06：本人档案并发创建两个记录——/care-profiles/self 两次 SELECT 都为空后同时 INSERT。
--   为"关联了账号的照护对象"建立家庭＋账号唯一索引（未关联对象 linked_user_id 为空不参与）。
--   历史遗留的重复本人档案（并发缺陷已触发过的库）先安全去重：保留最早创建的一个仍关联账号，
--   其余重复行只解除 linked_user_id（不删除、不级联丢失既有计划与服药历史），使索引可建立。
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY family_id, linked_user_id
           ORDER BY created_at, id
         ) AS rn
  FROM care_profiles
  WHERE linked_user_id IS NOT NULL
)
UPDATE care_profiles cp
SET linked_user_id = NULL
FROM ranked
WHERE cp.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_care_profiles_family_linked_user
  ON care_profiles (family_id, linked_user_id) WHERE linked_user_id IS NOT NULL;
