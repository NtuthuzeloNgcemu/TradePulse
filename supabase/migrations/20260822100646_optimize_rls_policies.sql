-- Wrap auth.uid() as (select auth.uid()) in every policy so Postgres
-- evaluates it once per query (an initplan) instead of once per row.

-- profiles
drop policy "Users can view their own profile" on public.profiles;
drop policy "Users can update their own profile" on public.profiles;

create policy "Users can view their own profile"
  on public.profiles for select
  using ((select auth.uid()) = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using ((select auth.uid()) = id);

-- sources
drop policy "Users can view their own sources" on public.sources;
drop policy "Users can insert their own sources" on public.sources;
drop policy "Users can update their own sources" on public.sources;
drop policy "Users can delete their own sources" on public.sources;

create policy "Users can view their own sources"
  on public.sources for select
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own sources"
  on public.sources for insert
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own sources"
  on public.sources for update
  using ((select auth.uid()) = user_id);

create policy "Users can delete their own sources"
  on public.sources for delete
  using ((select auth.uid()) = user_id);

-- trades
drop policy "Users can view their own trades" on public.trades;
drop policy "Users can insert their own trades" on public.trades;
drop policy "Users can update their own trades" on public.trades;
drop policy "Users can delete their own trades" on public.trades;

create policy "Users can view their own trades"
  on public.trades for select
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own trades"
  on public.trades for insert
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own trades"
  on public.trades for update
  using ((select auth.uid()) = user_id);

create policy "Users can delete their own trades"
  on public.trades for delete
  using ((select auth.uid()) = user_id);

-- insights
drop policy "Users can view their own insights" on public.insights;
drop policy "Users can insert their own insights" on public.insights;
drop policy "Users can delete their own insights" on public.insights;

create policy "Users can view their own insights"
  on public.insights for select
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own insights"
  on public.insights for insert
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own insights"
  on public.insights for delete
  using ((select auth.uid()) = user_id);

-- playbook_rules
drop policy "Users can view their own playbook rules" on public.playbook_rules;
drop policy "Users can insert their own playbook rules" on public.playbook_rules;
drop policy "Users can update their own playbook rules" on public.playbook_rules;
drop policy "Users can delete their own playbook rules" on public.playbook_rules;

create policy "Users can view their own playbook rules"
  on public.playbook_rules for select
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own playbook rules"
  on public.playbook_rules for insert
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own playbook rules"
  on public.playbook_rules for update
  using ((select auth.uid()) = user_id);

create policy "Users can delete their own playbook rules"
  on public.playbook_rules for delete
  using ((select auth.uid()) = user_id);
