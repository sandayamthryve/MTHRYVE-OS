-- Migration 0012: brand category + approval risk tier
alter table public.brands
  add column category text;

create type risk_tier as enum ('LOW', 'MED', 'HIGH', 'CRIT');

alter table public.approval_requests
  add column risk_tier risk_tier not null default 'MED';
