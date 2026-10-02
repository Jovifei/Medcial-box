-- 021 服药提醒投递取消语义（R05）：区分"确定未发送"与"在途/结果不确定"。
-- 之前 cancelDoseReminders 对 sending/failed 一并退还授权，导致：投递在途时编辑计划
-- 会退还授权，sender 随后返回成功又把状态改成 sent，最终 sent 但 consumed_at 为空，
-- 同一条一次性授权可被再次使用，旧发送结果也覆盖了取消状态。
-- 现在：
--   - queued / blocked（确定未发送）：可取消并退还授权；
--   - sending / failed（在途或结果不确定）：仅标 cancel_requested，不退授权、不改终态，
--     由持有租约的 worker 决定最终状态；跨过发送边界不承诺撤回已送消息。
-- 发送结果更新带 attempt 租约条件，旧 worker 不能覆盖新状态。
ALTER TABLE dose_reminder_deliveries
  ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
