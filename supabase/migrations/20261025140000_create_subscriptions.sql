-- Billing. Everything here is written by the server only: the browser may read
-- its own subscription row and nothing else. A user must never be able to grant
-- themselves a paid plan by writing to this table.

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Which payment provider this row came from. PayPal today; a South African
  -- provider for ZAR is planned, and will add rows with a different value.
  provider text not null default 'paypal' check (provider in ('paypal')),
  -- 'sandbox' rows are tests and must never be treated as a real entitlement.
  environment text not null check (environment in ('sandbox', 'live')),

  -- The provider's own identifiers, kept so support questions can be traced.
  provider_subscription_id text not null,
  provider_plan_id text not null,

  -- Our plan code, not the provider's: 'starter', 'pro' or 'desk'.
  plan_code text not null check (plan_code in ('starter', 'pro', 'desk')),

  -- Mirrors PayPal's own subscription states rather than inventing our own.
  status text not null check (status in (
    'approval_pending', 'approved', 'active', 'suspended', 'cancelled', 'expired'
  )),

  -- What the user is actually being charged, in the currency they agreed to.
  amount numeric,
  currency text,

  current_period_end timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (provider, provider_subscription_id)
);

create index subscriptions_user_id_idx on public.subscriptions (user_id);

alter table public.subscriptions enable row level security;

-- Read-only to the browser. There is deliberately no insert, update or delete
-- policy: without one, RLS denies those to anon and authenticated entirely,
-- and only the service role (which bypasses RLS) can write.
create policy "Users can view their own subscription"
  on public.subscriptions for select
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.subscriptions from anon, authenticated;


-- Every webhook PayPal delivers, recorded before it is acted on. This is what
-- makes replays harmless: PayPal retries on any non-2xx, and the same event id
-- must not be applied twice.
create table public.billing_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paypal',
  event_id text not null,
  event_type text not null,
  -- 'verified' only after PayPal's own signature check passes.
  verification text not null check (verification in ('verified', 'rejected')),
  payload jsonb not null,
  handled boolean not null default false,
  handling_note text,
  received_at timestamptz not null default now(),

  unique (provider, event_id)
);

alter table public.billing_webhook_events enable row level security;
-- No policies at all: this table is server-only in both directions.
revoke all on public.billing_webhook_events from anon, authenticated;


create or replace function public.touch_subscription_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_subscription_updated_at();
