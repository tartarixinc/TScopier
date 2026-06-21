-- Promote existing broker_channel_trading_configs rows to active trading config
-- WITHOUT users re-opening Configure Trading or clicking Save.
--
-- Use when the verification query from sync_broker_channel_trading_configs.sql
-- already shows the correct fixed_lot / trade_style per broker + channel.
--
-- What this does:
--   1. (Optional) Copy richer manual_settings FROM broker_accounts.channel_trading_configs
--      JSONB into the table when JSONB has a complete per-channel object.
--   2. Stamp schema_version on every row with valid lot + trade_style (worker/UI gate).
--   3. Push table → broker_accounts.channel_trading_configs (JSONB mirror).
--   4. Refresh broker_accounts.manual_settings legacy fallback per broker.
--   5. Bump broker_accounts.updated_at so the worker reloads broker cache.
--
-- Run in Supabase SQL Editor. Safe to re-run.

begin;

-- ── 1. Optional: JSONB → table when JSONB has a complete per-channel object ─
--    Skip this block if your verification query already shows correct fixed_lot
--    in broker_channel_trading_configs and JSONB is stale/empty.
update public.broker_channel_trading_configs cfg
set
  copier_mode = coalesce(
    nullif(cfg_entry.value ->> 'copier_mode', ''),
    cfg.copier_mode,
    'manual'
  ),
  manual_settings = (cfg_entry.value -> 'manual_settings')
    || jsonb_build_object('schema_version', 1),
  ai_settings = case
    when jsonb_typeof(cfg_entry.value -> 'ai_settings') = 'object'
      then cfg_entry.value -> 'ai_settings'
    else cfg.ai_settings
  end,
  updated_at = now()
from public.broker_accounts ba
cross join lateral jsonb_each(coalesce(ba.channel_trading_configs, '{}'::jsonb)) as cfg_entry(key, value)
where cfg.broker_account_id = ba.id
  and lower(cfg.channel_id::text) = lower(cfg_entry.key)
  and jsonb_typeof(cfg_entry.value -> 'manual_settings') = 'object'
  and coalesce(cfg_entry.value -> 'manual_settings' ->> 'trade_style', '') in ('single', 'multi')
  and coalesce((cfg_entry.value -> 'manual_settings' ->> 'fixed_lot')::numeric, 0) > 0
  and (
    -- JSONB is richer than the table row (migration seed / incomplete row)
    not (cfg.manual_settings ? 'schema_version')
    or coalesce((cfg.manual_settings ->> 'fixed_lot')::numeric, 0) = 0.01
       and coalesce((cfg_entry.value -> 'manual_settings' ->> 'fixed_lot')::numeric, 0) <> 0.01
    or (
      select count(*)
      from jsonb_object_keys(cfg_entry.value -> 'manual_settings') as k(key)
    ) > (
      select count(*)
      from jsonb_object_keys(cfg.manual_settings) as k(key)
    )
  );

-- ── 2. Stamp schema_version on all rows the worker will execute ─────────────
update public.broker_channel_trading_configs cfg
set
  manual_settings = cfg.manual_settings || jsonb_build_object('schema_version', 1),
  updated_at = now()
where coalesce(cfg.manual_settings ->> 'trade_style', '') in ('single', 'multi')
  and coalesce((cfg.manual_settings ->> 'fixed_lot')::numeric, 0) > 0
  and not (cfg.manual_settings ? 'schema_version');

-- ── 3. Table → broker_accounts.channel_trading_configs (JSONB mirror) ───────
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

-- ── 4. Legacy broker_accounts.manual_settings (one row per broker account) ──
--    Prefer the linked channel with the most recently updated table row.
update public.broker_accounts ba
set
  manual_settings = latest.manual_settings,
  updated_at = now()
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
where ba.id = latest.broker_account_id;

-- ── 5. Nudge worker realtime reload (broker_accounts UPDATE subscription) ─────
update public.broker_accounts ba
set updated_at = now()
where ba.is_active = true
  and exists (
    select 1
    from public.broker_channel_trading_configs cfg
    where cfg.broker_account_id = ba.id
  );

commit;

-- ── Verification ────────────────────────────────────────────────────────────
select
  ba.label as broker_label,
  ba.account_login,
  tc.display_name as channel_name,
  cfg.manual_settings ->> 'fixed_lot' as table_fixed_lot,
  cfg.manual_settings ->> 'trade_style' as table_trade_style,
  cfg.manual_settings ? 'schema_version' as has_schema_version,
  ba.channel_trading_configs -> lower(cfg.channel_id::text) -> 'manual_settings' ->> 'fixed_lot'
    as jsonb_fixed_lot,
  ba.manual_settings ->> 'fixed_lot' as broker_fallback_fixed_lot,
  case
    when not (cfg.manual_settings ? 'schema_version') then 'MISSING schema_version'
    when cfg.manual_settings ->> 'fixed_lot'
      is distinct from
         ba.channel_trading_configs -> lower(cfg.channel_id::text) -> 'manual_settings' ->> 'fixed_lot'
      then 'JSONB MISMATCH'
    else 'ACTIVE'
  end as status
from public.broker_channel_trading_configs cfg
inner join public.broker_accounts ba on ba.id = cfg.broker_account_id
inner join public.telegram_channels tc on tc.id = cfg.channel_id
where ba.is_active = true
order by ba.label, tc.display_name;
