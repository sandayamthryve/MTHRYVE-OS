-- Mthryve OS — Migration 0007: AI Assistant (conversations + messages)
-- Per-user chat history for the company assistant (AI_AGENTS.md Agent 1).
-- org-scoped + user-scoped RLS: a user sees only their own conversations.
-- Applied to project otepdjhrawtqkzclaxbk on 2026-07-07.

create table ai_conversations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ai_conversations_user_idx on ai_conversations(user_id);

create table ai_messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null references ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);
create index ai_messages_conversation_idx on ai_messages(conversation_id);

create trigger ai_conversations_set_updated_at before update on ai_conversations
  for each row execute function set_updated_at();

alter table ai_conversations enable row level security;
alter table ai_messages enable row level security;

create policy ai_conversations_select on ai_conversations for select
  using (user_id = auth.uid() and org_id = current_org_id());
create policy ai_conversations_insert on ai_conversations for insert
  with check (user_id = auth.uid() and org_id = current_org_id());
create policy ai_conversations_update on ai_conversations for update
  using (user_id = auth.uid());
create policy ai_conversations_delete on ai_conversations for delete
  using (user_id = auth.uid());

create policy ai_messages_select on ai_messages for select
  using (conversation_id in (select id from ai_conversations where user_id = auth.uid()));
create policy ai_messages_insert on ai_messages for insert
  with check (conversation_id in (select id from ai_conversations where user_id = auth.uid()));
