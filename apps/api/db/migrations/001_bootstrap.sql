-- Initial migration infrastructure only. Household and medicine tables are added in P1.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
