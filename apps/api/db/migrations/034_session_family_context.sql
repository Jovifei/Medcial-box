-- Session selection is authoritative. Retire the intermediate global flag.
-- Existing sessions inherit a family ONLY when membership is unambiguous.
UPDATE sessions s SET active_family_id = m.family_id
FROM (SELECT user_id, (array_agg(family_id))[1] AS family_id
      FROM family_members GROUP BY user_id HAVING count(*) = 1) m
WHERE s.user_id = m.user_id AND s.active_family_id IS NULL;
DROP INDEX IF EXISTS family_members_user_context_idx;
ALTER TABLE family_members DROP COLUMN IF EXISTS is_active_context;
CREATE UNIQUE INDEX IF NOT EXISTS family_members_family_user_key ON family_members(family_id, user_id);
