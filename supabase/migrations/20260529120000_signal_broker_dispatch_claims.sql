-- One successful entry dispatch per signal + broker (prevents duplicate OrderSend).
create table if not exists public.signal_broker_dispatch_claims (
  id uuid primary key default gen_random_uuid(),
  signal_id uuid not null references public.signals (id) on delete cascade,
  broker_account_id uuid not null references public.broker_accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (signal_id, broker_account_id)
);

create index if not exists signal_broker_dispatch_claims_signal_idx
  on public.signal_broker_dispatch_claims (signal_id);

alter table public.signal_broker_dispatch_claims enable row level security;

-- Backfill channel_trading_configs for linked channels missing a complete per-channel row.
do $$
declare
  rec record;
  channel_id text;
  configs jsonb;
  ids text[];
  first_id text;
  legacy jsonb;
begin
  for rec in
    select id, signal_channel_ids, channel_trading_configs, manual_settings, copier_mode
    from public.broker_accounts
    where signal_channel_ids is not null
      and cardinality(signal_channel_ids) > 0
  loop
    configs := coalesce(rec.channel_trading_configs, '{}'::jsonb);
    ids := array(select unnest(rec.signal_channel_ids)::text);
    first_id := ids[1];
    legacy := coalesce(rec.manual_settings, '{}'::jsonb);

    foreach channel_id in array ids
    loop
      if not (
        configs ? channel_id
        and configs -> channel_id -> 'manual_settings' is not null
        and (configs -> channel_id -> 'manual_settings' ->> 'fixed_lot') is not null
        and (configs -> channel_id -> 'manual_settings' ->> 'trade_style') in ('single', 'multi')
      ) then
        configs := configs || jsonb_build_object(
          channel_id,
          jsonb_build_object(
            'copier_mode', coalesce(rec.copier_mode, 'manual'),
            'manual_settings', case
              when channel_id = first_id and legacy != '{}'::jsonb then legacy
              else jsonb_build_object(
                'fixed_lot', 0.01,
                'trade_style', 'single',
                'risk_mode', 'fixed_lot'
              )
            end,
            'ai_settings', '{}'::jsonb
          )
        );
      end if;
    end loop;

    update public.broker_accounts
    set channel_trading_configs = configs
    where id = rec.id
      and channel_trading_configs is distinct from configs;
  end loop;
end $$;
