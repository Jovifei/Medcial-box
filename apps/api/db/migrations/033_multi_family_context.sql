-- Multi-family foundation.
-- Keep all existing families, medicines, batches, photos and plans untouched.
-- This migration only introduces explicit user context; migration of existing
-- single-family memberships is additive and reversible at the data model level.

ALTER TABLE family_members
  ADD COLUMN IF NOT EXISTS is_active_context boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS family_members_user_context_idx
  ON family_members (user_id, is_active_context, family_id);

-- Existing users retain their current family context. No rows are moved.
UPDATE family_members
SET is_active_context = true
WHERE id IN (
  SELECT DISTINCT ON (user_id) id
  FROM family_members
  ORDER BY user_id, joined_at, id
);
