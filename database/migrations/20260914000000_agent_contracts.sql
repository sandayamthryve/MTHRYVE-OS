-- Mthryve OS — Migration 20260914000000: Agent Contracts (department-scoped Tony)
--
-- WHAT THIS IS. The twelve-field agent contract from MTHRYVE_AGENTIC_ARCHITECTURE.md §3.3,
-- stored as DATA rather than code so a department's reach changes without a deploy
-- (§4.2: "PERMISSION = f(WHO asks, WHAT action, WHICH scope) — store it as data, not code").
--
-- WHY. Tony's permission surface is today a function of ROLE alone: buildReadTools(role)
-- (lib/assistant/read.ts:747), buildActTools(role) (lib/assistant/act.ts:483) and
-- guardToolCall(tool, role, denied) (lib/security/tool-tiers.ts:130). A Warehouse team member
-- and a Business Development team member therefore get the SAME agent with the SAME tools,
-- separated only by whatever RLS happens to scope. This table adds the missing third
-- dimension — DEPARTMENT — so each department gets its own Tony, limited to its own work.
--
-- ⚠ THIS MIGRATION IS INERT. It creates a table and seeds rows. NOTHING READS IT YET.
--    A contract row grants nothing and blocks nothing until the three enforcement layers take
--    a `contract` parameter (checklist Gate 3.3):
--      1. buildReadTools(role) / buildActTools(role)  → (role, contract)
--      2. current_user_department_id() + department predicates in RLS
--      3. guardToolCall(tool, role, denied)           → (tool, role, denied, contract)
--    Until then this is a declaration of intent that can be reviewed and corrected cheaply.
--
-- THE NARROWING RULE (non-negotiable). A contract may only ever NARROW what the caller's role
-- already permits. It must never widen it. RLS remains the hard boundary and the existing
-- leadership short-circuits (finance/payroll are ceo/coo-only) still apply on top. Listing a
-- tool in `tools` does not grant access to data the caller's role cannot already read — which
-- is why, for example, the HR & Admin contracts below deliberately omit get_payroll_summary.
--
-- GUARDRAILS ON THE TABLE ITSELF.
--   • RLS on. Org-scoped SELECT for any member (a user may read their own contract).
--   • WRITE IS ceo/coo ONLY — deliberately NOT department_head. A department must not be able
--     to widen its own reach. This is stricter than the ar_insert policy on action_requests.
--   • No executor, no side effects. This table describes authority; it never performs anything.
--
-- SEED. 16 rows per org: 7 departments × {department_head, team_member} + org-wide ceo + coo.
-- Department names are matched against the rows seeded in 0001_init_schema.sql. Idempotent:
-- ON CONFLICT DO NOTHING, so a re-run never clobbers a hand-tuned row.
--
-- OPEN FOR CEO SIGN-OFF (seeded as honest placeholders, not decisions):
--   • cost_limit_php per role — placeholders. No agent has a spend ceiling today.
--   • confidence_threshold — seeded lower-authority = more cautious (must escalate sooner).
--   • persona_name — identityForRole() currently hardcodes "Tony" (ceo) / "mini-Tony"
--     (everyone else). These names take effect only when Gate 3.3 wires this column.
--
-- ROLLBACK: drop table if exists public.agent_contracts;

create table if not exists public.agent_contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,

  -- NULL department_id = an ORG-WIDE contract (cross-department reach). Used for ceo/coo.
  department_id uuid references departments(id) on delete cascade,
  role user_role not null,

  -- ── The twelve fields (§3.3) ───────────────────────────────────────────────
  persona_name text not null,
  mission text not null,
  tools text[] not null default '{}',        -- must be keys of TOOL_TIERS (lib/security/tool-tiers.ts)
  read_scope text[] not null default '{}',   -- tables this persona may READ
  write_scope text[] not null default '{}',  -- executor action types this persona may CAUSE
  kpi text,
  cost_limit_php numeric(12,2),              -- NULL = no agent ceiling (org daily cap still applies)
  confidence_threshold numeric(3,2) not null default 0.70,
  escalates_to uuid references users(id) on delete set null,
  output_contract text,
  failure_modes text[] not null default '{}',
  permission_level smallint not null default 0,  -- L0–L4, canonical ladder §4.1

  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agent_contracts_level_ck check (permission_level between 0 and 4),
  constraint agent_contracts_confidence_ck check (confidence_threshold > 0 and confidence_threshold <= 1),
  constraint agent_contracts_cost_ck check (cost_limit_php is null or cost_limit_php >= 0),
  -- One contract per (org, department, role). NULLS NOT DISTINCT so the org-wide ceo/coo rows
  -- (department_id IS NULL) cannot be duplicated by a re-run — same precedent as
  -- 20260729130000_products_brand_sku_nulls_not_distinct.sql.
  constraint agent_contracts_scope_uq unique nulls not distinct (org_id, department_id, role)
);

create index if not exists agent_contracts_org_idx on public.agent_contracts(org_id);
create index if not exists agent_contracts_lookup_idx
  on public.agent_contracts(org_id, department_id, role) where enabled;

comment on table public.agent_contracts is
  'The twelve-field agent contract (MTHRYVE_AGENTIC_ARCHITECTURE.md §3.3), stored as data so a '
  'department''s agent reach changes without a deploy. A contract may only NARROW what the '
  'caller''s role already permits — never widen it. RLS remains the hard boundary. '
  'INERT until the three enforcement layers read it (checklist Gate 3.3).';
comment on column public.agent_contracts.department_id is
  'NULL = org-wide contract (cross-department reach). Used for ceo/coo.';
comment on column public.agent_contracts.tools is
  'Tool keys the persona may call. MUST be keys of TOOL_TIERS in lib/security/tool-tiers.ts — an '
  'unlisted tool already fails closed (treated as approval tier), so a typo here narrows, never widens.';
comment on column public.agent_contracts.write_scope is
  'Executor action types this persona may CAUSE to be filed. It never executes them: every '
  'consequential act still lands as a pending action_requests row and lib/actions/executor.ts '
  'remains the single point of execution.';
comment on column public.agent_contracts.confidence_threshold is
  'Below this value the agent must NOT act — it escalates to escalates_to. Today confidence is '
  'reported but never gated; this column is the gate Gate 3.2 wires.';
comment on column public.agent_contracts.cost_limit_php is
  'Spend ceiling per agent per day. PLACEHOLDER VALUES pending CEO sign-off. Today only '
  'observability exists (ai_usage_log + spend-spike detection in lib/security/anomaly.ts).';
comment on column public.agent_contracts.permission_level is
  'Canonical ladder §4.1: 0 OBSERVE, 1 RECOMMEND, 2 CONTROLLED EXECUTION, 3 SUPERVISED AUTONOMY, '
  '4 AUTONOMOUS. L4 is NOT authorised (open CEO decision #5). Approval is a GATE, not a level.';

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read: any org member (so a user can see the contract governing their own agent).
-- Write: ceo/coo ONLY — a department must not be able to widen its own reach.
alter table public.agent_contracts enable row level security;

drop policy if exists agent_contracts_select on public.agent_contracts;
create policy agent_contracts_select on public.agent_contracts for select
  using (org_id = current_org_id());

drop policy if exists agent_contracts_leadership_insert on public.agent_contracts;
create policy agent_contracts_leadership_insert on public.agent_contracts for insert
  with check (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  );

drop policy if exists agent_contracts_leadership_update on public.agent_contracts;
create policy agent_contracts_leadership_update on public.agent_contracts for update
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  )
  with check (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  );

drop policy if exists agent_contracts_leadership_delete on public.agent_contracts;
create policy agent_contracts_leadership_delete on public.agent_contracts for delete
  using (
    org_id = current_org_id()
    and current_user_role() in ('ceo', 'coo')
  );

drop trigger if exists agent_contracts_set_updated_at on public.agent_contracts;
create trigger agent_contracts_set_updated_at before update on public.agent_contracts
  for each row execute function set_updated_at();

-- ── SEED ────────────────────────────────────────────────────────────────────
-- 7 departments × {department_head, team_member} + org-wide ceo + coo, per org.
-- Escalation: team_member → their department lead; department_head → the COO.
do $$
declare
  v_org  record;
  v_coo  uuid;
  v_row  record;
begin
  for v_org in select id from organizations loop

    select id into v_coo from public.users
      where org_id = v_org.id and role = 'coo' limit 1;

    -- ── Org-wide leadership contracts (department_id IS NULL) ───────────────
    insert into public.agent_contracts (
      org_id, department_id, role, persona_name, mission, tools, read_scope, write_scope,
      kpi, cost_limit_php, confidence_threshold, escalates_to, output_contract,
      failure_modes, permission_level
    ) values (
      v_org.id, null, 'ceo', 'Tony',
      'Executive chief of staff. Cross-department reach, finance reach, the widest act tier the system allows.',
      array[
        'get_org_pulse','get_brand_status','get_department_plan','list_my_work','list_departments',
        'list_brands','list_projects','get_pending_approvals','get_returns_analysis',
        'get_finance_snapshot','get_payroll_summary','get_cashflow_forecast','get_budget_health',
        'search_finance_knowledge','list_automation_opportunities','search_knowledge','recall_memory',
        'search_capabilities','search_atlas_knowledge','recall_atlas_memory','get_graph_snapshot',
        'list_capabilities','get_team_care_pulse','get_probation_care_context','search_hr_knowledge',
        'get_my_care_summary','list_outreach_queue','get_outreach_target','search_outreach_knowledge',
        'draft_herald_message','list_prospect_queue','get_prospect_context','find_prospects',
        'search_prospect_knowledge','preview_scoreboard','navigate',
        'update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks',
        'log_wellbeing_pulse','propose_action','propose_play','propose_check_in','propose_atlas_capture',
        'propose_oracle_action','propose_herald_send','propose_prospect_task'
      ]::text[],
      array['*']::text[],
      array[
        'create_recovery_project','create_standards_task','create_replenishment_task','create_push_task',
        'create_cashflow_task','create_quality_task','create_lead','create_opportunity_task','ad_action',
        'advance_expense_stage','generate_scripts','forecast_restock','next_best_product','match_creators',
        'analyze_content_performance','compile_scoreboard','care_check_in','atlas_capture',
        'oracle_recommendation','log_followup','send_outreach'
      ]::text[],
      'Org GMV, operating profit, concentration risk, approval cycle time',
      2000.00, 0.60, null,
      'Answer with every fact prefixed by its origin (live data / document title / memory). Consequential acts as pending action_requests. Money is never executable.',
      array['over-trusts a stale marketplace sync','conflates a forecast with a fact','acts across departments without the owning head']::text[],
      3
    ) on conflict (org_id, department_id, role) do nothing;

    insert into public.agent_contracts (
      org_id, department_id, role, persona_name, mission, tools, read_scope, write_scope,
      kpi, cost_limit_php, confidence_threshold, escalates_to, output_contract,
      failure_modes, permission_level
    ) values (
      v_org.id, null, 'coo', 'Tony·Exec',
      'Operational chief of staff. Cross-department operational reach and finance visibility; approves everything operational.',
      array[
        'get_org_pulse','get_brand_status','get_department_plan','list_my_work','list_departments',
        'list_brands','list_projects','get_pending_approvals','get_returns_analysis',
        'get_finance_snapshot','get_cashflow_forecast','get_budget_health','search_finance_knowledge',
        'list_automation_opportunities','search_knowledge','recall_memory','search_capabilities',
        'search_atlas_knowledge','recall_atlas_memory','get_graph_snapshot','list_capabilities',
        'get_team_care_pulse','search_hr_knowledge','get_my_care_summary','list_outreach_queue',
        'get_outreach_target','search_outreach_knowledge','draft_herald_message','list_prospect_queue',
        'get_prospect_context','find_prospects','search_prospect_knowledge','preview_scoreboard','navigate',
        'update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks',
        'log_wellbeing_pulse','propose_action','propose_play','propose_check_in','propose_atlas_capture',
        'propose_oracle_action','propose_herald_send','propose_prospect_task'
      ]::text[],
      array['*']::text[],
      array[
        'create_recovery_project','create_standards_task','create_replenishment_task','create_push_task',
        'create_quality_task','create_lead','create_opportunity_task','ad_action','generate_scripts',
        'forecast_restock','next_best_product','match_creators','analyze_content_performance',
        'compile_scoreboard','care_check_in','atlas_capture','log_followup'
      ]::text[],
      'Approval cycle time, department KPI attainment, exception rate',
      1500.00, 0.65, null,
      'Answer with cited origin per fact. Consequential acts as pending action_requests. Money is never executable.',
      array['approves outside the owning department''s knowledge','misses a stale integration']::text[],
      3
    ) on conflict (org_id, department_id, role) do nothing;

    -- ── The seven departments ───────────────────────────────────────────────
    for v_row in
      select d.id as department_id, d.lead_user_id, t.*
      from (values

        -- ① LIVE OPERATIONS
        ('Live Operations','department_head','Tony·Live',
         'Run live selling: schedules, product sequencing, host briefs, in-session performance and post-live reporting.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_brands','list_my_work','list_departments','list_projects','get_pending_approvals','preview_scoreboard','list_automation_opportunities','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks','propose_action','propose_play']::text[],
         array['live_sessions','brands','products','content_performance','metrics_snapshots','tasks','projects','pods']::text[],
         array['next_best_product','compile_scoreboard','analyze_content_performance','create_push_task']::text[],
         'Live GMV per session, sell-through on pushed SKUs, session uptime',
         300.00, 0.70, 2,
         'Live figures only from live_sessions / TikTok readers. Honest em-dash where a metric has no entry.',
         array['reads a scheduled session as an actual one','pushes a SKU without checking stock']::text[]),

        ('Live Operations','team_member','Tony·Live (team)',
         'Support live selling: own tasks, session prep, content capture.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_my_work','list_departments','list_projects','preview_scoreboard','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks']::text[],
         array['live_sessions','brands','products','tasks','projects']::text[],
         array[]::text[],
         'Task completion, session prep on time',
         100.00, 0.80, 1,
         'Self-scoped answers and own-task updates only. Anything larger is routed to the department head.',
         array['attempts a cross-department act it cannot file']::text[]),

        -- ② CREATIVE
        ('Creative','department_head','Tony·Creative',
         'Creative briefs, scripts, hooks, captions and content QA for the brands under management.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_brands','list_my_work','list_departments','list_projects','get_pending_approvals','search_knowledge','recall_memory','search_capabilities','search_atlas_knowledge','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks','propose_action','propose_play']::text[],
         array['content_items','content_performance','brands','documents','tasks','projects']::text[],
         array['generate_scripts','create_standards_task','analyze_content_performance']::text[],
         'Content output per pillar, format-level conversion, revision rate',
         300.00, 0.70, 2,
         'Drafts are staged internal content_items — never published. Client-facing work requires CEO/COO approval.',
         array['ships a caption that was never brand-reviewed (no WARDEN gate exists yet — checklist Gate 8)','quotes a document figure as a live number']::text[]),

        ('Creative','team_member','Tony·Creative (team)',
         'Draft scripts and content items; own tasks.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_my_work','list_departments','list_projects','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks']::text[],
         array['content_items','brands','documents','tasks','projects']::text[],
         array[]::text[],
         'Drafts delivered on brief, on time',
         100.00, 0.80, 1,
         'Staged internal drafts only. Nothing publishes.',
         array['assumes a draft was approved']::text[]),

        -- ③ AFFILIATE MARKETING
        ('Affiliate Marketing','department_head','Tony·Creators',
         'Creator discovery, scoring, recruitment, sample and deadline tracking, affiliate performance.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_brands','list_my_work','list_departments','list_projects','get_pending_approvals','preview_scoreboard','list_outreach_queue','get_outreach_target','search_outreach_knowledge','draft_herald_message','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks','propose_action','propose_play','propose_herald_send']::text[],
         array['creators','creator_tiers','brands','content_performance','action_requests','tasks','projects']::text[],
         array['match_creators','log_followup','create_standards_task','analyze_content_performance']::text[],
         'Active creators per brand, creator GMV contribution, reactivation rate',
         300.00, 0.70, 2,
         'Creator rankings cite the scoring inputs. Outreach is staged, never sent without approval.',
         array['ranks a creator on stale content_performance','treats a staged draft as a sent message']::text[]),

        ('Affiliate Marketing','team_member','Tony·Creators (team)',
         'Creator research, sample and deadline follow-through; own tasks.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_my_work','list_departments','list_projects','get_outreach_target','search_outreach_knowledge','draft_herald_message','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks']::text[],
         array['creators','creator_tiers','brands','tasks','projects']::text[],
         array[]::text[],
         'Creator follow-through rate, deadline adherence',
         100.00, 0.80, 1,
         'Drafts a message; never files a send. Routes to the department head.',
         array['attempts to file an approval it cannot insert']::text[]),

        -- ④ BUSINESS DEVELOPMENT
        ('Business Development','department_head','Tony·BizDev',
         'Prospect research, lead scoring, outreach preparation, pipeline monitoring and client onboarding.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_brands','list_my_work','list_departments','list_projects','get_pending_approvals','list_prospect_queue','get_prospect_context','find_prospects','search_prospect_knowledge','list_outreach_queue','get_outreach_target','search_outreach_knowledge','draft_herald_message','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks','propose_action','propose_prospect_task','propose_herald_send']::text[],
         array['leads','brands','contracts','contract_scope_items','action_requests','tasks','projects']::text[],
         array['create_lead','create_opportunity_task','log_followup','send_outreach','create_recovery_project']::text[],
         'Qualified pipeline value, win rate, time-to-first-meeting',
         300.00, 0.70, 2,
         'Prospect tiers are labelled real or stub — never invented as real when opportunity_engine is unconfigured.',
         array['presents a stub score as a real one','creates a second pipeline source of truth']::text[]),

        ('Business Development','team_member','Tony·BizDev (team)',
         'Prospect research and follow-up preparation; own tasks.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_my_work','list_departments','list_projects','get_prospect_context','find_prospects','search_prospect_knowledge','get_outreach_target','draft_herald_message','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks']::text[],
         array['leads','brands','tasks','projects']::text[],
         array[]::text[],
         'Research throughput, follow-up preparation quality',
         100.00, 0.80, 1,
         'Never contacts a prospect. Drafts only.',
         array['assumes a drafted follow-up was sent']::text[]),

        -- ⑤ E-COMMERCE OPS
        ('E-Commerce Ops','department_head','Tony·Commerce',
         'Listing health, pricing and promo analysis, shop health, SKU and campaign performance across marketplaces.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_brands','list_my_work','list_departments','list_projects','get_pending_approvals','get_returns_analysis','list_automation_opportunities','preview_scoreboard','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks','propose_action','propose_play']::text[],
         array['tiktok_shop_performance','tiktok_orders','products','return_cases','metrics_snapshots','content_performance','brands','tasks']::text[],
         array['next_best_product','analyze_content_performance','ad_action','create_push_task','create_quality_task']::text[],
         'GMV, ROAS, return rate, listing health',
         300.00, 0.70, 2,
         'GMV has ONE source of truth (tiktok_shop_performance). Never derive a second revenue figure.',
         array['reconciles against a dashboard instead of the canonical source','reads a stale sync as current']::text[]),

        ('E-Commerce Ops','team_member','Tony·Commerce (team)',
         'Listing and order support; own tasks.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_my_work','list_departments','list_projects','get_returns_analysis','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','add_content_item','pin_memory_note','create_mission_tasks']::text[],
         array['tiktok_orders','products','return_cases','brands','tasks']::text[],
         array[]::text[],
         'Order issue resolution time',
         100.00, 0.80, 1,
         'Reads only. Own-task updates. Escalates anything commercial.',
         array['quotes a figure without naming its source']::text[]),

        -- ⑥ HR & ADMIN
        -- NOTE: get_payroll_summary and get_finance_snapshot are DELIBERATELY ABSENT.
        -- Payroll is ceo/coo-only in code and in RLS; a contract must never appear to widen that.
        ('HR & Admin','department_head','Tony·People',
         'Wellbeing, probation care, attendance and HR knowledge. Warm, concise, confidential.',
         array['get_org_pulse','get_department_plan','list_my_work','list_departments','list_projects','get_pending_approvals','get_my_care_summary','get_team_care_pulse','get_probation_care_context','search_hr_knowledge','log_wellbeing_pulse','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','pin_memory_note','create_mission_tasks','propose_action','propose_check_in']::text[],
         array['users','departments','wellbeing_pulses','care_check_ins','documents','tasks']::text[],
         array['care_check_in']::text[],
         'Probation reviews on time, check-in completion, attendance exceptions closed',
         300.00, 0.75, 2,
         'Raw mood is self-only. Team pulse is an anonymized average plus count — never a named person''s mood.',
         array['exposes an individual''s raw wellbeing data','treats an aggregate as an individual signal']::text[]),

        ('HR & Admin','team_member','Tony·People (team)',
         'Own wellbeing pulse, HR policy lookup, own tasks.',
         array['get_org_pulse','get_department_plan','list_my_work','list_departments','get_my_care_summary','search_hr_knowledge','log_wellbeing_pulse','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','pin_memory_note','create_mission_tasks']::text[],
         array['wellbeing_pulses','documents','tasks']::text[],
         array[]::text[],
         'Self-service resolution of HR questions',
         100.00, 0.85, 1,
         'Self-scoped only. Never another person''s data.',
         array['asks for a colleague''s record']::text[]),

        -- ⑦ WAREHOUSE & FULFILLMENT
        ('Warehouse & Fulfillment','department_head','Tony·Warehouse',
         'Inventory, inbound/outbound, SKU movement, fulfillment, aging stock, replenishment and courier coordination.',
         array['get_org_pulse','get_department_plan','get_brand_status','list_brands','list_my_work','list_departments','list_projects','get_pending_approvals','get_returns_analysis','list_automation_opportunities','preview_scoreboard','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','pin_memory_note','create_mission_tasks','propose_action','propose_play']::text[],
         array['products','stock_movements','return_cases','tiktok_orders','brands','tasks','projects']::text[],
         array['forecast_restock','create_replenishment_task','create_quality_task']::text[],
         'Stock-out incidents, fill rate, aging inventory value, inbound accuracy',
         300.00, 0.70, 2,
         'Restock signals cite velocity and lead time. A PO is proposed, never placed — no external action.',
         array['forecasts on an unmapped SKU','misses a lengthening supplier lead time','treats a task as a received PO']::text[]),

        ('Warehouse & Fulfillment','team_member','Tony·Warehouse (team)',
         'Stock movement recording support, order fulfillment, own tasks.',
         array['get_org_pulse','get_department_plan','list_my_work','list_departments','list_projects','get_returns_analysis','search_knowledge','recall_memory','search_capabilities','navigate','update_my_task_status','pin_memory_note','create_mission_tasks']::text[],
         array['products','stock_movements','tiktok_orders','tasks']::text[],
         array[]::text[],
         'Pick/pack accuracy, movement logging completeness',
         100.00, 0.85, 1,
         'Reads and own-task updates only. Escalates stock decisions to the department head.',
         array['infers stock from orders instead of stock_movements']::text[])

      ) as t(
        dept_name, role_name, persona_name, mission, tools, read_scope, write_scope,
        kpi, cost_limit, conf, lvl, output_contract, failure_modes
      )
      join public.departments d
        on d.org_id = v_org.id and d.name = t.dept_name
    loop
      insert into public.agent_contracts (
        org_id, department_id, role, persona_name, mission, tools, read_scope, write_scope,
        kpi, cost_limit_php, confidence_threshold, escalates_to, output_contract,
        failure_modes, permission_level
      ) values (
        v_org.id,
        v_row.department_id,
        v_row.role_name::user_role,
        v_row.persona_name,
        v_row.mission,
        v_row.tools,
        v_row.read_scope,
        v_row.write_scope,
        v_row.kpi,
        v_row.cost_limit,
        v_row.conf,
        -- team members escalate to their department lead; heads escalate to the COO
        case when v_row.role_name = 'team_member' then v_row.lead_user_id else v_coo end,
        v_row.output_contract,
        v_row.failure_modes,
        v_row.lvl
      ) on conflict (org_id, department_id, role) do nothing;
    end loop;

  end loop;
end $$;

-- ── VERIFY (run by hand after applying) ─────────────────────────────────────
-- Expect 16 rows per org: 7 departments × 2 roles + ceo + coo.
--   select count(*) from public.agent_contracts;
--
-- Every department covered, both roles:
--   select d.name, c.role, c.persona_name, c.permission_level,
--          cardinality(c.tools) as tool_count, c.escalates_to is null as no_escalation_target
--     from public.agent_contracts c
--     left join public.departments d on d.id = c.department_id
--    order by d.name nulls first, c.role;
--
-- CATCH: rows where escalates_to is NULL because the department has no lead_user_id set,
-- or the org has no coo. Fill those in before Gate 3.3 wires the escalation path:
--   select d.name, c.role from public.agent_contracts c
--     join public.departments d on d.id = c.department_id
--    where c.escalates_to is null;
--
-- CATCH: any tool name that is not a key of TOOL_TIERS (lib/security/tool-tiers.ts).
-- There is no DB-side check for this by design — an unknown tool already fails closed at
-- runtime (treated as approval tier), so a typo narrows rather than widens. Verify in review.
