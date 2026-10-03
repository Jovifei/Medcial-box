ALTER TABLE care_grants ADD COLUMN receive_dose_reminders boolean NOT NULL DEFAULT false;
CREATE TABLE notification_preferences (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 stock_reminder_time time NOT NULL DEFAULT '09:00',
 timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (timezone = 'Asia/Shanghai'),
 channels text[] NOT NULL DEFAULT '{}' CHECK (channels <@ ARRAY['wechat','android']::text[])
);
-- Existing subscription receipts are explicit historic opt-in; preserve them.
INSERT INTO notification_preferences(user_id, channels)
SELECT DISTINCT user_id, ARRAY['wechat']::text[] FROM wechat_subscription_grants
ON CONFLICT DO NOTHING;
