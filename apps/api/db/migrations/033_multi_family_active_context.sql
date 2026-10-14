-- Multi-family phase: preserve existing families and memberships.
-- Never migrates, merges, or deletes family data.
-- A user may own one family and participate in another family as member.

DROP INDEX IF EXISTS family_members_user_id_key;

CREATE INDEX IF NOT EXISTS family_members_user_lookup
  ON family_members (user_id, family_id);

CREATE INDEX IF NOT EXISTS family_members_family_role_lookup
  ON family_members (family_id, role, user_id);

-- Explicit active context is session-scoped, not a replacement for membership.
-- Every request must still verify family_members(user_id, family_id).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS active_family_id uuid NULL;

CREATE INDEX IF NOT EXISTS sessions_active_family_lookup
  ON sessions (user_id, active_family_id);
