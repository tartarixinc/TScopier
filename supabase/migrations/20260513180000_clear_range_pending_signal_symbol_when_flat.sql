/*
  Widen basket-empty cleanup: when the last trade for a given (signal_id, symbol)
  closes — across all broker_accounts — delete every range_pending_legs row for
  that signal and symbol.

  The previous version only deleted rows matching the closing trade's
  broker_account_id, so a second broker that had inserted virtual pendings but
  never opened positions (or still had only pendings) could leave 10 "orphan"
  ladder rows while the user had already flattened the other account.

  Still gated: if ANY trade remains open or pending for this signal_id + symbol,
  we do not delete (other accounts may still be in the trade).
*/

create or replace function public.cancel_range_pending_legs_when_basket_empty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op <> 'UPDATE' then
    return new;
  end if;

  if new.status is distinct from 'closed' then
    return new;
  end if;

  if old.status = 'closed' then
    return new;
  end if;

  if new.signal_id is null or new.symbol is null then
    return new;
  end if;

  if exists (
    select 1
    from public.trades t
    where t.signal_id = new.signal_id
      and t.symbol = new.symbol
      and t.status in ('open', 'pending')
  ) then
    return new;
  end if;

  delete from public.range_pending_legs r
  where r.signal_id = new.signal_id
    and r.symbol = new.symbol;

  return new;
end;
$$;

comment on function public.cancel_range_pending_legs_when_basket_empty() is
  'AFTER UPDATE on trades: delete all range_pending_legs for (signal_id, symbol) when no open/pending trade remains for that pair on any broker.';
