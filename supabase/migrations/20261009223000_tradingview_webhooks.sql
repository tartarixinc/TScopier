-- TradingView alert webhooks. Each webhook owns a telegram_channels row so the
-- existing broker copy filter (signal_channel_ids / broker_channel_trading_configs)
-- can target it. source_kind keeps the Telegram listener off these rows.

alter table public.telegram_channels
  add column if not exists source_kind text not null default 'telegram';

alter table public.telegram_channels
  drop constraint if exists telegram_channels_source_kind_check;

alter table public.telegram_channels
  add constraint telegram_channels_source_kind_check
  check (source_kind in ('telegram', 'tradingview'));

comment on column public.telegram_channels.source_kind is
  'telegram = listener channel. tradingview = webhook copy target, not a Telegram chat.';

create table if not exists public.tradingview_webhooks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  channel_id uuid not null unique references public.telegram_channels(id) on delete cascade,
  name text not null default 'TradingView',
  token_hash text not null unique,
  token text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tradingview_webhooks is
  'Per-user TradingView alert webhook. Ingest looks up token_hash. token is owner-readable so the URL can be copied.';

comment on column public.tradingview_webhooks.token_hash is
  'SHA-256 hex of the URL secret. The ingest function must not log the raw token.';

create index if not exists tradingview_webhooks_user_idx
  on public.tradingview_webhooks (user_id, created_at desc);

create table if not exists public.tradingview_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  webhook_id uuid not null references public.tradingview_webhooks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id uuid references public.signals(id) on delete set null,
  status text not null,
  skip_reason text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  constraint tradingview_webhook_deliveries_status_check
    check (status in ('accepted', 'skipped', 'error', 'duplicate')),
  constraint tradingview_webhook_deliveries_idempotency_unique
    unique (webhook_id, idempotency_key)
);

create index if not exists tradingview_webhook_deliveries_recent_idx
  on public.tradingview_webhook_deliveries (webhook_id, created_at desc);

alter table public.tradingview_webhooks enable row level security;
alter table public.tradingview_webhook_deliveries enable row level security;

drop policy if exists "Users can view own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can view own tradingview webhooks"
  on public.tradingview_webhooks for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can view own tradingview webhook deliveries"
  on public.tradingview_webhook_deliveries;
create policy "Users can view own tradingview webhook deliveries"
  on public.tradingview_webhook_deliveries for select
  to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.tradingview_webhooks to authenticated;
grant select on public.tradingview_webhook_deliveries to authenticated;

drop policy if exists "Users can insert own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can insert own tradingview webhooks"
  on public.tradingview_webhooks for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can update own tradingview webhooks"
  on public.tradingview_webhooks for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own tradingview webhooks"
  on public.tradingview_webhooks;
create policy "Users can delete own tradingview webhooks"
  on public.tradingview_webhooks for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own tradingview channels"
  on public.telegram_channels;
create policy "Users can insert own tradingview channels"
  on public.telegram_channels for insert
  to authenticated
  with check (auth.uid() = user_id and source_kind = 'tradingview');

-- TradingView copy targets must not consume the Telegram channel allowance.
create or replace function public.enforce_telegram_channel_plan_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  if new.source_kind = 'tradingview' then
    return new;
  end if;
  if tg_op = 'UPDATE' and coalesce(old.is_active, false) and coalesce(new.is_active, false) then
    return new;
  end if;
  if not coalesce(new.is_active, false) then
    return new;
  end if;
  if public.user_is_admin_for_plan_limits(new.user_id) then
    return new;
  end if;

  v_limit := public.user_telegram_channel_limit(new.user_id);
  if v_limit is null then
    return new;
  end if;
  if v_limit <= 0 then
    raise exception 'subscription_required: An active subscription is required to add Telegram channels.'
      using errcode = 'check_violation';
  end if;

  select count(*)::integer into v_count
  from public.telegram_channels tc
  where tc.user_id = new.user_id
    and tc.is_active = true
    and coalesce(tc.source_kind, 'telegram') <> 'tradingview'
    and (tg_op = 'INSERT' or tc.id <> new.id);

  if v_count >= v_limit then
    raise exception 'channel_limit: Basic plan includes % Telegram channels. Upgrade to Advanced for unlimited channels.', v_limit
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
