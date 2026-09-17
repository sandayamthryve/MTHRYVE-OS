SET search_path = public;

-- ── C. Drop clearly-safe unused indexes (0 scans, non-unique, non-constraint,
--       NOT foreign-key-supporting) + redundant non-unique duplicates covered by
--       a UNIQUE index. The 201 unused FK-supporting indexes are RETAINED (dropping
--       them would force seq scans on FK checks). Reversible: each is recreatable.
-- 16 clearly-safe unused indexes:
DROP INDEX IF EXISTS public.idx_ar_org;
DROP INDEX IF EXISTS public.idx_ar_tier;
DROP INDEX IF EXISTS public.content_performance_item_idx;
DROP INDEX IF EXISTS public.idx_contriblogs_brand_date;
DROP INDEX IF EXISTS public.idx_creator_posts_posted;
DROP INDEX IF EXISTS public.idx_creators_next_action;
DROP INDEX IF EXISTS public.csi_findings_org_jobtype_idx;
DROP INDEX IF EXISTS public.csi_findings_org_status_idx;
DROP INDEX IF EXISTS public.idx_heygen_gen_status;
DROP INDEX IF EXISTS public.home_view_audit_viewer_idx;
DROP INDEX IF EXISTS public.idx_modassign_user;
DROP INDEX IF EXISTS public.idx_products_active;
DROP INDEX IF EXISTS public.return_cases_rts_number_idx;
DROP INDEX IF EXISTS public.tony_memory_org_idx;
DROP INDEX IF EXISTS public.tony_memory_pinned_idx;
DROP INDEX IF EXISTS public.vesper_clip_jobs_status_idx;
-- 4 redundant non-unique duplicates (each fully covered by a UNIQUE index on the same columns):
DROP INDEX IF EXISTS public.idx_cfin_contract;          -- dup of contract_financials_contract_id_key (UNIQUE)
DROP INDEX IF EXISTS public.conb_org_creator_idx;       -- dup of creator_onboarding_org_id_creator_id_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_daily_taps_user_date;   -- dup of daily_taps_user_id_tap_date_key (UNIQUE)
DROP INDEX IF EXISTS public.idx_contributors_token;     -- dup of contributors_token_key (UNIQUE)
