-- Sync broker channel trading configuration across storage layers.
--
-- Storage layers:
--   1. broker_channel_trading_configs  (authoritative — one row per broker + channel)
--   2. broker_accounts.channel_trading_configs (JSONB mirror for worker / legacy readers)
--   3. broker_accounts.manual_settings (legacy broker-level fallback)
--
-- Default direction: table (1) → JSONB (2) + legacy manual_settings (3).
-- Safe to re-run. Does NOT overwrite existing table rows from stale JSONB.
--
-- Run in Supabase SQL Editor. Review the verification query at the bottom.

begin;

-- ── 1. Backfill missing table rows from JSONB (insert only) ─────────────────
insert into public.broker_channel_trading_configs (
  user_id,
  broker_account_id,
  channel_id,
  copier_mode,
  manual_settings,
  ai_settings
)
select
  ba.user_id,
  ba.id,
  tc.id,
  coalesce(nullif(cfg.value ->> 'copier_mode', ''), ba.copier_mode, 'manual'),
  coalesce(
    case
      when jsonb_typeof(cfg.value -> 'manual_settings') = 'object'
        then cfg.value -> 'manual_settings'
      else null
    end,
    ba.manual_settings,
    '{}'::jsonb
  ),
  coalesce(
    case
      when jsonb_typeof(cfg.value -> 'ai_settings') = 'object'
        then cfg.value -> 'ai_settings'
      else null
    end,
    ba.ai_settings,
    '{}'::jsonb
  )
from public.broker_accounts ba
cross join jsonb_each(coalesce(ba.channel_trading_configs, '{}'::jsonb)) as cfg(key, value)
inner join public.telegram_channels tc
  on lower(tc.id::text) = lower(cfg.key)
 and tc.user_id = ba.user_id
on conflict (broker_account_id, channel_id) do nothing;

-- ── 2. Backfill missing table rows for linked channels (whitelist) ────────────
insert into public.broker_channel_trading_configs (
  user_id,
  broker_account_id,
  channel_id,
  copier_mode,
  manual_settings,
  ai_settings
)
select
  ba.user_id,
  ba.id,
  tc.id,
  coalesce(ba.copier_mode, 'manual'),
  coalesce(ba.manual_settings, '{}'::jsonb),
  coalesce(ba.ai_settings, '{}'::jsonb)
from public.broker_accounts ba
cross join unnest(coalesce(ba.signal_channel_ids, '{}'::uuid[])) as linked(channel_id)
inner join public.telegram_channels tc
  on tc.id = linked.channel_id
 and tc.user_id = ba.user_id
where not exists (
  select 1
  from public.broker_channel_trading_configs existing
  where existing.broker_account_id = ba.id
    and existing.channel_id = tc.id
)
on conflict (broker_account_id, channel_id) do nothing;

-- ── 3. Stamp schema_version on complete-looking manual_settings ─────────────
--    Prevents worker/UI from treating real configs as migration seeds (0.01 lot).
update public.broker_channel_trading_configs cfg
set manual_settings = cfg.manual_settings || jsonb_build_object('schema_version', 1)
where not (cfg.manual_settings ? 'schema_version')
  and coalesce(cfg.manual_settings ->> 'trade_style', '') in ('single', 'multi')
  and coalesce((cfg.manual_settings ->> 'fixed_lot')::numeric, 0) > 0
  and (
    coalesce((cfg.manual_settings ->> 'fixed_lot')::numeric, 0) <> 0.01
    or (
      select count(*)
      from jsonb_object_keys(cfg.manual_settings) as k(key)
    ) > 4
  );

-- ── 4. Push authoritative table → broker_accounts.channel_trading_configs ───
do $$
declare
  rec record;
begin
  for rec in
    select distinct broker_account_id
    from public.broker_channel_trading_configs
  loop
    perform public.sync_broker_channel_trading_configs_jsonb(rec.broker_account_id);
  end loop;
end;
$$;

-- ── 5. Mirror latest per-channel manual_settings → broker_accounts.manual_settings
--    Uses the most recently updated linked channel row per broker.
update public.broker_accounts ba
set manual_settings = latest.manual_settings
from (
  select distinct on (cfg.broker_account_id)
    cfg.broker_account_id,
    cfg.manual_settings
  from public.broker_channel_trading_configs cfg
  inner join public.broker_accounts b
    on b.id = cfg.broker_account_id
  where cfg.channel_id = any(coalesce(b.signal_channel_ids, '{}'::uuid[]))
     or cardinality(coalesce(b.signal_channel_ids, '{}'::uuid[])) = 0
  order by cfg.broker_account_id, cfg.updated_at desc, cfg.channel_id
) as latest
where ba.id = latest.broker_account_id
  and ba.manual_settings is distinct from latest.manual_settings;

commit;

-- ── Verification: fixed lot per broker + channel ───────────────────────────
select
  ba.label as broker_label,
  ba.account_login,
  tc.display_name as channel_name,
  cfg.copier_mode,
  cfg.manual_settings ->> 'fixed_lot' as fixed_lot,
  cfg.manual_settings ->> 'trade_style' as trade_style,
  cfg.manual_settings ->> 'schema_version' as schema_version,
  cfg.updated_at as table_updated_at,
  ba.channel_trading_configs -> lower(cfg.channel_id::text) -> 'manual_settings' ->> 'fixed_lot'
    as jsonb_mirror_fixed_lot,
  case
    when cfg.manual_settings ->> 'fixed_lot'
      is distinct from
         ba.channel_trading_configs -> lower(cfg.channel_id::text) -> 'manual_settings' ->> 'fixed_lot'
      then 'MISMATCH'
    else 'ok'
  end as jsonb_sync_status
from public.broker_channel_trading_configs cfg
inner join public.broker_accounts ba
  on ba.id = cfg.broker_account_id
inner join public.telegram_channels tc
  on tc.id = cfg.channel_id
order by ba.label, tc.display_name;
