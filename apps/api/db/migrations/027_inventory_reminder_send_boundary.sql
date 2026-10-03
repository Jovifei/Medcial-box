-- Inventory delivery attempts must distinguish a leased job from a request that
-- might already have reached WeChat. Never automatically replay an old unknown
-- outcome on upgrade; retain its one-time subscription consumption.
ALTER TABLE reminder_deliveries
  ADD COLUMN send_started_at timestamptz,
  ADD COLUMN cancel_requested boolean NOT NULL DEFAULT false;
UPDATE reminder_deliveries SET send_started_at = COALESCE(sent_at, created_at)
WHERE status IN ('sending', 'sent', 'failed');

CREATE INDEX idx_inventory_reminders_not_started ON reminder_deliveries(next_attempt_at)
WHERE status IN ('queued', 'failed', 'sending') AND send_started_at IS NULL AND NOT cancel_requested;
