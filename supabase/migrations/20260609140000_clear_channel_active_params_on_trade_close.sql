/*
  When a trade closes, clear channel_active_trade_params for that channel+symbol
  once no open/pending trades or active pendings remain (via edge function).

  pg_net is async; the worker also clears synchronously on broker-driven closes.
*/

create or replace function public.clear_channel_active_params_on_trade_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channel_id uuid;
  v_supabase_url text;
  v_service_role_key text;
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.status not in ('closed', 'cancelled') then
    return new;
  end if;

  if old.status in ('closed', 'cancelled') then
    return new;
  end if;

  if new.symbol is null or trim(new.symbol) = '' then
    return new;
  end if;

  v_channel_id := new.telegram_channel_id;
  if v_channel_id is null and new.signal_id is not null then
    select s.channel_id into v_channel_id
    from public.signals s
    where s.id = new.signal_id;
  end if;

  if v_channel_id is null then
    return new;
  end if;

  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_role_key := current_setting('app.settings.service_role_key', true);
  if v_supabase_url is null or v_service_role_key is null then
    return new;
  end if;

  perform net.http_post(
    url := v_supabase_url || '/functions/v1/clear-channel-active-params',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_service_role_key
    ),
    body := jsonb_build_object(
      'user_id', new.user_id,
      'channel_id', v_channel_id,
      'symbol', new.symbol
    ),
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

comment on function public.clear_channel_active_params_on_trade_close() is
  'AFTER UPDATE on trades: invoke clear-channel-active-params edge function when status becomes closed/cancelled.';

drop trigger if exists tr_clear_channel_active_params_on_trade_close on public.trades;

create trigger tr_clear_channel_active_params_on_trade_close
after update of status on public.trades
for each row
when (
  new.status in ('closed', 'cancelled')
  and old.status is distinct from new.status
)
execute function public.clear_channel_active_params_on_trade_close();
