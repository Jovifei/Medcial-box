-- Multi-family membership foundation.
-- A user may own one family and participate in another family as a member.
-- Existing family rows, medicine rows, photos and reminders remain family-scoped;
-- this migration only removes the obsolete one-family-per-user database invariant.
-- It does NOT merge, move or delete existing family data.

DROP INDEX IF EXISTS family_members_user_id_unique;

CREATE INDEX IF NOT EXISTS family_members_user_lookup
  ON family_members (user_id, family_id);

CREATE INDEX IF NOT EXISTS family_members_family_role_lookup
  ON family_members (family_id, role);
