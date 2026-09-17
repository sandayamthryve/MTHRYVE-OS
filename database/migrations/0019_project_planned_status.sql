-- Mthryve OS — Migration 0019: Add 'planned' to project_status
-- The Projects Log gains an optional "Next" column for upcoming work. Postgres
-- ALTER TYPE ... ADD VALUE cannot run inside the same transaction that later
-- *uses* the new value; this migration only adds it (no use), so it is safe.
-- Idempotent via IF NOT EXISTS so re-applying is a no-op.
-- Applied to project otepdjhrawtqkzclaxbk.

alter type project_status add value if not exists 'planned' before 'on_hold';
