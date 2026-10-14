-- Repair the legacy UNIQUE constraint before the historical 033 index drop.
-- Historical files/checksums remain immutable. Only the one-user constraint
-- is removed; (family_id,user_id) and the single-owner index remain intact.
ALTER TABLE family_members DROP CONSTRAINT IF EXISTS family_members_user_id_key;
