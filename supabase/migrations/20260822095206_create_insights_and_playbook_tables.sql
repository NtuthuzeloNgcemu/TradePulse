-- Insights: AI-generated observations. Every insight must trace back to the
-- specific trades that support it - no insight should exist without evidence.
create table public.insights (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  headline text not null,
  evidence_summary text,
  confidence text,
  supporting_trade_ids uuid[],
  created_at timestamptz not null default now()
);

alter table public.insights enable row level security;

create policy "Users can view their own insights"
  on public.insights for select
  using (auth.uid() = user_id);

create policy "Users can insert their own insights"
  on public.insights for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own insights"
  on public.insights for delete
  using (auth.uid() = user_id);

create index insights_user_id_idx on public.insights(user_id);

-- Playbook rules: confirmed rules the trader has set, plus system-suggested
-- rules awaiting confirmation. Suggested rules carry supporting_trade_ids
-- so the trader can see exactly why a rule was proposed.
create table public.playbook_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_text text not null,
  status text not null default 'confirmed'
    check (status in ('confirmed', 'suggested')),
  supporting_trade_ids uuid[],
  created_at timestamptz not null default now()
);

alter table public.playbook_rules enable row level security;

create policy "Users can view their own playbook rules"
  on public.playbook_rules for select
  using (auth.uid() = user_id);

create policy "Users can insert their own playbook rules"
  on public.playbook_rules for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own playbook rules"
  on public.playbook_rules for update
  using (auth.uid() = user_id);

create policy "Users can delete their own playbook rules"
  on public.playbook_rules for delete
  using (auth.uid() = user_id);

create index playbook_rules_user_id_idx on public.playbook_rules(user_id);
