-- Mthryve OS — Migration 20260717000000: Policy Registry (centralized rulebook)
--
-- ONE editable rulebook that agents and consequential server actions consult
-- BEFORE acting. This does NOT loosen any control: RLS, the money-gate, and the
-- approval spine still ENFORCE. The registry is the single SOURCE of the rules
-- those gates read — the rules that used to be scattered across prose
-- (DECISIONS.md), RLS (SQL), and TypeScript guards now live as DATA here, so a
-- threshold or rule can change without touching code.
--
-- GOVERNING RULES (mirror the rest of the OS):
--   1. Standard stack + RLS. Reuses current_org_id() / current_user_role() and
--      set_updated_at(). org read; leadership (ceo/coo) write — the same gate as
--      model_grants (0016) and audit_logs (0008).
--   2. Fresh timestamp version (the 0017–0027 ordinals are already taken by other
--      waves) so the migration runner actually applies it.
--   3. Seeds the rules that ALREADY exist, now as rows. Idempotent: the seed is
--      an insert…select over organizations with on-conflict do-nothing, so it is
--      safe to re-apply and never clobbers a threshold leadership has since edited.
--
-- Applied to project otepdjhrawtqkzclaxbk (migration `policy_registry`).

-- ── policy_registry: one governance rule, as data ────────────────────────────
create table if not exists public.policy_registry (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null default public.current_org_id()
                references public.organizations(id) on delete cascade,
  key         text not null,
  category    text not null check (category in (
                'approval', 'spend', 'tool_permission', 'data_access',
                'audit', 'escalation', 'confidence', 'compliance')),
  scope       text,
  rule        jsonb not null default '{}',
  description text,
  active      boolean not null default true,
  created_by  uuid default auth.uid() references public.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  unique (org_id, key)
);

create index if not exists policy_registry_org_category_idx
  on public.policy_registry (org_id, category);
create index if not exists policy_registry_org_active_idx
  on public.policy_registry (org_id) where active;

-- updated_at auto-touch (reuses the shared trigger fn from 0001).
drop trigger if exists policy_registry_set_updated_at on public.policy_registry;
create trigger policy_registry_set_updated_at before update on public.policy_registry
  for each row execute function public.set_updated_at();

-- ── Row-Level Security ───────────────────────────────────────────────────────
alter table public.policy_registry enable row level security;

-- Read: everyone in the org may read the rulebook (agents + UI need the rules).
drop policy if exists policy_registry_select on public.policy_registry;
create policy policy_registry_select on public.policy_registry
  for select using (org_id = public.current_org_id());

-- Write: LEADERSHIP ONLY (ceo/coo). Only leadership edits the governance rules —
-- the same authority that grants AI model tiers and reads the audit log.
drop policy if exists policy_registry_insert on public.policy_registry;
create policy policy_registry_insert on public.policy_registry
  for insert with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  );

drop policy if exists policy_registry_update on public.policy_registry;
create policy policy_registry_update on public.policy_registry
  for update using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  ) with check (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  );

drop policy if exists policy_registry_delete on public.policy_registry;
create policy policy_registry_delete on public.policy_registry
  for delete using (
    org_id = public.current_org_id()
    and public.current_user_role() in ('ceo', 'coo')
  );

-- ── Audit: every policy change lands in the shared action_audit trail ─────────
-- Governance changes ARE consequential, so they are audited at the DB level
-- (independent of app code), reusing the SAME audit table as the action spine.
-- Leadership-only writes are already enforced by RLS above; this records them.
create or replace function public.policy_registry_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
    values (
      new.org_id, null, 'policy.created', auth.uid(),
      coalesce(public.current_user_role()::text, 'system'),
      jsonb_build_object('key', new.key, 'category', new.category,
                         'active', new.active, 'rule', new.rule)
    );
  elsif tg_op = 'UPDATE' then
    if new.rule is distinct from old.rule
       or new.active is distinct from old.active
       or new.description is distinct from old.description
       or new.scope is distinct from old.scope then
      insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
      values (
        new.org_id, null, 'policy.updated', auth.uid(),
        coalesce(public.current_user_role()::text, 'system'),
        jsonb_build_object(
          'key', new.key, 'category', new.category,
          'active', jsonb_build_object('from', old.active, 'to', new.active),
          'rule', jsonb_build_object('from', old.rule, 'to', new.rule),
          'description', jsonb_build_object('from', old.description, 'to', new.description)
        )
      );
    end if;
  elsif tg_op = 'DELETE' then
    insert into public.action_audit (org_id, action_request_id, event, actor_id, actor_role, detail)
    values (
      old.org_id, null, 'policy.deleted', auth.uid(),
      coalesce(public.current_user_role()::text, 'system'),
      jsonb_build_object('key', old.key, 'category', old.category)
    );
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.policy_registry_audit() from public, anon, authenticated;

drop trigger if exists policy_registry_audit_ins on public.policy_registry;
create trigger policy_registry_audit_ins
  after insert on public.policy_registry
  for each row execute function public.policy_registry_audit();

drop trigger if exists policy_registry_audit_upd on public.policy_registry;
create trigger policy_registry_audit_upd
  after update on public.policy_registry
  for each row execute function public.policy_registry_audit();

drop trigger if exists policy_registry_audit_del on public.policy_registry;
create trigger policy_registry_audit_del
  after delete on public.policy_registry
  for each row execute function public.policy_registry_audit();

-- ── Seed: the rules that ALREADY govern the OS, now as editable rows ──────────
-- One set per org. on-conflict do-nothing keeps re-apply safe and never
-- overwrites a threshold leadership has since tuned in the Governance screen.
--
-- The spend threshold is seeded at ₱0 — the strictest reading of "AI actions
-- spend no money without approval" (every peso needs a human approval). This is
-- the safe default that loosens nothing; leadership sets the real ₱ figure in
-- the Governance screen (threshold_php), which changes behaviour with no code
-- change.
insert into public.policy_registry (org_id, key, category, scope, rule, description)
select o.id, v.key, v.category, v.scope, v.rule::jsonb, v.description
from public.organizations o
cross join (values
  (
    'ai_spend_requires_approval',
    'spend',
    'ai_actions',
    '{"statement":"AI actions spend no money without approval","effect":"needs_approval","threshold_php":0,"currency":"PHP"}',
    'AI never moves money on its own. Any spend at or below threshold_php may proceed once approved; above it always needs a human approval. Set the ₱ threshold with leadership.'
  ),
  (
    'consequential_requires_approval',
    'approval',
    'consequential_actions',
    '{"statement":"outbound / consequential actions require human approval","effect":"needs_approval"}',
    'Outbound or otherwise consequential actions are drafted, then a human approves before the OS executes. Nothing auto-executes.'
  ),
  (
    'ai_no_direct_publish',
    'tool_permission',
    'client_content_publish',
    '{"statement":"AI cannot publish client content directly","effect":"deny","applies_to":"ai"}',
    'AI may draft and stage client content but can never publish it directly — a human publishes.'
  ),
  (
    'automation_no_service_role_key',
    'tool_permission',
    'GitHub Actions',
    '{"statement":"GitHub Actions never receives the service-role key","effect":"deny","applies_to":"GitHub Actions"}',
    'GitHub Actions integrates only through authenticated HTTPS endpoints with a shared bearer. It never holds the Supabase service-role key and never touches the DB directly.'
  ),
  (
    'finance_leadership_only',
    'data_access',
    'finance_read',
    '{"statement":"finance data restricted to ceo/coo (Tony read-only)","effect":"deny","allowed_roles":["ceo","coo"]}',
    'Finance/cash data is readable by ceo/coo only. Tony reads finance for leadership but never writes it (money is never an executable action).'
  ),
  (
    'recommendations_carry_confidence',
    'confidence',
    'ai_recommendation',
    '{"statement":"every AI recommendation carries evidence + a confidence score; low confidence escalates","effect":"needs_approval","min_confidence":0.5,"on_low":"escalate"}',
    'Every AI recommendation carries evidence and a 0–1 confidence score. Below min_confidence the recommendation escalates for leadership review rather than proceeding.'
  ),
  (
    'high_risk_leadership_escalation',
    'escalation',
    'high_risk',
    '{"statement":"high-risk decisions require leadership escalation","effect":"needs_approval","risk_tier_threshold":3,"required_role":"coo"}',
    'Decisions at or above risk tier 3 escalate to leadership (ceo/coo) for approval — they can never be decided by a department head alone.'
  )
) as v(key, category, scope, rule, description)
on conflict (org_id, key) do nothing;
