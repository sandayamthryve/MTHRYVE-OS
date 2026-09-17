-- 0022_content_performance_sync_index.sql
-- Creative Studio — Performance dashboard (sync-ready).
--
-- content_performance is populated manually today (source='manual', external_id
-- NULL). To make a future platform sync idempotent, a pull can upsert on
-- (org_id, external_id). This partial unique index enforces one row per external
-- record per org WITHOUT constraining the manual rows (whose external_id is NULL
-- and therefore excluded from the index).
--
-- Additive + safe to re-run. The content_performance table itself is provisioned
-- out-of-band (like the other Creative Studio tables); this only adds the index.

create unique index if not exists content_performance_org_external_uidx
  on public.content_performance (org_id, external_id)
  where external_id is not null;
