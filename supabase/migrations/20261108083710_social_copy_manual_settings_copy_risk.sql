-- Preserve Mirror-parity copy_risk + symbol_mapping on social subscription manual_settings
-- while still normalizing the social Symbols/Filters subset.

create or replace function public.normalize_social_copy_manual_settings(p_settings jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v jsonb := coalesce(p_settings, '{}'::jsonb);
  v_exclude jsonb := '[]'::jsonb;
  v_days jsonb := '[]'::jsonb;
  v_impacts jsonb := '[]'::jsonb;
  v_item text;
  v_day integer;
  v_impact text;
  v_out jsonb;
  v_copy_risk jsonb;
  v_symbol_mapping jsonb;
begin
  if jsonb_typeof(v) <> 'object' then
    raise exception 'manual_settings must be a JSON object' using errcode = '22023';
  end if;

  if v ? 'symbols_exclude' and jsonb_typeof(v->'symbols_exclude') = 'array' then
    for v_item in
      select upper(trim(value))
      from jsonb_array_elements_text(v->'symbols_exclude') as t(value)
    loop
      if v_item <> '' then
        v_exclude := v_exclude || to_jsonb(v_item);
      end if;
    end loop;
  end if;

  if v ? 'trade_days' and jsonb_typeof(v->'trade_days') = 'array' then
    for v_day in
      select (value)::integer
      from jsonb_array_elements_text(v->'trade_days') as t(value)
      where value ~ '^[0-6]$'
    loop
      v_days := v_days || to_jsonb(v_day);
    end loop;
  end if;

  if v ? 'news_avoid_impacts' and jsonb_typeof(v->'news_avoid_impacts') = 'array' then
    for v_impact in
      select value
      from jsonb_array_elements_text(v->'news_avoid_impacts') as t(value)
      where value in ('high', 'medium', 'low')
    loop
      v_impacts := v_impacts || to_jsonb(v_impact);
    end loop;
  end if;

  v_out := jsonb_build_object(
    'symbol_to_trade', case
      when nullif(trim(coalesce(v->>'symbol_to_trade', '')), '') is null then null
      else trim(v->>'symbol_to_trade')
    end,
    'symbols_exclude', coalesce(v_exclude, '[]'::jsonb),
    'time_filter_enabled', coalesce((v->>'time_filter_enabled')::boolean, false),
    'trade_start_time', coalesce(nullif(trim(coalesce(v->>'trade_start_time', '')), ''), '00:00'),
    'trade_end_time', coalesce(nullif(trim(coalesce(v->>'trade_end_time', '')), ''), '23:59'),
    'days_filter_enabled', coalesce((v->>'days_filter_enabled')::boolean, false),
    'trade_days', case when jsonb_array_length(v_days) > 0 then v_days else '[1,2,3,4,5]'::jsonb end,
    'news_trading_enabled', coalesce((v->>'news_trading_enabled')::boolean, true),
    'allow_high_impact_news', coalesce((v->>'news_trading_enabled')::boolean, true),
    'news_avoid_impacts', case when jsonb_array_length(v_impacts) > 0 then v_impacts else '["high"]'::jsonb end,
    'close_before_news_minutes', greatest(0, least(24 * 60, coalesce((v->>'close_before_news_minutes')::integer, 30))),
    'resume_after_news_minutes', greatest(0, least(24 * 60, coalesce((v->>'resume_after_news_minutes')::integer, 15)))
  );

  -- Mirror trading parity: keep the full copy-risk profile when present.
  if v ? 'copy_risk' and jsonb_typeof(v->'copy_risk') = 'object' then
    v_copy_risk := v->'copy_risk';
    v_out := v_out || jsonb_build_object('copy_risk', v_copy_risk);
  end if;

  if v ? 'symbol_mapping' and jsonb_typeof(v->'symbol_mapping') = 'object' then
    v_symbol_mapping := v->'symbol_mapping';
    v_out := v_out || jsonb_build_object('symbol_mapping', v_symbol_mapping);
  end if;

  -- Legacy top-level mirrors written by manualSettingsFromCopyRisk.
  if v ? 'risk_mode' then
    v_out := v_out || jsonb_build_object('risk_mode', v->'risk_mode');
  end if;
  if v ? 'fixed_lot' then
    v_out := v_out || jsonb_build_object('fixed_lot', v->'fixed_lot');
  end if;
  if v ? 'dynamic_balance_percent' then
    v_out := v_out || jsonb_build_object('dynamic_balance_percent', v->'dynamic_balance_percent');
  end if;

  return v_out;
end;
$$;

comment on column public.social_copy_subscriptions.manual_settings is
  'Subscriber copy settings: Symbols/Filters subset plus optional Mirror-parity copy_risk and symbol_mapping. Dedicated sizing columns remain the worker execution contract for supported modes.';

revoke all on function public.normalize_social_copy_manual_settings(jsonb) from public, anon;
grant execute on function public.normalize_social_copy_manual_settings(jsonb) to authenticated, service_role;
