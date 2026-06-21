-- Reduce legacy breakeven offset defaults (10 / 5) to 3 pips on stored manual settings.

update broker_accounts
set manual_settings = jsonb_set(manual_settings, '{breakeven_offset_pips}', '3'::jsonb)
where manual_settings->>'breakeven_offset_pips' in ('10', '5');

update broker_accounts ba
set channel_trading_configs = sub.updated
from (
  select
    ba2.id,
    coalesce(
      jsonb_object_agg(
        e.key,
        case
          when e.value->'manual_settings'->>'breakeven_offset_pips' in ('10', '5')
            then jsonb_set(e.value, '{manual_settings,breakeven_offset_pips}', '3'::jsonb)
          else e.value
        end
      ),
      '{}'::jsonb
    ) as updated
  from broker_accounts ba2
  cross join lateral jsonb_each(coalesce(ba2.channel_trading_configs, '{}'::jsonb)) e
  group by ba2.id
) sub
where ba.id = sub.id
  and ba.channel_trading_configs is not null
  and ba.channel_trading_configs::text like '%"breakeven_offset_pips"%';
