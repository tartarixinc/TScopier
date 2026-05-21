-- broker_accounts.last_activated_at — wall time when the broker's `is_active`
-- most recently transitioned to TRUE. The trade executor uses this to skip
-- any parsed signal whose `created_at` predates the broker's reactivation, so
-- signals that piled up while a broker was disabled don't fire when the user
-- re-enables it (sweep replay would otherwise execute them within the 5-min
-- replay window).
alter table public.broker_accounts
  add column if not exists last_activated_at timestamptz null;

-- Backfill: any broker that is currently active gets `now()` so post-deploy
-- the executor doesn't start rejecting in-flight signals (no false positives
-- for brokers that have been active continuously).
update public.broker_accounts
  set last_activated_at = coalesce(last_activated_at, now())
  where is_active = true and last_activated_at is null;

-- Trigger: stamp `last_activated_at` whenever `is_active` flips from
-- false/null → true. INSERTs default to now() when the broker is created
-- already active. UPDATEs that don't change is_active leave the column alone.
create or replace function public.broker_accounts_stamp_activated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.is_active = true and new.last_activated_at is null then
      new.last_activated_at := now();
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.is_active = true and coalesce(old.is_active, false) = false then
      new.last_activated_at := now();
    end if;
    return new;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_broker_accounts_stamp_activated_at on public.broker_accounts;
create trigger trg_broker_accounts_stamp_activated_at
  before insert or update on public.broker_accounts
  for each row execute function public.broker_accounts_stamp_activated_at();
