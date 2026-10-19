-- Social provider performance foundation.
--
-- Canonical scope: social_copy_sources.broker_account_id -> broker_accounts.id
-- -> trades.broker_account_id.  This deliberately reports only TSCopier-managed
-- trades persisted for the explicitly published source account.  It is not a
-- claim that public.trades is a complete broker ledger.
--
-- Methodology:
-- * realized P/L is the broker-reported value persisted in trades.profit for
--   closed rows. The bridge prefers netProfit when supplied, but commissions,
--   swap and fees are not independently itemised, so no stronger fee claim is
--   made here;
-- * trade count is the number of deduplicated closed broker positions with a
--   complete realized P/L; win rate is profitable closed positions divided by
--   all closed positions (break-even positions remain in the denominator);
-- * profit factor is gross positive P/L / absolute gross negative P/L and is
--   unavailable when there are no losing positions;
-- * return percentage, maximum drawdown and an equity curve remain unavailable.
--   public.trades has neither cash-flow history nor periodic equity snapshots,
--   so deriving those values from current balance would be misleading.
--
-- History rows created by social copying are excluded by destination ticket.
-- The current social-copy worker does not insert them into public.trades, but
-- the exclusion keeps the rule true if destination executions are persisted in
-- that table later. Historical duplicate broker tickets are collapsed because
-- the uniqueness guard only covers rows created since 2026-08-05.

create index if not exists trades_social_performance_scope_idx
  on public.trades (broker_account_id, status, opened_at, id)
  where broker_account_id is not null;

comment on index public.trades_social_performance_scope_idx is
  'Supports source-account-scoped social history and integrity calculations.';

create or replace function public.social_source_performance_eligibility(p_source_id uuid)
returns table (eligible boolean, reason text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with source_context as (
    select
      s.id,
      s.status,
      s.trader_user_id,
      s.broker_account_id,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform,
      b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      lower(coalesce(b.linked_account_type, '')) as account_mode,
      b.last_synced_at
    from public.social_copy_sources s
    join public.broker_accounts b
      on b.id = s.broker_account_id
     and b.user_id = s.trader_user_id
    where s.id = p_source_id
  ), scoped as (
    select distinct on (
      t.broker_account_id,
      coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text)
    )
      t.id,
      t.broker_account_id,
      t.metaapi_order_id,
      t.status,
      t.opened_at,
      t.closed_at,
      t.profit,
      t.created_at
    from public.trades t
    join source_context sc on sc.broker_account_id = t.broker_account_id
    where (lower(t.status) = 'open'
       or t.closed_at is not null
       or lower(t.status) = 'closed')
    and not exists (
      select 1
      from public.social_copy_subscriptions sub
      join public.social_copy_trade_mappings map on map.subscription_id = sub.id
      where sub.destination_broker_account_id = t.broker_account_id
        and map.destination_ticket is not null
        and map.destination_ticket = t.metaapi_order_id
    )
    order by
      t.broker_account_id,
      coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text),
      t.created_at desc,
      t.id desc
  ), facts as (
    select
      count(*) filter (where lower(status) = 'closed' or closed_at is not null) as closed_count,
      count(*) filter (
        where (lower(status) = 'closed' or closed_at is not null)
          and (profit is null or metaapi_order_id is null or btrim(metaapi_order_id) = '')
      ) as incomplete_count,
      min(opened_at) filter (where lower(status) = 'closed' or closed_at is not null) as period_start,
      max(closed_at) filter (where lower(status) = 'closed' or closed_at is not null) as period_end
    from scoped
  )
  select
    case
      when sc.id is null then false
      when sc.status <> 'published' then false
      when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then false
      when sc.account_mode <> 'demo' then false
      when not sc.is_active or sc.connection_status not in ('connected', 'healthy') then false
      when sc.last_synced_at is null then false
      when sc.last_synced_at < now() - interval '15 minutes' then false
      when coalesce(f.incomplete_count, 0) > 0 then false
      when coalesce(f.closed_count, 0) < 10 then false
      when f.period_start is null or f.period_end is null
        or f.period_end - f.period_start < interval '7 days' then false
      else true
    end,
    case
      when sc.id is null then 'source_missing'
      when sc.status <> 'published' then 'source_not_published'
      when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then 'source_unsupported'
      when sc.account_mode = '' then 'account_mode_unknown'
      when sc.account_mode <> 'demo' then 'demo_only'
      when not sc.is_active then 'source_inactive'
      when sc.connection_status = 'error' then 'sync_failed'
      when sc.connection_status not in ('connected', 'healthy') then 'source_disconnected'
      when sc.last_synced_at is null then 'sync_pending'
      when sc.last_synced_at < now() - interval '15 minutes' then 'history_stale'
      when coalesce(f.incomplete_count, 0) > 0 then 'history_incomplete'
      when coalesce(f.closed_count, 0) < 10 then 'minimum_trades_not_met'
      when f.period_start is null or f.period_end is null
        or f.period_end - f.period_start < interval '7 days' then 'minimum_period_not_met'
      else 'eligible'
    end
  from (select 1) seed
  left join source_context sc on true
  left join facts f on true;
$$;

comment on function public.social_source_performance_eligibility(uuid) is
  'Server-side copy eligibility: published owned demo MT source, healthy/fresh sync, complete scoped history, >=10 closed trades spanning >=7 days.';

revoke all on function public.social_source_performance_eligibility(uuid)
  from public, anon, authenticated;
grant execute on function public.social_source_performance_eligibility(uuid)
  to service_role;

-- Re-evaluate eligibility on every worker reconciliation. A source that later
-- becomes stale, incomplete, disconnected, unsupported or unpublished cannot
-- continue opening new copies merely because its subscription predates this
-- migration.
create or replace function public.check_social_copy_subscription_authorization(p_subscription_id uuid)
returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select case when current_user in ('service_role', 'postgres') then exists (
    select 1
    from public.social_copy_subscriptions s
    join public.social_copy_sources src on src.id = s.source_id
    join public.social_profiles sp on sp.user_id = src.trader_user_id
    join public.broker_accounts source_account on source_account.id = src.broker_account_id
    join public.broker_accounts destination_account on destination_account.id = s.destination_broker_account_id
    cross join lateral public.social_source_performance_eligibility(src.id) eligibility
    where s.id = p_subscription_id
      and eligibility.eligible = true
      and src.status = 'published' and sp.is_listed = true
      and source_account.user_id = src.trader_user_id
      and destination_account.user_id = s.subscriber_user_id
      and destination_account.is_active = true
      and lower(coalesce(destination_account.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(destination_account.linked_account_type, '')) in ('demo', 'practice')
      and (
        sp.access_mode = 'open'
        or exists (select 1 from public.social_follow_relationships r
          where r.follower_user_id = s.subscriber_user_id
            and r.followed_user_id = src.trader_user_id
            and r.status = 'accepted')
      )
  ) else false end;
$$;

revoke all on function public.check_social_copy_subscription_authorization(uuid)
  from public, anon, authenticated;
grant execute on function public.check_social_copy_subscription_authorization(uuid)
  to service_role;

create or replace function public.get_social_provider_performance(p_trader_user_id uuid)
returns table (
  source_id uuid,
  source_label text,
  source_status text,
  performance_status text,
  status_reason text,
  account_mode text,
  currency text,
  period_started_at timestamptz,
  period_ended_at timestamptz,
  last_sync_succeeded_at timestamptz,
  calculated_at timestamptz,
  history_complete boolean,
  open_trade_count bigint,
  closed_trade_count bigint,
  realized_profit numeric,
  win_rate numeric,
  profit_factor numeric,
  return_percentage numeric,
  maximum_drawdown numeric,
  equity_curve_available boolean,
  is_copy_eligible boolean,
  eligibility_reason text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.social_profiles%rowtype;
begin
  if v_actor is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select * into v_profile
  from public.social_profiles
  where user_id = p_trader_user_id and is_listed = true;
  if not found then
    raise exception 'Social profile is not available' using errcode = 'P0002';
  end if;

  if v_actor <> p_trader_user_id and not (
    v_profile.share_trade_history
    and (
      v_profile.access_mode = 'open'
      or exists (
        select 1 from public.social_follow_relationships r
        where r.follower_user_id = v_actor
          and r.followed_user_id = p_trader_user_id
          and r.status = 'accepted'
      )
    )
  ) then
    raise exception 'Trader has not shared trade history with this viewer' using errcode = '42501';
  end if;

  return query
  with source_context as (
    select
      s.id,
      coalesce(nullif(btrim(s.label), ''), 'Copy source') as label,
      s.status,
      s.broker_account_id,
      lower(coalesce(nullif(b.provider, ''), 'fxsocket')) as provider,
      upper(coalesce(b.platform, '')) as platform,
      b.is_active,
      lower(coalesce(b.connection_status, '')) as connection_status,
      lower(coalesce(b.linked_account_type, '')) as normalized_account_mode,
      b.last_currency,
      b.last_synced_at
    from public.social_copy_sources s
    left join public.broker_accounts b
      on b.id = s.broker_account_id
     and b.user_id = s.trader_user_id
    where s.trader_user_id = p_trader_user_id
      and (s.status = 'published' or v_actor = p_trader_user_id)
  ), scoped as (
    select distinct on (
      sc.id,
      coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text)
    )
      sc.id as source_id,
      t.id,
      t.metaapi_order_id,
      lower(t.status) as status,
      t.opened_at,
      t.closed_at,
      t.profit,
      t.created_at
    from source_context sc
    join public.trades t on t.broker_account_id = sc.broker_account_id
    where (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
      and not exists (
        select 1
        from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings map on map.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and map.destination_ticket is not null
          and map.destination_ticket = t.metaapi_order_id
      )
    order by sc.id,
      coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text),
      t.created_at desc,
      t.id desc
  ), facts as (
    select
      sc.id as source_id,
      count(s.id) filter (where s.status = 'open' and s.closed_at is null) as open_count,
      count(s.id) filter (where s.status = 'closed' or s.closed_at is not null) as closed_count,
      count(s.id) filter (
        where (s.status = 'closed' or s.closed_at is not null)
          and (s.profit is null or s.metaapi_order_id is null or btrim(s.metaapi_order_id) = '')
      ) as incomplete_count,
      min(s.opened_at) filter (where s.status = 'closed' or s.closed_at is not null) as period_start,
      max(s.closed_at) filter (where s.status = 'closed' or s.closed_at is not null) as period_end,
      sum(s.profit) filter (where s.status = 'closed' or s.closed_at is not null) as pnl,
      count(s.id) filter (
        where (s.status = 'closed' or s.closed_at is not null) and s.profit > 0
      ) as wins,
      sum(s.profit) filter (
        where (s.status = 'closed' or s.closed_at is not null) and s.profit > 0
      ) as gross_profit,
      abs(sum(s.profit) filter (
        where (s.status = 'closed' or s.closed_at is not null) and s.profit < 0
      )) as gross_loss
    from source_context sc
    left join scoped s on s.source_id = sc.id
    group by sc.id
  ), evaluated as (
    select sc.*, f.*,
      case
        when sc.broker_account_id is null then 'unavailable'
        when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then 'unavailable'
        when sc.connection_status = 'error' then 'failed'
        when sc.last_synced_at is null then 'pending'
        when not sc.is_active or sc.connection_status not in ('connected', 'healthy') then 'unavailable'
        when sc.last_synced_at < now() - interval '15 minutes' then 'stale'
        when coalesce(f.incomplete_count, 0) > 0 then 'incomplete'
        when coalesce(f.open_count, 0) + coalesce(f.closed_count, 0) = 0 then 'no_history'
        else 'available'
      end as performance_state,
      case
        when sc.broker_account_id is null then 'source_account_missing'
        when sc.provider not in ('fxsocket', 'mtapi') or sc.platform not in ('MT4', 'MT5') then 'source_unsupported'
        when sc.connection_status = 'error' then 'sync_failed'
        when sc.last_synced_at is null then 'sync_pending'
        when not sc.is_active then 'source_inactive'
        when sc.connection_status not in ('connected', 'healthy') then 'source_disconnected'
        when sc.last_synced_at < now() - interval '15 minutes' then 'history_stale'
        when coalesce(f.incomplete_count, 0) > 0 then 'history_incomplete'
        when coalesce(f.open_count, 0) + coalesce(f.closed_count, 0) = 0 then 'no_history'
        else 'current'
      end as performance_reason
    from source_context sc
    join facts f on f.source_id = sc.id
  )
  select
    e.id,
    e.label,
    e.status,
    e.performance_state,
    e.performance_reason,
    case when e.normalized_account_mode in ('demo', 'practice') then 'demo'
         when e.normalized_account_mode = '' then 'unknown' else 'live' end,
    nullif(btrim(e.last_currency), ''),
    e.period_start,
    e.period_end,
    e.last_synced_at,
    statement_timestamp(),
    e.performance_state in ('available', 'stale'),
    e.open_count,
    e.closed_count,
    case when e.performance_state in ('available', 'stale') then coalesce(e.pnl, 0) else null end,
    case when e.performance_state in ('available', 'stale') and e.closed_count > 0
      then round((e.wins::numeric / e.closed_count::numeric) * 100, 2) else null end,
    case when e.performance_state in ('available', 'stale') and coalesce(e.gross_loss, 0) > 0
      then round(coalesce(e.gross_profit, 0) / e.gross_loss, 4) else null end,
    null::numeric,
    null::numeric,
    false,
    eligibility.eligible,
    eligibility.reason
  from evaluated e
  cross join lateral public.social_source_performance_eligibility(e.id) eligibility
  order by (e.status = 'published') desc, e.label, e.id;
end;
$$;

revoke all on function public.get_social_provider_performance(uuid)
  from public, anon;
grant execute on function public.get_social_provider_performance(uuid)
  to authenticated;

create or replace function public.get_social_source_trade_history(
  p_source_id uuid,
  p_limit integer default 100
)
returns table (
  trade_id uuid,
  symbol text,
  direction text,
  trade_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  realized_profit numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_source public.social_copy_sources%rowtype;
  v_access record;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  select * into v_source from public.social_copy_sources where id = p_source_id;
  if not found then raise exception 'Published source is not available' using errcode = 'P0002'; end if;

  select * into v_access
  from public.get_social_trade_history_access(v_source.trader_user_id);
  if not coalesce(v_access.can_view, false) then
    raise exception 'Trader has not shared trade history with this viewer' using errcode = '42501';
  end if;
  if v_actor <> v_source.trader_user_id and v_source.status <> 'published' then
    raise exception 'Published source is not available' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.broker_accounts b
    where b.id = v_source.broker_account_id and b.user_id = v_source.trader_user_id
  ) then
    raise exception 'Source account is unavailable' using errcode = 'P0002';
  end if;

  return query
  with scoped as (
    select distinct on (coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text))
      t.*
    from public.trades t
    where t.broker_account_id = v_source.broker_account_id
      and (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
      and not exists (
        select 1
        from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings map on map.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and map.destination_ticket is not null
          and map.destination_ticket = t.metaapi_order_id
      )
    order by coalesce(nullif(t.metaapi_order_id, ''), 'row:' || t.id::text), t.created_at desc, t.id desc
  )
  select s.id, s.symbol, lower(s.direction),
    case when s.closed_at is not null or lower(s.status) = 'closed' then 'closed' else 'open' end,
    s.opened_at, s.closed_at,
    case when s.closed_at is not null or lower(s.status) = 'closed' then s.profit else null end
  from scoped s
  order by coalesce(s.closed_at, s.opened_at) desc, s.id
  limit greatest(1, least(coalesce(p_limit, 100), 250));
end;
$$;

revoke all on function public.get_social_source_trade_history(uuid, integer)
  from public, anon;
grant execute on function public.get_social_source_trade_history(uuid, integer)
  to authenticated;

-- Backward compatibility for clients that have not learned source selection.
-- A single published source is safe; zero sources returns no history; multiple
-- sources fail explicitly instead of silently mixing or choosing an account.
create or replace function public.get_social_trade_history(p_trader_user_id uuid, p_limit integer default 100)
returns table (
  trade_id uuid,
  symbol text,
  direction text,
  trade_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  realized_profit numeric
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_source_id uuid;
  v_source_count integer;
begin
  select count(*)::integer
    into v_source_count
  from public.social_copy_sources s
  where s.trader_user_id = p_trader_user_id and s.status = 'published';

  if v_source_count = 0 then return; end if;
  if v_source_count > 1 then
    raise exception 'Select a published source account' using errcode = '22023';
  end if;
  select s.id into v_source_id
  from public.social_copy_sources s
  where s.trader_user_id = p_trader_user_id and s.status = 'published';

  return query select * from public.get_social_source_trade_history(v_source_id, p_limit);
end;
$$;

revoke all on function public.get_social_trade_history(uuid, integer)
  from public, anon;
grant execute on function public.get_social_trade_history(uuid, integer)
  to authenticated;

-- Copy eligibility is enforced at the mutation boundary. Publication remains
-- possible while synchronization/history is pending, but copying cannot start.
create or replace function public.create_social_copy_subscription(
  p_source_id uuid,
  p_destination_broker_account_id uuid,
  p_sizing_mode text,
  p_fixed_lot numeric,
  p_lot_multiplier numeric,
  p_max_lot numeric,
  p_max_daily_loss numeric default null,
  p_requested_account_mode text default 'demo',
  p_symbol_map jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_actor uuid := auth.uid();
  v_source public.social_copy_sources%rowtype;
  v_access text;
  v_id uuid;
  v_eligible boolean;
  v_eligibility_reason text;
begin
  if v_actor is null then raise exception 'Not authenticated' using errcode = '42501'; end if;
  if not public.social_follow_profile_is_eligible(v_actor) then
    raise exception 'Join the social directory before copying a trader' using errcode = '55000';
  end if;
  select s.* into v_source
  from public.social_copy_sources s join public.social_profiles sp on sp.user_id = s.trader_user_id
  where s.id = p_source_id and s.status = 'published' and sp.is_listed = true;
  if not found then raise exception 'Social copy source is unavailable' using errcode = 'P0002'; end if;
  select sp.access_mode into v_access from public.social_profiles sp where sp.user_id = v_source.trader_user_id;
  if v_source.trader_user_id = v_actor then raise exception 'Users cannot copy themselves' using errcode = '23514'; end if;
  if v_access = 'private' and not exists (
    select 1 from public.social_follow_relationships r
    where r.follower_user_id = v_actor and r.followed_user_id = v_source.trader_user_id and r.status = 'accepted'
  ) then raise exception 'An accepted follow is required for this private trader' using errcode = '42501'; end if;
  if not exists (select 1 from public.broker_accounts b
    where b.id = p_destination_broker_account_id and b.user_id = v_actor) then
    raise exception 'Destination broker account is not owned by the current user' using errcode = '42501';
  end if;
  if not exists (select 1 from public.broker_accounts b
    where b.id = p_destination_broker_account_id
      and b.user_id = v_actor
      and b.is_active = true
      and lower(coalesce(b.connection_status, '')) in ('connected', 'healthy')
      and lower(coalesce(b.linked_account_type, '')) in ('demo', 'practice')) then
    raise exception 'Destination account must be a connected demo account' using errcode = '55000';
  end if;
  if p_sizing_mode not in ('fixed_lot', 'lot_multiplier', 'equity_ratio')
    or p_requested_account_mode not in ('demo', 'live') or coalesce(p_lot_multiplier, 0) <= 0
    or coalesce(p_max_lot, 0) <= 0 or (p_sizing_mode = 'fixed_lot' and coalesce(p_fixed_lot, 0) <= 0)
    or jsonb_typeof(coalesce(p_symbol_map, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid social copy risk settings' using errcode = '22023';
  end if;

  select e.eligible, e.reason into v_eligible, v_eligibility_reason
  from public.social_source_performance_eligibility(p_source_id) e;
  if not coalesce(v_eligible, false) then
    raise exception 'Provider is not eligible for copying: %', coalesce(v_eligibility_reason, 'unknown')
      using errcode = '55000';
  end if;
  if p_requested_account_mode <> 'demo' then
    raise exception 'Social copy eligibility is demo-only' using errcode = '55000';
  end if;

  insert into public.social_copy_subscriptions (
    source_id, source_trader_user_id, subscriber_user_id, destination_broker_account_id,
    sizing_mode, fixed_lot, lot_multiplier, max_lot, max_daily_loss,
    requested_account_mode, symbol_map
  ) values (
    p_source_id, v_source.trader_user_id, v_actor, p_destination_broker_account_id,
    p_sizing_mode, case when p_sizing_mode = 'fixed_lot' then p_fixed_lot else null end,
    p_lot_multiplier, p_max_lot, p_max_daily_loss, p_requested_account_mode, coalesce(p_symbol_map, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'A current subscription already exists for this source and destination' using errcode = '23505';
end;
$$;

revoke all on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb)
  from public, anon;
grant execute on function public.create_social_copy_subscription(uuid, uuid, text, numeric, numeric, numeric, numeric, text, jsonb)
  to authenticated;

-- Extend source discovery without exposing broker_account_id or credentials.
drop function public.get_social_copy_sources(uuid);
create function public.get_social_copy_sources(p_trader_user_id uuid)
returns table (
  source_id uuid,
  trader_user_id uuid,
  label text,
  provider text,
  platform text,
  account_mode text,
  connection_healthy boolean,
  is_copy_eligible boolean,
  eligibility_reason text
)
language sql stable security definer set search_path = pg_catalog, public as $$
  select s.id, s.trader_user_id, coalesce(s.label, 'Copy source'),
    coalesce(b.provider, 'fxsocket'), b.platform,
    case when lower(coalesce(b.linked_account_type, '')) in ('demo', 'practice') then 'demo'
         when coalesce(b.linked_account_type, '') = '' then 'unknown' else 'live' end,
    (b.is_active = true and b.connection_status in ('connected', 'healthy')),
    eligibility.eligible,
    eligibility.reason
  from public.social_copy_sources s
  join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
  join public.social_profiles sp on sp.user_id = s.trader_user_id and sp.is_listed = true
  cross join lateral public.social_source_performance_eligibility(s.id) eligibility
  where s.trader_user_id = p_trader_user_id and s.status = 'published'
    and (
      sp.access_mode = 'open'
      or s.trader_user_id = auth.uid()
      or exists (select 1 from public.social_follow_relationships r
        where r.follower_user_id = auth.uid() and r.followed_user_id = s.trader_user_id and r.status = 'accepted')
    );
$$;

revoke all on function public.get_social_copy_sources(uuid) from public, anon;
grant execute on function public.get_social_copy_sources(uuid) to authenticated;
