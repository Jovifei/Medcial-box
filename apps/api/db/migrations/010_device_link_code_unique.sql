-- Device pairing codes are short and expire after five minutes. Keep them
-- globally unique while retained so one confirmation can never approve two Apps.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY code_hash ORDER BY created_at DESC, id DESC) AS duplicate_rank
  FROM device_link_requests
)
DELETE FROM device_link_requests AS old_request
USING ranked
WHERE old_request.id = ranked.id AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX device_link_requests_code_hash_unique
  ON device_link_requests(code_hash);
