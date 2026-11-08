-- Account deposit / withdrawal totals, written only by server code (edge function, service role),
-- read by the account owner and (when the provider shares trade history) by the public profile.

alter table public.broker_accounts
  add column if not exists total_deposits numeric,
  add column if not exists total_withdrawals numeric,
  add column if not exists cashflow_synced_at timestamptz;

-- Clients may update their own broker row, so keep these server-derived columns tamper-proof.
create or replace function public.broker_accounts_protect_cashflow_totals()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.total_deposits := null;
      new.total_withdrawals := null;
      new.cashflow_synced_at := null;
    else
      new.total_deposits := old.total_deposits;
      new.total_withdrawals := old.total_withdrawals;
      new.cashflow_synced_at := old.cashflow_synced_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists broker_accounts_protect_cashflow_totals on public.broker_accounts;
create trigger broker_accounts_protect_cashflow_totals
  before insert or update on public.broker_accounts
  for each row execute function public.broker_accounts_protect_cashflow_totals();

grant select (total_deposits, total_withdrawals, cashflow_synced_at) on public.broker_accounts to authenticated;

-- Public performance now also exposes deposits (broker history total, else the saved starting balance).
drop function if exists public.get_provider_public_performance(text);
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
  monthly jsonb,
  deposits numeric,
  withdrawals numeric,
  deposit_source text,
  cashflow_synced_at timestamptz
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
  v_cash record;
begin
  select * into v_src from public.provider_public_shared_source(p_slug);
  if not found then return; end if;

  if not coalesce(v_src.shared, false) or v_src.source_id is null then
    return query select false, v_src.currency, null::timestamptz, null::boolean,
      null::bigint, null::bigint, null::bigint, null::numeric, null::numeric, null::numeric,
      null::numeric, null::numeric, null::numeric, null::timestamptz, null::numeric, null::timestamptz,
      null::timestamptz, null::timestamptz, null::jsonb,
      null::numeric, null::numeric, null::text, null::timestamptz;
    return;
  end if;

  select * into v_facts from public.social_source_trade_facts(v_src.source_id);
  select b.total_deposits, b.total_withdrawals, b.cashflow_synced_at, b.performance_baseline_balance
  into v_cash from public.broker_accounts b where b.id = v_src.broker_account_id;
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
    v_facts.period_start, v_facts.period_end, v_monthly,
    coalesce(v_cash.total_deposits, v_cash.performance_baseline_balance),
    v_cash.total_withdrawals,
    case when v_cash.total_deposits is not null then 'broker_history'
         when v_cash.performance_baseline_balance is not null then 'starting_balance' end,
    v_cash.cashflow_synced_at;
end;
$$;


revoke all on function public.get_provider_public_performance(text) from public;
grant execute on function public.get_provider_public_performance(text) to anon, authenticated;
