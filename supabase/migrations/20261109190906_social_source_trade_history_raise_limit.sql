-- Allow PnL calendar / profile history to load the full account span (was capped at 250).
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
    select distinct on (public.social_normalize_trade_ticket('fxsocket', t.metaapi_order_id)) t.*
    from public.trades t
    where t.broker_account_id = v_source.broker_account_id
      and (lower(t.status) = 'open' or t.closed_at is not null or lower(t.status) = 'closed')
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
  from scoped s
  where (lower(s.status) = 'open' and s.closed_at is null)
     or (s.closed_at is not null and s.profit is not null)
  order by coalesce(s.closed_at, s.opened_at) desc, s.id
  limit greatest(1, least(coalesce(p_limit, 100), 5000));
end;
$$;

revoke all on function public.get_social_source_trade_history(uuid, integer)
  from public, anon;
grant execute on function public.get_social_source_trade_history(uuid, integer)
  to authenticated;
