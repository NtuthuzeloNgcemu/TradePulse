-- A trade can only point at a source owned by the same user
alter policy "Users can insert their own trades" on public.trades
  with check (
    (select auth.uid()) = user_id
    and (source_id is null or exists (select 1 from public.sources s where s.id = source_id and s.user_id = (select auth.uid())))
  );

alter policy "Users can update their own trades" on public.trades
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (source_id is null or exists (select 1 from public.sources s where s.id = source_id and s.user_id = (select auth.uid())))
  );

alter table public.trades
  add column if not exists import_notes text,
  add column if not exists updated_at timestamptz;

-- Sources: file metadata, readable status reason, AI extraction record
alter table public.sources
  add column if not exists file_size bigint,
  add column if not exists file_hash text,
  add column if not exists status_detail text,
  add column if not exists extraction jsonb,
  add column if not exists extracted_by text,
  add column if not exists extracted_at timestamptz;

create index if not exists sources_user_hash_idx on public.sources(user_id, file_hash);

-- Only the server (service role) may write AI extraction results
create or replace function public.protect_source_extraction()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    if tg_op = 'INSERT' then
      new.extraction := null;
      new.extracted_by := null;
      new.extracted_at := null;
    else
      new.extraction := old.extraction;
      new.extracted_by := old.extracted_by;
      new.extracted_at := old.extracted_at;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_source_extraction() from public;

create trigger protect_source_extraction
  before insert or update on public.sources
  for each row execute function public.protect_source_extraction();

-- Storage: only the file types the app accepts (the app sets contentType from the extension)
update storage.buckets
set allowed_mime_types = array[
  'text/csv', 'text/plain', 'application/pdf', 'image/png', 'image/jpeg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'
]
where id = 'trading-sources';

-- Playbook: user rules vs AI suggestions, with provenance
alter table public.playbook_rules
  add column if not exists origin text not null default 'user',
  add column if not exists source_id uuid references public.sources(id) on delete set null,
  add column if not exists evidence text,
  add column if not exists updated_at timestamptz;

alter table public.playbook_rules
  add constraint playbook_rules_origin_check check (origin in ('user', 'ai'));

create index if not exists playbook_rules_source_id_idx on public.playbook_rules(source_id);

-- Clients may only create their own confirmed rules. AI suggestions are written by the server.
alter policy "Users can insert their own playbook rules" on public.playbook_rules
  with check ((select auth.uid()) = user_id and origin = 'user' and status = 'confirmed' and source_id is null);

alter policy "Users can update their own playbook rules" on public.playbook_rules
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Provenance can't be rewritten by the client, and a rule can't go back to "suggested"
create or replace function public.protect_rule_provenance()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('service_role', 'postgres', 'supabase_admin') then
    new.origin := old.origin;
    new.source_id := old.source_id;
    new.evidence := old.evidence;
    new.supporting_trade_ids := old.supporting_trade_ids;
    if new.status = 'suggested' and old.status <> 'suggested' then
      raise exception 'A rule cannot be moved back to suggested' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.protect_rule_provenance() from public;

create trigger protect_rule_provenance
  before update on public.playbook_rules
  for each row execute function public.protect_rule_provenance();

-- Insights are written by the server only: the client insert policy now never passes
alter policy "Users can insert their own insights" on public.insights with check (false);
