-- Runs once when the postgres container initializes its data volume.
-- For ongoing schema changes, drop the volume (`docker compose down -v`)
-- or run migrations against the live db.

CREATE TABLE IF NOT EXISTS notes (
  id          BIGSERIAL PRIMARY KEY,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
