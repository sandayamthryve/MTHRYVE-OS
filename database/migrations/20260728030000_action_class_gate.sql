-- Mthryve OS — Migration 20260728030000: Action-class approval gate
--
-- PR 10 — the Review Gate. The Final Form's core safety rail is already here:
-- public.action_requests is the ONE queue every consequential agent action lands
-- in, born status='pending', decided by a human, executed only on approval, and
-- audited on every decision. This migration adds the missing rule the queue was
-- gated by AGENT/required_role alone before: gating by CLASS.
--
-- GOVERNING RULE (PR 10 §4): a request's approval floor is decided by WHAT it
-- touches, never by which agent proposed it. Anything touching money, people,
-- deletion, or a client-facing send requires LEADERSHIP (ceo/coo). Everything
-- else may be cleared by a department head. This is enforced three ways so it
-- cannot be bypassed — not by a producer that sets required_role wrong, not by a
-- raw SQL insert, not by a future code path:
--
--   1. tg_action_class_gate() derives action_class + reversible from the request
--      (so the ~30 producers need no edit) and FLOORS required_role up to 'coo'
--      the moment a leadership-class row would rest at 'department_head'.
--   2. A CHECK constraint makes the floor a table invariant: a leadership class
--      with required_role='department_head' is simply not a storable row.
--   3. The existing ar_update RLS policy already forbids a department_head from
--      updating any row whose required_role isn't 'department_head' — so once the
--      class forces 'coo', a non-leadership role provably cannot approve it.
--
-- And so every decision leaves a trail no matter who (or what) performed it,
-- tg_action_decision_audit() writes the action_audit row at the DB on the
-- pending→approved/rejected transition — the guarantee no longer depends on app
-- code remembering to log. The single-step queue's app paths stop writing that
-- row (the trigger owns it); the sequential governance chain (pending_coo →
-- pending_ceo) transitions from non-'pending' states, so it is untouched here and
-- keeps its own audit writes.
--
-- Additive: two nullable columns, two CHECKs, two triggers, one backfill. No
-- existing column, row, or policy is dropped or rewritten.
--
-- Applied to project otepdjhrawtqkzclaxbk.

-- ── 1. Columns ────────────────────────────────────────────────────────────────
-- Nullable + no default so the trigger can tell "producer set it" from "unset";
-- unset rows are classified by the trigger, then never null once written.
alter table public.action_requests
  add column if not exists action_class text,
  add column if not exists reversible   boolean;

comment on column public.action_requests.action_class is
  'What the action touches: money | people | deletion | client_facing | general. '
  'The first four are leadership-only (see the class gate). Derived by '
  'tg_action_class_gate() when a producer leaves it null.';
comment on column public.action_requests.reversible is
  'Whether the executed action can be undone. Deletions and auto-sent client '
  'messages are not; tasks and recommendations are. Shown on the queue card.';

-- Allowed class vocabulary (null is allowed pre-trigger; the trigger fills it).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'action_requests_action_class_check'
  ) then
    alter table public.action_requests
      add constraint action_requests_action_class_check
      check (action_class is null
             or action_class in ('money', 'people', 'deletion', 'client_facing', 'general'));
  end if;
end $$;

-- ── 2. Derivation + floor trigger ─────────────────────────────────────────────
-- BEFORE INSERT/UPDATE: classify the row (when the producer didn't), decide
-- reversibility, then raise required_role to the leadership floor. Runs for every
-- write, so the invariant self-heals rather than depending on callers.
create or replace function public.tg_action_class_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type    text := new.proposed_action ->> 'type';
  v_channel text := new.proposed_action -> 'payload' ->> 'channel';
begin
  -- Classify (only when a producer hasn't stated it explicitly).
  if new.action_class is null then
    if new.source_module = 'governance'
       or v_type = 'hard_delete'
       or v_type ilike '%delete%' then
      new.action_class := 'deletion';
    elsif v_type = 'send_outreach' and v_channel = 'email' then
      -- The OS actually transmits an email to a client/prospect on approval.
      -- Copy-paste channels (Viber/DM) send nothing automatically → 'general'.
      new.action_class := 'client_facing';
    elsif v_type = 'ad_action' or new.source_module = 'ad_ops' then
      -- A real spend change on the ad platform.
      new.action_class := 'money';
    else
      new.action_class := 'general';
    end if;
  end if;

  -- Reversibility (only when unstated): a hard delete and an auto-sent email
  -- can't be taken back; everything else in v1 (tasks, recommendations, logged
  -- touches, ad pause/enable) can. coalesce guards the null proposed_action of a
  -- recommendation-only request (null booleans would leave reversible null).
  if new.reversible is null then
    new.reversible := not coalesce(
      new.action_class = 'deletion'
      or (v_type = 'send_outreach' and v_channel = 'email'),
      false
    );
  end if;

  -- The floor: a leadership class can never rest at department_head. We only ever
  -- RAISE (department_head → coo); an explicit 'coo'/'ceo' is left as chosen.
  if new.action_class in ('money', 'people', 'deletion', 'client_facing')
     and new.required_role = 'department_head' then
    new.required_role := 'coo';
  end if;

  return new;
end;
$$;

-- A trigger function is never called directly — the trigger fires it regardless
-- of EXECUTE grants — so strip it from every client role (no /rest/v1/rpc surface).
revoke execute on function public.tg_action_class_gate() from public, anon, authenticated;

drop trigger if exists trg_ar_class_gate on public.action_requests;
create trigger trg_ar_class_gate
  before insert or update on public.action_requests
  for each row execute function public.tg_action_class_gate();

-- ── 3. Decision-audit trigger ─────────────────────────────────────────────────
-- AFTER UPDATE: the single-step human decision (pending → approved | rejected)
-- always leaves an action_audit row, stamped with the deciding user + role read
-- from the verified session. SECURITY DEFINER so it can write the append-only
-- trail regardless of the caller's RLS. Governance (pending_coo/pending_ceo) is
-- deliberately excluded — it transitions from non-'pending' states and keeps its
-- own richer chain audit.
create or replace function public.tg_action_decision_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_role  text;
begin
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    select u.role::text into v_role from public.users u where u.id = v_actor;
    insert into public.action_audit
      (org_id, action_request_id, event, actor_id, actor_role, detail)
    values (
      new.org_id,
      new.id,
      new.status,                       -- 'approved' | 'rejected'
      v_actor,
      coalesce(v_role, 'system'),
      jsonb_strip_nulls(jsonb_build_object(
        'note',          new.decision_note,
        'action_class',  new.action_class,
        'required_role', new.required_role
      ))
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.tg_action_decision_audit() from public, anon, authenticated;

drop trigger if exists trg_ar_decision_audit on public.action_requests;
create trigger trg_ar_decision_audit
  after update on public.action_requests
  for each row execute function public.tg_action_decision_audit();

-- ── 4. Backfill existing rows ─────────────────────────────────────────────────
-- Classify + set reversibility for the rows already on the queue, and floor any
-- still-pending leadership-class row that a producer had left at department_head.
-- The BEFORE trigger also fires on these updates; setting action_class explicitly
-- makes its derivation a no-op and its floor idempotent.
update public.action_requests
set action_class = case
      when source_module = 'governance'
           or proposed_action ->> 'type' = 'hard_delete'
           or proposed_action ->> 'type' ilike '%delete%' then 'deletion'
      when proposed_action ->> 'type' = 'send_outreach'
           and proposed_action -> 'payload' ->> 'channel' = 'email' then 'client_facing'
      when proposed_action ->> 'type' = 'ad_action'
           or source_module = 'ad_ops' then 'money'
      else 'general'
    end
where action_class is null;

update public.action_requests
set reversible = not coalesce(
      action_class = 'deletion'
      or (proposed_action ->> 'type' = 'send_outreach'
          and proposed_action -> 'payload' ->> 'channel' = 'email'),
      false
    )
where reversible is null;

-- ── 5. The class gate invariant ───────────────────────────────────────────────
-- Added last, after the backfill has floored the live rows, so no historical row
-- trips it as it's created. From here on it is a hard table invariant: a
-- leadership class with required_role='department_head' cannot be stored.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'action_requests_class_gate_check'
  ) then
    alter table public.action_requests
      add constraint action_requests_class_gate_check
      check (
        coalesce(action_class, 'general') not in ('money', 'people', 'deletion', 'client_facing')
        or required_role in ('coo', 'ceo')
      );
  end if;
end $$;
