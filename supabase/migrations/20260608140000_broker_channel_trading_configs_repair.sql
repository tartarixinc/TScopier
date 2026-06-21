-- Idempotent repair when 20260608120000 was partially applied (policies/triggers already exist).

grant select, insert, update, delete on public.broker_channel_trading_configs to authenticated;

alter table public.broker_channel_trading_configs enable row level security;

drop policy if exists "Users can view own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can view own broker channel trading configs"
  on public.broker_channel_trading_configs for select
  to authenticated
  using (
    exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

drop policy if exists "Users can insert own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can insert own broker channel trading configs"
  on public.broker_channel_trading_configs for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

drop policy if exists "Users can update own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can update own broker channel trading configs"
  on public.broker_channel_trading_configs for update
  to authenticated
  using (
    exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

drop policy if exists "Users can delete own broker channel trading configs"
  on public.broker_channel_trading_configs;
create policy "Users can delete own broker channel trading configs"
  on public.broker_channel_trading_configs for delete
  to authenticated
  using (
    exists (
      select 1
      from public.broker_accounts ba
      where ba.id = broker_account_id
        and ba.user_id = auth.uid()
    )
  );

create or replace function public.trg_sync_broker_channel_trading_configs_jsonb()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bid uuid;
begin
  bid := coalesce(new.broker_account_id, old.broker_account_id);
  perform public.sync_broker_channel_trading_configs_jsonb(bid);
  return coalesce(new, old);
end;
$$;

create or replace function public.sync_broker_channel_trading_configs_jsonb(p_broker_account_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.broker_accounts ba
  set channel_trading_configs = coalesce(
    (
      select jsonb_object_agg(
        lower(cfg.channel_id::text),
        jsonb_build_object(
          'copier_mode', cfg.copier_mode,
          'manual_settings', cfg.manual_settings,
          'ai_settings', cfg.ai_settings
        )
      )
      from public.broker_channel_trading_configs cfg
      where cfg.broker_account_id = p_broker_account_id
    ),
    '{}'::jsonb
  )
  where ba.id = p_broker_account_id;
end;
$$;

drop trigger if exists broker_channel_trading_configs_sync_jsonb on public.broker_channel_trading_configs;
create trigger broker_channel_trading_configs_sync_jsonb
  after insert or update or delete on public.broker_channel_trading_configs
  for each row
  execute function public.trg_sync_broker_channel_trading_configs_jsonb();
