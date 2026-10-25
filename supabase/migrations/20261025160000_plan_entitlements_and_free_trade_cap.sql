-- Three tiers: free, pro, desk. Free is the default and needs no record of
-- its own; an account with no live subscription is on it.
--
-- The point of this file is that the limits are real. A limit enforced only
-- in the browser is a suggestion.

create or replace function public.current_plan(uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select s.plan_code
      from public.subscriptions s
      where s.user_id = uid
        and s.status in ('active', 'approved', 'suspended')
      order by
        case s.plan_code when 'desk' then 1 when 'pro' then 2 else 3 end,
        s.created_at desc
      limit 1
    ),
    'free'
  );
$$;

revoke execute on function public.current_plan(uuid) from public, anon;
-- The browser may ask what plan it is on; it cannot change the answer.
grant execute on function public.current_plan(uuid) to authenticated;

-- How many trades a plan may hold. Null means no limit.
create or replace function public.plan_trade_limit(plan text)
returns integer
language sql
immutable
as $$
  select case plan when 'free' then 30 else null end;
$$;

-- Trades are inserted straight from the browser under row-level security, so
-- the cap has to live here.
create or replace function public.enforce_trade_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap integer;
  held integer;
begin
  cap := public.plan_trade_limit(public.current_plan(new.user_id));
  if cap is null then
    return new;
  end if;

  select count(*) into held from public.trades t where t.user_id = new.user_id;

  if held >= cap then
    raise exception 'trade_limit_reached: the free plan holds % trades. Subscribe to add more.', cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_trade_limit() from public, anon, authenticated;

create trigger trades_enforce_plan_limit
  before insert on public.trades
  for each row execute function public.enforce_trade_limit();

-- Starter is replaced by the free plan, so it is no longer offered. The row
-- stays so that anyone already on it keeps a readable record of what they pay.
update public.billing_plans set active = false where plan_code = 'starter';
