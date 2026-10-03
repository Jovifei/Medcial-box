-- Bind reusable subscription grants to a single dose delivery. Older uncertain
-- deliveries retain consumption and cannot automatically cross the send boundary.
ALTER TABLE wechat_subscription_grants ADD COLUMN dose_delivery_id uuid;
ALTER TABLE dose_reminder_deliveries ADD COLUMN send_started_at timestamptz;
UPDATE dose_reminder_deliveries SET send_started_at = created_at
WHERE status IN ('sending', 'sent', 'failed');
UPDATE wechat_subscription_grants g SET dose_delivery_id = d.id
FROM dose_reminder_deliveries d
WHERE d.subscription_grant_id = g.id AND g.consumed_at IS NOT NULL
AND d.status IN ('queued', 'sending', 'sent', 'failed');
