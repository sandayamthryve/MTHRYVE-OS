SET search_path = public;

-- ============================================================================
-- Phase 0.3 — RLS performance: consolidate multiple permissive policies and
-- wrap auth/helper calls so they evaluate ONCE per query (InitPlan), not per row.
-- Access is preserved EXACTLY: Postgres already combines permissive policies
-- with OR, so one policy per (table, role, action) whose condition is the OR of
-- the originals is identical; (select fn()) is value-identical for STABLE fns.
-- Idempotent + additive: only policies and unused indexes change; no table/column DDL.
-- ============================================================================

-- ── A. Consolidate multiple permissive policies (36 tables) ──

-- anchors: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "anchors_org_select" ON public.anchors;
DROP POLICY IF EXISTS "anchors_org_write" ON public.anchors;
CREATE POLICY "anchors_select" ON public.anchors AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "anchors_insert" ON public.anchors AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "anchors_update" ON public.anchors AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "anchors_delete" ON public.anchors AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- automation_registry: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "automation_registry_select" ON public.automation_registry;
DROP POLICY IF EXISTS "automation_registry_write" ON public.automation_registry;
CREATE POLICY "automation_registry_select" ON public.automation_registry AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "automation_registry_insert" ON public.automation_registry AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "automation_registry_update" ON public.automation_registry AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "automation_registry_delete" ON public.automation_registry AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));

-- brand_initiatives: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "bi_select" ON public.brand_initiatives;
DROP POLICY IF EXISTS "bi_write" ON public.brand_initiatives;
CREATE POLICY "brand_initiatives_select" ON public.brand_initiatives AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "brand_initiatives_insert" ON public.brand_initiatives AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "brand_initiatives_update" ON public.brand_initiatives AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "brand_initiatives_delete" ON public.brand_initiatives AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- brand_source_breakdown: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "bsb_select" ON public.brand_source_breakdown;
DROP POLICY IF EXISTS "bsb_write" ON public.brand_source_breakdown;
CREATE POLICY "brand_source_breakdown_select" ON public.brand_source_breakdown AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "brand_source_breakdown_insert" ON public.brand_source_breakdown AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "brand_source_breakdown_update" ON public.brand_source_breakdown AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "brand_source_breakdown_delete" ON public.brand_source_breakdown AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- budgets: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "budgets_read" ON public.budgets;
DROP POLICY IF EXISTS "budgets_write" ON public.budgets;
CREATE POLICY "budgets_select" ON public.budgets AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));
CREATE POLICY "budgets_insert" ON public.budgets AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));
CREATE POLICY "budgets_update" ON public.budgets AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));
CREATE POLICY "budgets_delete" ON public.budgets AS PERMISSIVE FOR DELETE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));

-- capabilities: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "capabilities_select" ON public.capabilities;
DROP POLICY IF EXISTS "capabilities_write" ON public.capabilities;
CREATE POLICY "capabilities_select" ON public.capabilities AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "capabilities_insert" ON public.capabilities AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "capabilities_update" ON public.capabilities AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "capabilities_delete" ON public.capabilities AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- cash_positions: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "cash_positions_select" ON public.cash_positions;
DROP POLICY IF EXISTS "cash_positions_write" ON public.cash_positions;
CREATE POLICY "cash_positions_select" ON public.cash_positions AS PERMISSIVE FOR SELECT TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "cash_positions_insert" ON public.cash_positions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "cash_positions_update" ON public.cash_positions AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "cash_positions_delete" ON public.cash_positions AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));

-- client_contracts: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "client_contracts_leadership_write" ON public.client_contracts;
DROP POLICY IF EXISTS "client_contracts_org_select" ON public.client_contracts;
CREATE POLICY "client_contracts_select" ON public.client_contracts AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "client_contracts_insert" ON public.client_contracts AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "client_contracts_update" ON public.client_contracts AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "client_contracts_delete" ON public.client_contracts AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- content_performance: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "content_performance_select" ON public.content_performance;
DROP POLICY IF EXISTS "content_performance_write" ON public.content_performance;
CREATE POLICY "content_performance_select" ON public.content_performance AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "content_performance_insert" ON public.content_performance AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "content_performance_update" ON public.content_performance AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "content_performance_delete" ON public.content_performance AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- contributors: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "contributors_read" ON public.contributors;
DROP POLICY IF EXISTS "contributors_write" ON public.contributors;
CREATE POLICY "contributors_select" ON public.contributors AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "contributors_insert" ON public.contributors AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))));
CREATE POLICY "contributors_update" ON public.contributors AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))));
CREATE POLICY "contributors_delete" ON public.contributors AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))));

-- creator_posts: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "creator_posts_org_select" ON public.creator_posts;
DROP POLICY IF EXISTS "creator_posts_org_write" ON public.creator_posts;
CREATE POLICY "creator_posts_select" ON public.creator_posts AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "creator_posts_insert" ON public.creator_posts AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "creator_posts_update" ON public.creator_posts AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "creator_posts_delete" ON public.creator_posts AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- creator_tiers: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "creator_tiers_select" ON public.creator_tiers;
DROP POLICY IF EXISTS "creator_tiers_write" ON public.creator_tiers;
CREATE POLICY "creator_tiers_select" ON public.creator_tiers AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "creator_tiers_insert" ON public.creator_tiers AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "creator_tiers_update" ON public.creator_tiers AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "creator_tiers_delete" ON public.creator_tiers AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- csi_findings: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "csi_findings_select" ON public.csi_findings;
DROP POLICY IF EXISTS "csi_findings_write" ON public.csi_findings;
CREATE POLICY "csi_findings_select" ON public.csi_findings AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "csi_findings_insert" ON public.csi_findings AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "csi_findings_update" ON public.csi_findings AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "csi_findings_delete" ON public.csi_findings AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- document_chunks: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "document_chunks_select" ON public.document_chunks;
DROP POLICY IF EXISTS "document_chunks_write" ON public.document_chunks;
CREATE POLICY "document_chunks_select" ON public.document_chunks AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR (((org_id = (select current_org_id())) AND (EXISTS ( SELECT 1
   FROM documents d
  WHERE ((d.id = document_chunks.document_id) AND ((d.sensitivity = 'org'::text) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))))))));
CREATE POLICY "document_chunks_insert" ON public.document_chunks AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "document_chunks_update" ON public.document_chunks AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "document_chunks_delete" ON public.document_chunks AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- documents: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "documents_select" ON public.documents;
DROP POLICY IF EXISTS "documents_write" ON public.documents;
CREATE POLICY "documents_select" ON public.documents AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR (((org_id = (select current_org_id())) AND ((sensitivity = 'org'::text) OR ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))))));
CREATE POLICY "documents_insert" ON public.documents AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "documents_update" ON public.documents AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "documents_delete" ON public.documents AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- expense_categories: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "expcat_read" ON public.expense_categories;
DROP POLICY IF EXISTS "expcat_write" ON public.expense_categories;
CREATE POLICY "expense_categories_select" ON public.expense_categories AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));
CREATE POLICY "expense_categories_insert" ON public.expense_categories AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));
CREATE POLICY "expense_categories_update" ON public.expense_categories AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));
CREATE POLICY "expense_categories_delete" ON public.expense_categories AS PERMISSIVE FOR DELETE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));

-- live_bottlenecks: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "live_bottlenecks_select" ON public.live_bottlenecks;
DROP POLICY IF EXISTS "live_bottlenecks_write" ON public.live_bottlenecks;
CREATE POLICY "live_bottlenecks_select" ON public.live_bottlenecks AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text)))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "live_bottlenecks_insert" ON public.live_bottlenecks AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))));
CREATE POLICY "live_bottlenecks_update" ON public.live_bottlenecks AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))));
CREATE POLICY "live_bottlenecks_delete" ON public.live_bottlenecks AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))));

-- live_session_attachments: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "live_session_attachments_select" ON public.live_session_attachments;
DROP POLICY IF EXISTS "live_session_attachments_write" ON public.live_session_attachments;
CREATE POLICY "live_session_attachments_select" ON public.live_session_attachments AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text)))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "live_session_attachments_insert" ON public.live_session_attachments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))));
CREATE POLICY "live_session_attachments_update" ON public.live_session_attachments AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))));
CREATE POLICY "live_session_attachments_delete" ON public.live_session_attachments AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (lower(COALESCE((select current_user_team()), ''::text)) ~~ '%live%'::text))));

-- live_sessions: 4 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "live_sessions_org_select" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_org_write" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_read" ON public.live_sessions;
DROP POLICY IF EXISTS "live_sessions_write" ON public.live_sessions;
CREATE POLICY "live_sessions_select" ON public.live_sessions AS PERMISSIVE FOR SELECT TO public
  USING (((org_id = (select current_org_id()))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));
CREATE POLICY "live_sessions_insert" ON public.live_sessions AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id()))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));
CREATE POLICY "live_sessions_update" ON public.live_sessions AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id()))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))))
  WITH CHECK (((org_id = (select current_org_id()))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));
CREATE POLICY "live_sessions_delete" ON public.live_sessions AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id()))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))));

-- marketplace_shops: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "mshops_select" ON public.marketplace_shops;
DROP POLICY IF EXISTS "mshops_write" ON public.marketplace_shops;
CREATE POLICY "marketplace_shops_select" ON public.marketplace_shops AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "marketplace_shops_insert" ON public.marketplace_shops AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "marketplace_shops_update" ON public.marketplace_shops AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "marketplace_shops_delete" ON public.marketplace_shops AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));

-- media_assets: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "media_assets_select" ON public.media_assets;
DROP POLICY IF EXISTS "media_assets_write" ON public.media_assets;
CREATE POLICY "media_assets_select" ON public.media_assets AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "media_assets_insert" ON public.media_assets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "media_assets_update" ON public.media_assets AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "media_assets_delete" ON public.media_assets AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- moderator_brand_assignments: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "modassign_read" ON public.moderator_brand_assignments;
DROP POLICY IF EXISTS "modassign_write" ON public.moderator_brand_assignments;
CREATE POLICY "moderator_brand_assignments_select" ON public.moderator_brand_assignments AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "moderator_brand_assignments_insert" ON public.moderator_brand_assignments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text]))));
CREATE POLICY "moderator_brand_assignments_update" ON public.moderator_brand_assignments AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text]))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text]))));
CREATE POLICY "moderator_brand_assignments_delete" ON public.moderator_brand_assignments AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text]))));

-- outreach_templates: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "outreach_templates_org_read" ON public.outreach_templates;
DROP POLICY IF EXISTS "outreach_templates_write" ON public.outreach_templates;
CREATE POLICY "outreach_templates_select" ON public.outreach_templates AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "outreach_templates_insert" ON public.outreach_templates AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "outreach_templates_update" ON public.outreach_templates AS PERMISSIVE FOR UPDATE TO public
  USING ((org_id = (select current_org_id())))
  WITH CHECK ((org_id = (select current_org_id())));
CREATE POLICY "outreach_templates_delete" ON public.outreach_templates AS PERMISSIVE FOR DELETE TO public
  USING ((org_id = (select current_org_id())));

-- pod_brands: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "pod_brands_select" ON public.pod_brands;
DROP POLICY IF EXISTS "pod_brands_write" ON public.pod_brands;
CREATE POLICY "pod_brands_select" ON public.pod_brands AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "pod_brands_insert" ON public.pod_brands AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "pod_brands_update" ON public.pod_brands AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "pod_brands_delete" ON public.pod_brands AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- pods: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "pods_select" ON public.pods;
DROP POLICY IF EXISTS "pods_write" ON public.pods;
CREATE POLICY "pods_select" ON public.pods AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "pods_insert" ON public.pods AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "pods_update" ON public.pods AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "pods_delete" ON public.pods AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- policy_registry: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "policy_registry_leadership_write" ON public.policy_registry;
DROP POLICY IF EXISTS "policy_registry_org_read" ON public.policy_registry;
CREATE POLICY "policy_registry_select" ON public.policy_registry AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "policy_registry_insert" ON public.policy_registry AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "policy_registry_update" ON public.policy_registry AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "policy_registry_delete" ON public.policy_registry AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- product_metrics: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "product_metrics_select" ON public.product_metrics;
DROP POLICY IF EXISTS "product_metrics_write" ON public.product_metrics;
CREATE POLICY "product_metrics_select" ON public.product_metrics AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "product_metrics_insert" ON public.product_metrics AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "product_metrics_update" ON public.product_metrics AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "product_metrics_delete" ON public.product_metrics AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- products: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "products_org_select" ON public.products;
DROP POLICY IF EXISTS "products_write" ON public.products;
CREATE POLICY "products_select" ON public.products AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text)))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "products_insert" ON public.products AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))));
CREATE POLICY "products_update" ON public.products AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))));
CREATE POLICY "products_delete" ON public.products AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))));

-- shop_ads: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "shop_ads_select" ON public.shop_ads;
DROP POLICY IF EXISTS "shop_ads_write" ON public.shop_ads;
CREATE POLICY "shop_ads_select" ON public.shop_ads AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "shop_ads_insert" ON public.shop_ads AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "shop_ads_update" ON public.shop_ads AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "shop_ads_delete" ON public.shop_ads AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- shop_ratings: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "shop_ratings_select" ON public.shop_ratings;
DROP POLICY IF EXISTS "shop_ratings_write" ON public.shop_ratings;
CREATE POLICY "shop_ratings_select" ON public.shop_ratings AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "shop_ratings_insert" ON public.shop_ratings AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "shop_ratings_update" ON public.shop_ratings AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));
CREATE POLICY "shop_ratings_delete" ON public.shop_ratings AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));

-- skill_registry: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "skill_registry_select" ON public.skill_registry;
DROP POLICY IF EXISTS "skill_registry_write" ON public.skill_registry;
CREATE POLICY "skill_registry_select" ON public.skill_registry AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "skill_registry_insert" ON public.skill_registry AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "skill_registry_update" ON public.skill_registry AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));
CREATE POLICY "skill_registry_delete" ON public.skill_registry AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role]))));

-- stock_levels: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "stock_levels_select" ON public.stock_levels;
DROP POLICY IF EXISTS "stock_levels_write" ON public.stock_levels;
CREATE POLICY "stock_levels_select" ON public.stock_levels AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text)))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "stock_levels_insert" ON public.stock_levels AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))));
CREATE POLICY "stock_levels_update" ON public.stock_levels AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))));
CREATE POLICY "stock_levels_delete" ON public.stock_levels AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])) OR (COALESCE((select current_user_team()), ''::text) ~~* '%warehouse%'::text))));

-- task_tags: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "task_tags_read" ON public.task_tags;
DROP POLICY IF EXISTS "task_tags_write" ON public.task_tags;
CREATE POLICY "task_tags_select" ON public.task_tags AS PERMISSIVE FOR SELECT TO public
  USING ((((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "task_tags_insert" ON public.task_tags AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))));
CREATE POLICY "task_tags_update" ON public.task_tags AS PERMISSIVE FOR UPDATE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))))
  WITH CHECK (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))));
CREATE POLICY "task_tags_delete" ON public.task_tags AS PERMISSIVE FOR DELETE TO public
  USING (((org_id = (select current_org_id())) AND (((select current_user_role()))::text = ANY (ARRAY['ceo'::text, 'coo'::text, 'department_head'::text]))));

-- users: 4 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "users_insert_self" ON public.users;
DROP POLICY IF EXISTS "users_select_same_org" ON public.users;
DROP POLICY IF EXISTS "users_update_as_admin" ON public.users;
DROP POLICY IF EXISTS "users_update_self" ON public.users;
CREATE POLICY "users_select" ON public.users AS PERMISSIVE FOR SELECT TO public
  USING ((org_id = (select current_org_id())));
CREATE POLICY "users_insert" ON public.users AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "users_update" ON public.users AS PERMISSIVE FOR UPDATE TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))) OR ((id = ( SELECT auth.uid() AS uid))))
  WITH CHECK ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))) OR ((id = ( SELECT auth.uid() AS uid))));

-- vendors: 2 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "vendors_read" ON public.vendors;
DROP POLICY IF EXISTS "vendors_write" ON public.vendors;
CREATE POLICY "vendors_select" ON public.vendors AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role))) OR (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role])))));
CREATE POLICY "vendors_insert" ON public.vendors AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));
CREATE POLICY "vendors_update" ON public.vendors AS PERMISSIVE FOR UPDATE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)))
  WITH CHECK (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));
CREATE POLICY "vendors_delete" ON public.vendors AS PERMISSIVE FOR DELETE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = 'coo'::user_role)));

-- videos: 4 policies -> one permissive policy per (role, action)
DROP POLICY IF EXISTS "videos_insert" ON public.videos;
DROP POLICY IF EXISTS "videos_read" ON public.videos;
DROP POLICY IF EXISTS "videos_update" ON public.videos;
DROP POLICY IF EXISTS "videos_write" ON public.videos;
CREATE POLICY "videos_select" ON public.videos AS PERMISSIVE FOR SELECT TO authenticated
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "videos_insert" ON public.videos AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "videos_update" ON public.videos AS PERMISSIVE FOR UPDATE TO public
  USING ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))))
  WITH CHECK ((((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role])))) OR ((org_id = (select current_org_id()))));
CREATE POLICY "videos_delete" ON public.videos AS PERMISSIVE FOR DELETE TO authenticated
  USING (((org_id = (select current_org_id())) AND ((select current_user_role()) = ANY (ARRAY['ceo'::user_role, 'coo'::user_role, 'department_head'::user_role]))));


