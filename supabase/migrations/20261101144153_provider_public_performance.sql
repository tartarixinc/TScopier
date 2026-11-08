-- Public (anon-readable) performance + trade history for approved providers' shareable /p/{slug} page.
-- Gate: provider approved + listed + not synthetic + social_profiles.share_trade_history = true.
-- Without the share toggle the performance function returns a single row with shared = false and no metrics.

-- Internal helper: verified, de-duplicated source-account trades (same scope as the signed-in history RPC).
create or replace function public.provider_public_source_trades(p_source_id uuid)
returns table (
  trade_id uuid,
  symbol text,
  direction text,
  trade_status text,
  opened_at timestamptz,
  closed_at timestamptz,
  realized_profit numeric
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with source_context as (
    select s.broker_account_id
    from public.social_copy_sources s
    join public.broker_accounts b on b.id = s.broker_account_id and b.user_id = s.trader_user_id
    where s.id = p_source_id and s.status = 'published'
  ), scoped as (
    select distinct on (public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id)) t.*
    from source_context sc
    join public.trades t on t.broker_account_id = sc.broker_account_id
    where ((lower(t.status) = 'open' and t.closed_at is null) or t.closed_at is not null)
      and public.social_trade_ticket_is_verified(t.metaapi_order_id)
      and not exists (
        select 1
        from public.social_copy_subscriptions sub
        join public.social_copy_trade_mappings mapping on mapping.subscription_id = sub.id
        where sub.destination_broker_account_id = t.broker_account_id
          and mapping.destination_ticket is not null
          and mapping.destination_ticket = t.metaapi_order_id
      )
    order by public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id), t.created_at desc, t.id desc
  )
  select s.id, s.symbol, lower(s.direction),
    case when s.closed_at is not null or lower(s.status) = 'closed' then 'closed' else 'open' end,
    s.opened_at, s.closed_at,
    case when s.closed_at is not null or lower(s.status) = 'closed' then s.profit else null end
  from scoped s;
$$;

-- Internal helper: resolve the public, shared source for a slug (null row when not public).
create or replace function public.provider_public_shared_source(p_slug text)
returns table (source_id uuid, trader_user_id uuid, shared boolean, broker_account_id uuid, currency text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select src.id, sp.user_id, sp.share_trade_history, src.broker_account_id, src.snapshot_currency
  from public.social_profiles sp
  join public.user_profiles up on up.user_id = sp.user_id
  left join lateral (
    select s.id, s.broker_account_id, s.snapshot_currency
    from public.social_copy_sources s
    where s.trader_user_id = sp.user_id and s.status = 'published'
    order by s.created_at asc
    limit 1
  ) src on true
  where sp.slug = lower(btrim(p_slug))
    and sp.is_listed = true
    and sp.provider_status = 'approved'
    and sp.is_synthetic_demo = false
    and coalesce(nullif(btrim(up.display_name), ''), nullif(btrim(up.username), '')) is not null
$$;

create or replace function public.get_provider_public_performance(p_slug text)
returns table (
  shared boolean,
  currency text,
  last_synced_at timestamptz,
  history_complete boolean,
  open_count bigint,
  closed_count bigint,
  wins bigint,
  win_rate numeric,
  profit_factor numeric,
  realized_profit numeric,
  gross_profit numeric,
  gross_loss numeric,
  best_profit numeric,
  best_at timestamptz,
  worst_profit numeric,
  worst_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  monthly jsonb
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_src record;
  v_facts record;
  v_synced timestamptz;
  v_best record;
  v_worst record;
  v_monthly jsonb;
begin
  select * into v_src from public.provider_public_shared_source(p_slug);
  if not found then return; end if;

  if not coalesce(v_src.shared, false) or v_src.source_id is null then
    return query select false, v_src.currency, null::timestamptz, null::boolean,
      null::bigint, null::bigint, null::bigint, null::numeric, null::numeric, null::numeric,
      null::numeric, null::numeric, null::numeric, null::timestamptz, null::numeric, null::timestamptz,
      null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  select * into v_facts from public.social_source_trade_facts(v_src.source_id);
  select b.last_synced_at into v_synced from public.broker_accounts b where b.id = v_src.broker_account_id;

  select t.realized_profit as profit, t.closed_at as at into v_best
  from public.provider_public_source_trades(v_src.source_id) t
  where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
  order by t.realized_profit desc, t.closed_at desc limit 1;

  select t.realized_profit as profit, t.closed_at as at into v_worst
  from public.provider_public_source_trades(v_src.source_id) t
  where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
  order by t.realized_profit asc, t.closed_at desc limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'profit', m.profit, 'trades', m.trades) order by m.month), '[]'::jsonb)
  into v_monthly
  from (
    select to_char(date_trunc('month', t.closed_at at time zone 'UTC'), 'YYYY-MM') as month,
      round(sum(t.realized_profit), 2) as profit, count(*) as trades
    from public.provider_public_source_trades(v_src.source_id) t
    where t.trade_status = 'closed' and t.realized_profit is not null and t.closed_at is not null
    group by 1
  ) m;

  return query select true, v_src.currency, v_synced,
    (coalesce(v_facts.incomplete_count, 0) = 0 and v_synced is not null),
    coalesce(v_facts.open_count, 0), coalesce(v_facts.closed_count, 0), coalesce(v_facts.wins, 0),
    case when coalesce(v_facts.verified_closed_count, 0) > 0
      then round((v_facts.wins::numeric / v_facts.verified_closed_count::numeric) * 100, 2) end,
    case when coalesce(v_facts.gross_loss, 0) > 0 then round(v_facts.gross_profit / v_facts.gross_loss, 2) end,
    v_facts.realized_profit, v_facts.gross_profit, v_facts.gross_loss,
    v_best.profit, v_best.at, v_worst.profit, v_worst.at,
    v_facts.period_start, v_facts.period_end, v_monthly;
end;
$$;

create or replace function public.get_provider_public_trade_history(p_slug text, p_limit integer default 100)
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
declare v_src record;
begin
  select * into v_src from public.provider_public_shared_source(p_slug);
  if not found or not coalesce(v_src.shared, false) or v_src.source_id is null then return; end if;
  return query
  select t.trade_id, t.symbol, t.direction, t.trade_status, t.opened_at, t.closed_at, t.realized_profit
  from public.provider_public_source_trades(v_src.source_id) t
  order by coalesce(t.closed_at, t.opened_at) desc, t.trade_id
  limit greatest(1, least(coalesce(p_limit, 100), 250));
end;
$$;

revoke all on function public.provider_public_source_trades(uuid) from public, anon, authenticated;
revoke all on function public.provider_public_shared_source(text) from public, anon, authenticated;
revoke all on function public.get_provider_public_performance(text) from public;
revoke all on function public.get_provider_public_trade_history(text, integer) from public;
grant execute on function public.get_provider_public_performance(text) to anon, authenticated;
grant execute on function public.get_provider_public_trade_history(text, integer) to anon, authenticated;
