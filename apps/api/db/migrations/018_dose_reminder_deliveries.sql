-- 018 服药提醒投递（R4）：与库存提醒分表，避免相互挤占一次性订阅授权。
-- 语义与库存提醒一致：授权一次性使用、发送前复核、超时不集中补发；
-- 计划暂停/结束、服药已确认或授权被撤销后，未发出的排队事件标记为 cancelled。

CREATE TABLE dose_reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES medication_plans(id) ON DELETE CASCADE,
  occurrence_id uuid NOT NULL REFERENCES dose_occurrences(id) ON DELETE CASCADE,
  dose_date date NOT NULL,
  time_of_day time NOT NULL,
  template_id text NOT NULL,
  subscription_grant_id uuid REFERENCES wechat_subscription_grants(id),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'blocked', 'cancelled')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  message_id text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (user_id, occurrence_id)
);

CREATE INDEX idx_dose_reminders_due
  ON dose_reminder_deliveries(next_attempt_at)
  WHERE status IN ('queued', 'sending');
CREATE INDEX idx_dose_reminders_occurrence
  ON dose_reminder_deliveries(occurrence_id);
