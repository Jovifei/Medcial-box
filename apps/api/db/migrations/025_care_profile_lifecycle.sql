ALTER TABLE care_profiles ADD COLUMN archived_at timestamptz;
DROP INDEX uq_care_profiles_family_linked_user;
CREATE UNIQUE INDEX uq_care_profiles_family_linked_user
 ON care_profiles(family_id, linked_user_id)
 WHERE linked_user_id IS NOT NULL AND archived_at IS NULL;
ALTER TABLE care_profiles ADD COLUMN managed_by uuid REFERENCES users(id);
UPDATE care_profiles SET managed_by=created_by;
