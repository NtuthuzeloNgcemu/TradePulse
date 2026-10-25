-- Sources: every file or input a user brings into TradePulse via "+ Add to TradePulse"
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  file_type text,
  storage_path text,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'processed', 'needs_review', 'failed')),
  source_type_detected text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.sources enable row level security;

create policy "Users can view their own sources"
  on public.sources for select
  using (auth.uid() = user_id);

create policy "Users can insert their own sources"
  on public.sources for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own sources"
  on public.sources for update
  using (auth.uid() = user_id);

create policy "Users can delete their own sources"
  on public.sources for delete
  using (auth.uid() = user_id);

create index sources_user_id_idx on public.sources(user_id);
