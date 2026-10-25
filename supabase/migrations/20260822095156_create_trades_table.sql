-- Trades: the core journal record. source_id traces every trade back to
-- the upload it came from (or null if entered manually), supporting the
-- "evidence trail" principle from the product direction doc.
create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid references public.sources(id) on delete set null,
  instrument text not null,
  direction text check (direction in ('long', 'short')),
  session text,
  setup text,
  entry_price numeric,
  exit_price numeric,
  entry_time timestamptz,
  exit_time timestamptz,
  result_r numeric,
  rule_score text,
  emotion text,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.trades enable row level security;

create policy "Users can view their own trades"
  on public.trades for select
  using (auth.uid() = user_id);

create policy "Users can insert their own trades"
  on public.trades for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own trades"
  on public.trades for update
  using (auth.uid() = user_id);

create policy "Users can delete their own trades"
  on public.trades for delete
  using (auth.uid() = user_id);

create index trades_user_id_idx on public.trades(user_id);
create index trades_source_id_idx on public.trades(source_id);
