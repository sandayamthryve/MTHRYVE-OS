-- Mthryve OS — Migration 20260720040000: DB performance — FK indexes + RLS init-plan
--
-- Fixes the two highest-impact, lowest-risk categories flagged by the Supabase
-- performance advisor, which surface app-wide as query lag. This migration is
-- purely ADDITIVE and IDEMPOTENT: it changes NO access rules, NO columns, NO
-- data — only physical performance structures.
--
-- PART 1 — UNINDEXED FOREIGN KEYS (186 findings)
--   Every foreign-key column flagged by the advisor as lacking a covering index
--   gets a plain btree index `ix_<table>_<col>`. Missing FK indexes force
--   sequential scans on joins and on cascade/constraint checks, and make
--   org-scoped reads (org_id) and ownership joins (created_by, brand_id, etc.)
--   slow across the whole app. The database is small, so plain CREATE INDEX is
--   effectively instant — no CONCURRENTLY needed. IF NOT EXISTS makes each
--   statement safe to re-run.
--
-- PART 2 — RLS INITIALIZATION PLAN (38 findings: auth_rls_initplan)
--   Each flagged policy re-evaluates a session function once PER ROW. Wrapping
--   the call in a scalar subquery — e.g. `current_org_id()` -> `(select
--   current_org_id())` — lets Postgres evaluate it ONCE per query (an InitPlan)
--   instead of once per row. The wrapped expressions are SEMANTICALLY IDENTICAL
--   to the originals: same columns, same roles, same USING / WITH CHECK logic,
--   same who-can-do-what. Only the three session functions are wrapped:
--     current_org_id()    -> (select current_org_id())
--     current_user_role() -> (select current_user_role())
--     auth.uid()          -> (select auth.uid())
--   Each policy is dropped (IF EXISTS) and recreated with identical semantics,
--   so this section is also idempotent.
--
-- Scope guardrail: this PR deliberately does NOT touch multiple_permissive_policies
-- or unused_index findings — those are a separate, more delicate pass.

BEGIN;

-- =====================================================================
-- PART 1 — Indexes on unindexed foreign keys (186)
-- =====================================================================
CREATE INDEX IF NOT EXISTS ix_account_briefings_brand_id ON public.account_briefings (brand_id);
CREATE INDEX IF NOT EXISTS ix_account_briefings_generated_by ON public.account_briefings (generated_by);
CREATE INDEX IF NOT EXISTS ix_account_review_briefs_brand_id ON public.account_review_briefs (brand_id);
CREATE INDEX IF NOT EXISTS ix_account_review_briefs_generated_by ON public.account_review_briefs (generated_by);
CREATE INDEX IF NOT EXISTS ix_action_requests_final_decided_by ON public.action_requests (final_decided_by);
CREATE INDEX IF NOT EXISTS ix_action_requests_first_decided_by ON public.action_requests (first_decided_by);
CREATE INDEX IF NOT EXISTS ix_affiliate_campaign_creators_campaign_id ON public.affiliate_campaign_creators (campaign_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_campaign_creators_creator_id ON public.affiliate_campaign_creators (creator_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_campaign_creators_sourcer_id ON public.affiliate_campaign_creators (sourcer_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_content_archived_by ON public.affiliate_content (archived_by);
CREATE INDEX IF NOT EXISTS ix_affiliate_content_creator_id ON public.affiliate_content (creator_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_content_product_id ON public.affiliate_content (product_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_deals_archived_by ON public.affiliate_deals (archived_by);
CREATE INDEX IF NOT EXISTS ix_affiliate_deals_brand_id ON public.affiliate_deals (brand_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_deals_created_by ON public.affiliate_deals (created_by);
CREATE INDEX IF NOT EXISTS ix_affiliate_samples_archived_by ON public.affiliate_samples (archived_by);
CREATE INDEX IF NOT EXISTS ix_affiliate_samples_creator_id ON public.affiliate_samples (creator_id);
CREATE INDEX IF NOT EXISTS ix_affiliate_samples_product_id ON public.affiliate_samples (product_id);
CREATE INDEX IF NOT EXISTS ix_ai_conversations_org_id ON public.ai_conversations (org_id);
CREATE INDEX IF NOT EXISTS ix_anchors_archived_by ON public.anchors (archived_by);
CREATE INDEX IF NOT EXISTS ix_anchors_created_by ON public.anchors (created_by);
CREATE INDEX IF NOT EXISTS ix_anchors_creator_id ON public.anchors (creator_id);
CREATE INDEX IF NOT EXISTS ix_approval_requests_requested_by ON public.approval_requests (requested_by);
CREATE INDEX IF NOT EXISTS ix_approval_requests_reviewed_by ON public.approval_requests (reviewed_by);
CREATE INDEX IF NOT EXISTS ix_assistant_settings_user_id ON public.assistant_settings (user_id);
CREATE INDEX IF NOT EXISTS ix_audit_log_actor_user_id ON public.audit_log (actor_user_id);
CREATE INDEX IF NOT EXISTS ix_audit_logs_actor_id ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS ix_automation_registry_created_by ON public.automation_registry (created_by);
CREATE INDEX IF NOT EXISTS ix_brand_finance_org_id ON public.brand_finance (org_id);
CREATE INDEX IF NOT EXISTS ix_brand_initiatives_archived_by ON public.brand_initiatives (archived_by);
CREATE INDEX IF NOT EXISTS ix_brand_initiatives_brand_id ON public.brand_initiatives (brand_id);
CREATE INDEX IF NOT EXISTS ix_brand_platform_metrics_imported_by ON public.brand_platform_metrics (imported_by);
CREATE INDEX IF NOT EXISTS ix_brands_archived_by ON public.brands (archived_by);
CREATE INDEX IF NOT EXISTS ix_budgets_archived_by ON public.budgets (archived_by);
CREATE INDEX IF NOT EXISTS ix_budgets_brand_id ON public.budgets (brand_id);
CREATE INDEX IF NOT EXISTS ix_budgets_created_by ON public.budgets (created_by);
CREATE INDEX IF NOT EXISTS ix_budgets_department_id ON public.budgets (department_id);
CREATE INDEX IF NOT EXISTS ix_campaigns_archived_by ON public.campaigns (archived_by);
CREATE INDEX IF NOT EXISTS ix_campaigns_brand_id ON public.campaigns (brand_id);
CREATE INDEX IF NOT EXISTS ix_campaigns_created_by ON public.campaigns (created_by);
CREATE INDEX IF NOT EXISTS ix_campaigns_org_id ON public.campaigns (org_id);
CREATE INDEX IF NOT EXISTS ix_campaigns_owner_id ON public.campaigns (owner_id);
CREATE INDEX IF NOT EXISTS ix_candidates_archived_by ON public.candidates (archived_by);
CREATE INDEX IF NOT EXISTS ix_candidates_created_by ON public.candidates (created_by);
CREATE INDEX IF NOT EXISTS ix_candidates_org_id ON public.candidates (org_id);
CREATE INDEX IF NOT EXISTS ix_case_updates_org_id ON public.case_updates (org_id);
CREATE INDEX IF NOT EXISTS ix_case_updates_user_id ON public.case_updates (user_id);
CREATE INDEX IF NOT EXISTS ix_cases_archived_by ON public.cases (archived_by);
CREATE INDEX IF NOT EXISTS ix_cases_created_by ON public.cases (created_by);
CREATE INDEX IF NOT EXISTS ix_client_contracts_archived_by ON public.client_contracts (archived_by);
CREATE INDEX IF NOT EXISTS ix_client_contracts_created_by ON public.client_contracts (created_by);
CREATE INDEX IF NOT EXISTS ix_compensation_org_id ON public.compensation (org_id);
CREATE INDEX IF NOT EXISTS ix_content_assets_created_by ON public.content_assets (created_by);
CREATE INDEX IF NOT EXISTS ix_content_generations_created_by ON public.content_generations (created_by);
CREATE INDEX IF NOT EXISTS ix_content_generations_org_id ON public.content_generations (org_id);
CREATE INDEX IF NOT EXISTS ix_content_items_archived_by ON public.content_items (archived_by);
CREATE INDEX IF NOT EXISTS ix_content_items_assignee_id ON public.content_items (assignee_id);
CREATE INDEX IF NOT EXISTS ix_content_items_brand_id ON public.content_items (brand_id);
CREATE INDEX IF NOT EXISTS ix_content_items_initiative_id ON public.content_items (initiative_id);
CREATE INDEX IF NOT EXISTS ix_content_performance_brand_id ON public.content_performance (brand_id);
CREATE INDEX IF NOT EXISTS ix_content_performance_created_by ON public.content_performance (created_by);
CREATE INDEX IF NOT EXISTS ix_creator_onboarding_creator_id ON public.creator_onboarding (creator_id);
CREATE INDEX IF NOT EXISTS ix_creator_posts_brand_id ON public.creator_posts (brand_id);
CREATE INDEX IF NOT EXISTS ix_creator_posts_deal_id ON public.creator_posts (deal_id);
CREATE INDEX IF NOT EXISTS ix_creators_archived_by ON public.creators (archived_by);
CREATE INDEX IF NOT EXISTS ix_creators_created_by ON public.creators (created_by);
CREATE INDEX IF NOT EXISTS ix_creators_owner_id ON public.creators (owner_id);
CREATE INDEX IF NOT EXISTS ix_csi_findings_brand_id ON public.csi_findings (brand_id);
CREATE INDEX IF NOT EXISTS ix_csi_findings_created_by ON public.csi_findings (created_by);
CREATE INDEX IF NOT EXISTS ix_daily_log_requests_approver_id ON public.daily_log_requests (approver_id);
CREATE INDEX IF NOT EXISTS ix_daily_log_requests_user_id ON public.daily_log_requests (user_id);
CREATE INDEX IF NOT EXISTS ix_daily_reports_archived_by ON public.daily_reports (archived_by);
CREATE INDEX IF NOT EXISTS ix_daily_taps_org_id ON public.daily_taps (org_id);
CREATE INDEX IF NOT EXISTS ix_department_brands_brand_id ON public.department_brands (brand_id);
CREATE INDEX IF NOT EXISTS ix_department_briefings_department_id ON public.department_briefings (department_id);
CREATE INDEX IF NOT EXISTS ix_departments_lead_user_id ON public.departments (lead_user_id);
CREATE INDEX IF NOT EXISTS ix_departments_org_id ON public.departments (org_id);
CREATE INDEX IF NOT EXISTS ix_documents_archived_by ON public.documents (archived_by);
CREATE INDEX IF NOT EXISTS ix_documents_uploaded_by ON public.documents (uploaded_by);
CREATE INDEX IF NOT EXISTS ix_events_created_by ON public.events (created_by);
CREATE INDEX IF NOT EXISTS ix_events_department_id ON public.events (department_id);
CREATE INDEX IF NOT EXISTS ix_events_org_id ON public.events (org_id);
CREATE INDEX IF NOT EXISTS ix_expenses_approved_by ON public.expenses (approved_by);
CREATE INDEX IF NOT EXISTS ix_expenses_archived_by ON public.expenses (archived_by);
CREATE INDEX IF NOT EXISTS ix_expenses_department_id ON public.expenses (department_id);
CREATE INDEX IF NOT EXISTS ix_expenses_encoded_by ON public.expenses (encoded_by);
CREATE INDEX IF NOT EXISTS ix_finance_briefings_generated_by ON public.finance_briefings (generated_by);
CREATE INDEX IF NOT EXISTS ix_finance_entries_archived_by ON public.finance_entries (archived_by);
CREATE INDEX IF NOT EXISTS ix_finance_entries_brand_id ON public.finance_entries (brand_id);
CREATE INDEX IF NOT EXISTS ix_finance_entries_created_by ON public.finance_entries (created_by);
CREATE INDEX IF NOT EXISTS ix_heygen_generations_brand_id ON public.heygen_generations (brand_id);
CREATE INDEX IF NOT EXISTS ix_heygen_generations_requested_by ON public.heygen_generations (requested_by);
CREATE INDEX IF NOT EXISTS ix_import_batches_imported_by ON public.import_batches (imported_by);
CREATE INDEX IF NOT EXISTS ix_leads_archived_by ON public.leads (archived_by);
CREATE INDEX IF NOT EXISTS ix_leads_created_by ON public.leads (created_by);
CREATE INDEX IF NOT EXISTS ix_leads_owner_id ON public.leads (owner_id);
CREATE INDEX IF NOT EXISTS ix_live_bottlenecks_assigned_to ON public.live_bottlenecks (assigned_to);
CREATE INDEX IF NOT EXISTS ix_live_bottlenecks_created_by ON public.live_bottlenecks (created_by);
CREATE INDEX IF NOT EXISTS ix_live_bottlenecks_task_id ON public.live_bottlenecks (task_id);
CREATE INDEX IF NOT EXISTS ix_live_session_attachments_uploaded_by ON public.live_session_attachments (uploaded_by);
CREATE INDEX IF NOT EXISTS ix_live_sessions_archived_by ON public.live_sessions (archived_by);
CREATE INDEX IF NOT EXISTS ix_live_sessions_brand_id ON public.live_sessions (brand_id);
CREATE INDEX IF NOT EXISTS ix_live_sessions_created_by ON public.live_sessions (created_by);
CREATE INDEX IF NOT EXISTS ix_live_sessions_moderator_id ON public.live_sessions (moderator_id);
CREATE INDEX IF NOT EXISTS ix_live_sessions_report_reviewed_by ON public.live_sessions (report_reviewed_by);
CREATE INDEX IF NOT EXISTS ix_live_sessions_report_submitted_by ON public.live_sessions (report_submitted_by);
CREATE INDEX IF NOT EXISTS ix_live_sessions_team_leader_id ON public.live_sessions (team_leader_id);
CREATE INDEX IF NOT EXISTS ix_marketplace_connections_shop_id ON public.marketplace_connections (shop_id);
CREATE INDEX IF NOT EXISTS ix_marketplace_shops_brand_id ON public.marketplace_shops (brand_id);
CREATE INDEX IF NOT EXISTS ix_media_assets_brand_id ON public.media_assets (brand_id);
CREATE INDEX IF NOT EXISTS ix_media_assets_uploaded_by ON public.media_assets (uploaded_by);
CREATE INDEX IF NOT EXISTS ix_metric_entries_archived_by ON public.metric_entries (archived_by);
CREATE INDEX IF NOT EXISTS ix_metric_targets_created_by ON public.metric_targets (created_by);
CREATE INDEX IF NOT EXISTS ix_metric_targets_department_id ON public.metric_targets (department_id);
CREATE INDEX IF NOT EXISTS ix_metrics_snapshots_brand_id ON public.metrics_snapshots (brand_id);
CREATE INDEX IF NOT EXISTS ix_metrics_snapshots_created_by ON public.metrics_snapshots (created_by);
CREATE INDEX IF NOT EXISTS ix_model_grants_granted_by ON public.model_grants (granted_by);
CREATE INDEX IF NOT EXISTS ix_model_grants_org_id ON public.model_grants (org_id);
CREATE INDEX IF NOT EXISTS ix_model_grants_request_id ON public.model_grants (request_id);
CREATE INDEX IF NOT EXISTS ix_op_record_routing_acknowledged_by ON public.op_record_routing (acknowledged_by);
CREATE INDEX IF NOT EXISTS ix_op_record_routing_routed_by ON public.op_record_routing (routed_by);
CREATE INDEX IF NOT EXISTS ix_op_records_approved_by ON public.op_records (approved_by);
CREATE INDEX IF NOT EXISTS ix_op_records_archived_by ON public.op_records (archived_by);
CREATE INDEX IF NOT EXISTS ix_op_records_created_by ON public.op_records (created_by);
CREATE INDEX IF NOT EXISTS ix_org_briefings_generated_by ON public.org_briefings (generated_by);
CREATE INDEX IF NOT EXISTS ix_organizations_tenant_id ON public.organizations (tenant_id);
CREATE INDEX IF NOT EXISTS ix_outreach_activities_created_by ON public.outreach_activities (created_by);
CREATE INDEX IF NOT EXISTS ix_outreach_messages_archived_by ON public.outreach_messages (archived_by);
CREATE INDEX IF NOT EXISTS ix_outreach_messages_template_id ON public.outreach_messages (template_id);
CREATE INDEX IF NOT EXISTS ix_payroll_items_org_id ON public.payroll_items (org_id);
CREATE INDEX IF NOT EXISTS ix_payroll_items_user_id ON public.payroll_items (user_id);
CREATE INDEX IF NOT EXISTS ix_payroll_runs_archived_by ON public.payroll_runs (archived_by);
CREATE INDEX IF NOT EXISTS ix_payroll_runs_created_by ON public.payroll_runs (created_by);
CREATE INDEX IF NOT EXISTS ix_payroll_runs_finance_entry_id ON public.payroll_runs (finance_entry_id);
CREATE INDEX IF NOT EXISTS ix_payroll_runs_org_id ON public.payroll_runs (org_id);
CREATE INDEX IF NOT EXISTS ix_pods_archived_by ON public.pods (archived_by);
CREATE INDEX IF NOT EXISTS ix_pods_lead_user_id ON public.pods (lead_user_id);
CREATE INDEX IF NOT EXISTS ix_points_awards_awarded_by ON public.points_awards (awarded_by);
CREATE INDEX IF NOT EXISTS ix_points_awards_org_id ON public.points_awards (org_id);
CREATE INDEX IF NOT EXISTS ix_points_awards_user_id ON public.points_awards (user_id);
CREATE INDEX IF NOT EXISTS ix_probation_reviews_decided_by ON public.probation_reviews (decided_by);
CREATE INDEX IF NOT EXISTS ix_probation_reviews_org_id ON public.probation_reviews (org_id);
CREATE INDEX IF NOT EXISTS ix_product_history_user_id ON public.product_history (user_id);
CREATE INDEX IF NOT EXISTS ix_product_metrics_brand_id ON public.product_metrics (brand_id);
CREATE INDEX IF NOT EXISTS ix_products_archived_by ON public.products (archived_by);
CREATE INDEX IF NOT EXISTS ix_projects_archived_by ON public.projects (archived_by);
CREATE INDEX IF NOT EXISTS ix_projects_brand_id ON public.projects (brand_id);
CREATE INDEX IF NOT EXISTS ix_projects_created_by ON public.projects (created_by);
CREATE INDEX IF NOT EXISTS ix_projects_department_id ON public.projects (department_id);
CREATE INDEX IF NOT EXISTS ix_projects_owner_id ON public.projects (owner_id);
CREATE INDEX IF NOT EXISTS ix_repetition_patterns_assignee_id ON public.repetition_patterns (assignee_id);
CREATE INDEX IF NOT EXISTS ix_repetition_patterns_matched_capability_id ON public.repetition_patterns (matched_capability_id);
CREATE INDEX IF NOT EXISTS ix_reports_generated_by ON public.reports (generated_by);
CREATE INDEX IF NOT EXISTS ix_return_cases_archived_by ON public.return_cases (archived_by);
CREATE INDEX IF NOT EXISTS ix_return_cases_brand_id ON public.return_cases (brand_id);
CREATE INDEX IF NOT EXISTS ix_return_cases_csr_owner ON public.return_cases (csr_owner);
CREATE INDEX IF NOT EXISTS ix_return_cases_warehouse_staff_id ON public.return_cases (warehouse_staff_id);
CREATE INDEX IF NOT EXISTS ix_skill_registry_created_by ON public.skill_registry (created_by);
CREATE INDEX IF NOT EXISTS ix_stock_movements_brand_id ON public.stock_movements (brand_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_personnel_id ON public.stock_movements (personnel_id);
CREATE INDEX IF NOT EXISTS ix_sync_runs_org_id ON public.sync_runs (org_id);
CREATE INDEX IF NOT EXISTS ix_sync_runs_shop_id ON public.sync_runs (shop_id);
CREATE INDEX IF NOT EXISTS ix_task_attachments_uploaded_by ON public.task_attachments (uploaded_by);
CREATE INDEX IF NOT EXISTS ix_task_comments_author_id ON public.task_comments (author_id);
CREATE INDEX IF NOT EXISTS ix_task_tags_tagged_by ON public.task_tags (tagged_by);
CREATE INDEX IF NOT EXISTS ix_tasks_archived_by ON public.tasks (archived_by);
CREATE INDEX IF NOT EXISTS ix_tasks_brand_id ON public.tasks (brand_id);
CREATE INDEX IF NOT EXISTS ix_tasks_created_by ON public.tasks (created_by);
CREATE INDEX IF NOT EXISTS ix_tiktok_connections_connected_by ON public.tiktok_connections (connected_by);
CREATE INDEX IF NOT EXISTS ix_tiktok_product_performance_brand_id ON public.tiktok_product_performance (brand_id);
CREATE INDEX IF NOT EXISTS ix_tiktok_settlements_brand_id ON public.tiktok_settlements (brand_id);
CREATE INDEX IF NOT EXISTS ix_tiktok_shop_performance_brand_id ON public.tiktok_shop_performance (brand_id);
CREATE INDEX IF NOT EXISTS ix_tony_memory_created_by ON public.tony_memory (created_by);
CREATE INDEX IF NOT EXISTS ix_users_department_id ON public.users (department_id);
CREATE INDEX IF NOT EXISTS ix_users_supervisor_id ON public.users (supervisor_id);
CREATE INDEX IF NOT EXISTS ix_vacancies_archived_by ON public.vacancies (archived_by);
CREATE INDEX IF NOT EXISTS ix_vacancies_created_by ON public.vacancies (created_by);
CREATE INDEX IF NOT EXISTS ix_vacancies_department_id ON public.vacancies (department_id);
CREATE INDEX IF NOT EXISTS ix_vacancies_org_id ON public.vacancies (org_id);
CREATE INDEX IF NOT EXISTS ix_vendors_created_by ON public.vendors (created_by);
CREATE INDEX IF NOT EXISTS ix_vendors_org_id ON public.vendors (org_id);
CREATE INDEX IF NOT EXISTS ix_vesper_clip_jobs_brand_id ON public.vesper_clip_jobs (brand_id);
CREATE INDEX IF NOT EXISTS ix_vesper_clip_jobs_requested_by ON public.vesper_clip_jobs (requested_by);
CREATE INDEX IF NOT EXISTS ix_videos_added_by ON public.videos (added_by);
CREATE INDEX IF NOT EXISTS ix_videos_archived_by ON public.videos (archived_by);
CREATE INDEX IF NOT EXISTS ix_videos_brand_id ON public.videos (brand_id);

-- =====================================================================
-- PART 2 — RLS init-plan: wrap session functions in scalar subqueries (38)
-- =====================================================================
DROP POLICY IF EXISTS ai_conversations_delete ON public.ai_conversations;
CREATE POLICY ai_conversations_delete ON public.ai_conversations
  FOR DELETE
  TO public
  USING ((user_id = (select auth.uid())));

DROP POLICY IF EXISTS ai_conversations_insert ON public.ai_conversations;
CREATE POLICY ai_conversations_insert ON public.ai_conversations
  FOR INSERT
  TO public
  WITH CHECK (((user_id = (select auth.uid())) AND (org_id = (select current_org_id()))));

DROP POLICY IF EXISTS ai_conversations_select ON public.ai_conversations;
CREATE POLICY ai_conversations_select ON public.ai_conversations
  FOR SELECT
  TO public
  USING (((user_id = (select auth.uid())) AND (org_id = (select current_org_id()))));

DROP POLICY IF EXISTS ai_conversations_update ON public.ai_conversations;
CREATE POLICY ai_conversations_update ON public.ai_conversations
  FOR UPDATE
  TO public
  USING ((user_id = (select auth.uid())));

DROP POLICY IF EXISTS ai_messages_insert ON public.ai_messages;
CREATE POLICY ai_messages_insert ON public.ai_messages
  FOR INSERT
  TO public
  WITH CHECK ((conversation_id IN ( SELECT ai_conversations.id FROM ai_conversations WHERE (ai_conversations.user_id = (select auth.uid())))));

DROP POLICY IF EXISTS ai_messages_select ON public.ai_messages;
CREATE POLICY ai_messages_select ON public.ai_messages
  FOR SELECT
  TO public
  USING ((conversation_id IN ( SELECT ai_conversations.id FROM ai_conversations WHERE (ai_conversations.user_id = (select auth.uid())))));

DROP POLICY IF EXISTS assistant_settings_own_insert ON public.assistant_settings;
CREATE POLICY assistant_settings_own_insert ON public.assistant_settings
  FOR INSERT
  TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS assistant_settings_own_select ON public.assistant_settings;
CREATE POLICY assistant_settings_own_select ON public.assistant_settings
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS assistant_settings_own_update ON public.assistant_settings;
CREATE POLICY assistant_settings_own_update ON public.assistant_settings
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS attendance_insert ON public.attendance;
CREATE POLICY attendance_insert ON public.attendance
  FOR INSERT
  TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));

DROP POLICY IF EXISTS attendance_select ON public.attendance;
CREATE POLICY attendance_select ON public.attendance
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));

DROP POLICY IF EXISTS attendance_update ON public.attendance;
CREATE POLICY attendance_update ON public.attendance
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));

DROP POLICY IF EXISTS case_updates_delete ON public.case_updates;
CREATE POLICY case_updates_delete ON public.case_updates
  FOR DELETE
  TO public
  USING ((user_id = (select auth.uid())));

DROP POLICY IF EXISTS case_updates_insert ON public.case_updates;
CREATE POLICY case_updates_insert ON public.case_updates
  FOR INSERT
  TO public
  WITH CHECK (((user_id = (select auth.uid())) AND (case_id IN ( SELECT cases.id FROM cases WHERE (cases.org_id = (select current_org_id()))))));

DROP POLICY IF EXISTS cfin_select ON public.contract_financials;
CREATE POLICY cfin_select ON public.contract_financials
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])) OR (((select current_user_role()) = 'department_head'::user_role) AND (EXISTS ( SELECT 1 FROM contract_scope_items csi WHERE ((csi.contract_id = contract_financials.contract_id) AND (csi.department_id = ( SELECT users.department_id FROM users WHERE (users.id = (select auth.uid())))))))))));

DROP POLICY IF EXISTS csi_delete ON public.contract_scope_items;
CREATE POLICY csi_delete ON public.contract_scope_items
  FOR DELETE
  TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])) OR (((select current_user_role()) = 'department_head'::user_role) AND (department_id = ( SELECT users.department_id FROM users WHERE (users.id = (select auth.uid()))))))));

DROP POLICY IF EXISTS csi_insert ON public.contract_scope_items;
CREATE POLICY csi_insert ON public.contract_scope_items
  FOR INSERT
  TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])) OR (((select current_user_role()) = 'department_head'::user_role) AND (department_id = ( SELECT users.department_id FROM users WHERE (users.id = (select auth.uid()))))))));

DROP POLICY IF EXISTS csi_update ON public.contract_scope_items;
CREATE POLICY csi_update ON public.contract_scope_items
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])) OR (((select current_user_role()) = 'department_head'::user_role) AND (department_id = ( SELECT users.department_id FROM users WHERE (users.id = (select auth.uid()))))))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])) OR (((select current_user_role()) = 'department_head'::user_role) AND (department_id = ( SELECT users.department_id FROM users WHERE (users.id = (select auth.uid()))))))));

DROP POLICY IF EXISTS contriblogs_read ON public.contributor_logs;
CREATE POLICY contriblogs_read ON public.contributor_logs
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND ((((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text])) OR (EXISTS ( SELECT 1 FROM moderator_brand_assignments m WHERE ((m.org_id = contributor_logs.org_id) AND (m.user_id = (select auth.uid())) AND (m.brand_id = contributor_logs.brand_id)))))));

DROP POLICY IF EXISTS contriblogs_update ON public.contributor_logs;
CREATE POLICY contriblogs_update ON public.contributor_logs
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND ((((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text])) OR (EXISTS ( SELECT 1 FROM moderator_brand_assignments m WHERE ((m.org_id = contributor_logs.org_id) AND (m.user_id = (select auth.uid())) AND (m.brand_id = contributor_logs.brand_id)))))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text])) OR (EXISTS ( SELECT 1 FROM moderator_brand_assignments m WHERE ((m.org_id = contributor_logs.org_id) AND (m.user_id = (select auth.uid())) AND (m.brand_id = contributor_logs.brand_id)))))));

DROP POLICY IF EXISTS dlr_insert ON public.daily_log_requests;
CREATE POLICY dlr_insert ON public.daily_log_requests
  FOR INSERT
  TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS dlr_select ON public.daily_log_requests;
CREATE POLICY dlr_select ON public.daily_log_requests
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));

DROP POLICY IF EXISTS dlr_update ON public.daily_log_requests;
CREATE POLICY dlr_update ON public.daily_log_requests
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));

DROP POLICY IF EXISTS daily_reports_own_insert ON public.daily_reports;
CREATE POLICY daily_reports_own_insert ON public.daily_reports
  FOR INSERT
  TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS daily_reports_update ON public.daily_reports;
CREATE POLICY daily_reports_update ON public.daily_reports
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))))
  WITH CHECK ((org_id = (select current_org_id())));

DROP POLICY IF EXISTS daily_taps_read ON public.daily_taps;
CREATE POLICY daily_taps_read ON public.daily_taps
  FOR SELECT
  TO authenticated
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));

DROP POLICY IF EXISTS department_brands_org_read ON public.department_brands;
CREATE POLICY department_brands_org_read ON public.department_brands
  FOR SELECT
  TO authenticated
  USING ((org_id = ( SELECT u.org_id FROM users u WHERE (u.id = (select auth.uid())))));

DROP POLICY IF EXISTS model_grants_select ON public.model_grants;
CREATE POLICY model_grants_select ON public.model_grants
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));

DROP POLICY IF EXISTS model_grants_update ON public.model_grants;
CREATE POLICY model_grants_update ON public.model_grants
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))))
  WITH CHECK (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS notifications_recipient_read ON public.notifications;
CREATE POLICY notifications_recipient_read ON public.notifications
  FOR SELECT
  TO public
  USING (((org_id = (select current_org_id())) AND ((user_id = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));

DROP POLICY IF EXISTS notifications_recipient_update ON public.notifications;
CREATE POLICY notifications_recipient_update ON public.notifications
  FOR UPDATE
  TO public
  USING (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))))
  WITH CHECK (((org_id = (select current_org_id())) AND (user_id = (select auth.uid()))));

DROP POLICY IF EXISTS projects_delete ON public.projects;
CREATE POLICY projects_delete ON public.projects
  FOR DELETE
  TO public
  USING (((org_id = (select current_org_id())) AND ((created_by = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));

DROP POLICY IF EXISTS task_attachments_delete ON public.task_attachments;
CREATE POLICY task_attachments_delete ON public.task_attachments
  FOR DELETE
  TO public
  USING ((uploaded_by = (select auth.uid())));

DROP POLICY IF EXISTS task_comments_delete ON public.task_comments;
CREATE POLICY task_comments_delete ON public.task_comments
  FOR DELETE
  TO public
  USING ((author_id = (select auth.uid())));

DROP POLICY IF EXISTS task_comments_insert ON public.task_comments;
CREATE POLICY task_comments_insert ON public.task_comments
  FOR INSERT
  TO public
  WITH CHECK (((author_id = (select auth.uid())) AND (task_id IN ( SELECT tasks.id FROM tasks WHERE (tasks.org_id = (select current_org_id()))))));

DROP POLICY IF EXISTS tasks_delete ON public.tasks;
CREATE POLICY tasks_delete ON public.tasks
  FOR DELETE
  TO public
  USING (((org_id = (select current_org_id())) AND ((created_by = (select auth.uid())) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));

DROP POLICY IF EXISTS users_insert_self ON public.users;
CREATE POLICY users_insert_self ON public.users
  FOR INSERT
  TO public
  WITH CHECK ((id = (select auth.uid())));

DROP POLICY IF EXISTS users_update_self ON public.users;
CREATE POLICY users_update_self ON public.users
  FOR UPDATE
  TO public
  USING ((id = (select auth.uid())));

COMMIT;
