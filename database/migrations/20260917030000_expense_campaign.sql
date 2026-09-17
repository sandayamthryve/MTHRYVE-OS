-- Expenses gain a campaign dimension.
--
-- The calibration report asks for "cost per brand and per campaign" among the
-- dashboard widgets. Brand was already there; campaign had nowhere to come from
-- — an expense carried brand, department, category and allocation and nothing
-- else — so the widget could not be built without inventing the grouping.
--
-- Additive rather than folded into 20260917010000_expense_management.sql, even
-- though that migration has not been applied here. It is committed, and nothing
-- in this session can see the target database to confirm it has not run
-- somewhere; editing an applied migration silently diverges the schema from its
-- own history. Filename order puts this after the table it alters, so it works
-- whether the base ran an hour ago or runs for the first time tonight.

alter table public.expenses
  add column if not exists campaign_id uuid references campaigns(id) on delete set null;

comment on column public.expenses.campaign_id is
  'Optional campaign this spend belongs to. Nullable: most expenses are not campaign work, and a campaign deleted later leaves its expenses behind rather than taking them.';

-- Partial: most expenses carry no campaign, so indexing the nulls would be
-- mostly dead weight on a column whose whole point is being sparse.
create index if not exists expenses_campaign_idx
  on public.expenses(org_id, campaign_id) where campaign_id is not null;
