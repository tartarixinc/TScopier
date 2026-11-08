-- Explicitly distinguish preview-only synthetic sources from genuine broker
-- connections. Synthetic history remains visible, but it can never authorize
-- subscription creation or worker execution.

alter table public.social_copy_sources
  add column if not exists is_synthetic boolean not null default false;

comment on column public.social_copy_sources.is_synthetic is
  'True only for clearly labelled synthetic preview sources. Synthetic sources are never copy-eligible.';

create index if not exists social_copy_sources_synthetic_idx
  on public.social_copy_sources (trader_user_id, status)
  where is_synthetic = true;

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
      s.is_synthetic,
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
      when sc.is_synthetic then false
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
      when sc.is_synthetic then 'synthetic_demo'
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
  'Server-side copy eligibility: rejects synthetic sources, then requires a published owned demo MT source, healthy/fresh sync, complete scoped history, >=10 closed trades spanning >=7 days.';

revoke all on function public.social_source_performance_eligibility(uuid)
  from public, anon, authenticated;
grant execute on function public.social_source_performance_eligibility(uuid)
  to service_role;

create or replace function public.pause_synthetic_social_copy_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.is_synthetic then
    update public.social_copy_subscriptions
    set desired_status = 'paused', updated_at = now()
    where source_id = new.id
      and status in ('pending', 'active');
  end if;
  return new;
end;
$$;

revoke all on function public.pause_synthetic_social_copy_subscriptions()
  from public, anon, authenticated;

drop trigger if exists social_copy_sources_pause_synthetic_subscriptions
  on public.social_copy_sources;
create trigger social_copy_sources_pause_synthetic_subscriptions
  after insert or update of is_synthetic on public.social_copy_sources
  for each row execute function public.pause_synthetic_social_copy_subscriptions();

-- Immediately revoke worker authorization for any source marked synthetic,
-- including a source that had a subscription before it was marked.
update public.social_copy_subscriptions subscription
set desired_status = 'paused', updated_at = now()
from public.social_copy_sources source
where source.id = subscription.source_id
  and source.is_synthetic = true
  and subscription.status in ('pending', 'active');
