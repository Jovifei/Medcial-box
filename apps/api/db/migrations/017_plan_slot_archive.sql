-- 017 计划时间点归档（R3 编辑语义）：改期或调整时间点只影响未来，历史记录保留。
-- 之前删除时间点会因外键级联删掉对应的服药实例与确认事件，等于改写历史；
-- 改为给 plan_time_slots 加归档标记：归档后不再物化新实例，已生成的实例保持完整。

ALTER TABLE plan_time_slots ADD COLUMN archived_at timestamptz;

CREATE INDEX idx_plan_time_slots_active ON plan_time_slots(plan_id) WHERE archived_at IS NULL;
