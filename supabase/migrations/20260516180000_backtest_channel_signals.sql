-- Dedicated backtest signal store (Telegram history import + optional link to copier signals).
-- Replaces channel_trade_signals from 20260516170000 when that migration failed or is superseded.

DROP TRIGGER IF EXISTS signals_sync_channel_trade_signal ON public.signals;
DROP FUNCTION IF EXISTS public.trg_sync_channel_trade_signal();
DROP FUNCTION IF EXISTS public.refresh_channel_trade_signals(uuid, uuid[], timestamptz, timestamptz);
DROP TABLE IF EXISTS public.channel_trade_signals CASCADE;

CREATE TABLE IF NOT EXISTS public.backtest_channel_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.telegram_channels(id) ON DELETE CASCADE,
  signal_id uuid REFERENCES public.signals(id) ON DELETE SET NULL,
  telegram_message_id text,
  source text NOT NULL DEFAULT 'telegram_import'
    CHECK (source IN ('telegram_import', 'copier_live', 'manual')),
  direction text NOT NULL CHECK (direction IN ('buy', 'sell')),
  symbol text NOT NULL,
  entry_price numeric(18,8) NOT NULL,
  sl numeric(18,8),
  tp_levels numeric(18,8)[] NOT NULL DEFAULT '{}',
  lot_size numeric(12,4),
  raw_message text,
  parsed_data jsonb,
  signal_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backtest_channel_signals_channel_message_unique
    UNIQUE (user_id, channel_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS idx_backtest_channel_signals_user_signal_at
  ON public.backtest_channel_signals(user_id, signal_at DESC);
CREATE INDEX IF NOT EXISTS idx_backtest_channel_signals_user_channel_signal_at
  ON public.backtest_channel_signals(user_id, channel_id, signal_at DESC);

ALTER TABLE public.backtest_channel_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY backtest_channel_signals_user ON public.backtest_channel_signals
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Upsert one tradeable row (used by import + sync from signals).
CREATE OR REPLACE FUNCTION public.upsert_backtest_channel_signal(
  p_user_id uuid,
  p_channel_id uuid,
  p_signal_id uuid,
  p_telegram_message_id text,
  p_source text,
  p_direction text,
  p_symbol text,
  p_entry_price numeric,
  p_sl numeric,
  p_tp_levels numeric[],
  p_lot_size numeric,
  p_raw_message text,
  p_parsed_data jsonb,
  p_signal_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  out_id uuid;
BEGIN
  IF p_channel_id IS NULL THEN
    RAISE EXCEPTION 'channel_id is required for backtest signals';
  END IF;
  IF p_direction NOT IN ('buy', 'sell') THEN
    RAISE EXCEPTION 'direction must be buy or sell';
  END IF;

  INSERT INTO public.backtest_channel_signals (
    user_id, channel_id, signal_id, telegram_message_id, source,
    direction, symbol, entry_price, sl, tp_levels, lot_size,
    raw_message, parsed_data, signal_at, updated_at
  )
  VALUES (
    p_user_id, p_channel_id, p_signal_id, p_telegram_message_id, coalesce(p_source, 'telegram_import'),
    p_direction, upper(p_symbol), p_entry_price, p_sl, coalesce(p_tp_levels, '{}'),
    p_lot_size, p_raw_message, p_parsed_data, p_signal_at, now()
  )
  ON CONFLICT (user_id, channel_id, telegram_message_id)
  DO UPDATE SET
    signal_id = coalesce(EXCLUDED.signal_id, backtest_channel_signals.signal_id),
    source = EXCLUDED.source,
    direction = EXCLUDED.direction,
    symbol = EXCLUDED.symbol,
    entry_price = EXCLUDED.entry_price,
    sl = EXCLUDED.sl,
    tp_levels = EXCLUDED.tp_levels,
    lot_size = EXCLUDED.lot_size,
    raw_message = coalesce(EXCLUDED.raw_message, backtest_channel_signals.raw_message),
    parsed_data = coalesce(EXCLUDED.parsed_data, backtest_channel_signals.parsed_data),
    signal_at = EXCLUDED.signal_at,
    updated_at = now()
  RETURNING id INTO out_id;

  RETURN out_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_backtest_channel_signal(
  uuid, uuid, uuid, text, text, text, text, numeric, numeric, numeric[], numeric, text, jsonb, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_backtest_channel_signal(
  uuid, uuid, uuid, text, text, text, text, numeric, numeric, numeric[], numeric, text, jsonb, timestamptz
) TO service_role;

-- Sync tradeable rows from copier signals (channel_id required).
CREATE OR REPLACE FUNCTION public.refresh_backtest_channel_signals(
  p_user_id uuid,
  p_channel_ids uuid[],
  p_from timestamptz,
  p_to timestamptz
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
BEGIN
  INSERT INTO public.backtest_channel_signals (
    user_id, channel_id, signal_id, telegram_message_id, source,
    direction, symbol, entry_price, sl, tp_levels, lot_size,
    raw_message, parsed_data, signal_at, updated_at
  )
  SELECT
    e.user_id,
    e.channel_id,
    e.signal_id,
    e.telegram_message_id,
    'copier_live',
    e.direction,
    e.symbol,
    e.entry_price,
    e.sl,
    e.tp_levels,
    e.lot_size,
    s.raw_message,
    s.parsed_data,
    e.signal_at,
    now()
  FROM public.signals s
  CROSS JOIN LATERAL public.extract_channel_trade_signal_row(s) e
  WHERE s.user_id = p_user_id
    AND s.channel_id IS NOT NULL
    AND s.channel_id = ANY (p_channel_ids)
    AND s.created_at >= p_from
    AND s.created_at <= p_to
  ON CONFLICT (user_id, channel_id, telegram_message_id)
  DO UPDATE SET
    signal_id = EXCLUDED.signal_id,
    direction = EXCLUDED.direction,
    symbol = EXCLUDED.symbol,
    entry_price = EXCLUDED.entry_price,
    sl = EXCLUDED.sl,
    tp_levels = EXCLUDED.tp_levels,
    lot_size = EXCLUDED.lot_size,
    raw_message = EXCLUDED.raw_message,
    parsed_data = EXCLUDED.parsed_data,
    signal_at = EXCLUDED.signal_at,
    updated_at = now();

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_backtest_channel_signals(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_backtest_channel_signals(uuid, uuid[], timestamptz, timestamptz) TO service_role;

-- Keep extract function for LATERAL sync (must skip null channel_id — fixed in 20260516170000).

-- Prune backtest rows outside an import window (optional cleanup per run).
CREATE OR REPLACE FUNCTION public.delete_backtest_channel_signals_outside_range(
  p_user_id uuid,
  p_channel_ids uuid[],
  p_from timestamptz,
  p_to timestamptz,
  p_sources text[] DEFAULT ARRAY['telegram_import']
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM public.backtest_channel_signals
  WHERE user_id = p_user_id
    AND channel_id = ANY (p_channel_ids)
    AND source = ANY (p_sources)
    AND (signal_at < p_from OR signal_at > p_to);

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_backtest_channel_signals_outside_range(uuid, uuid[], timestamptz, timestamptz, text[]) TO service_role;

-- Backfill from existing copier signals (channel_id required).
INSERT INTO public.backtest_channel_signals (
  user_id, channel_id, signal_id, telegram_message_id, source,
  direction, symbol, entry_price, sl, tp_levels, lot_size,
  raw_message, parsed_data, signal_at
)
SELECT
  e.user_id,
  e.channel_id,
  e.signal_id,
  e.telegram_message_id,
  'copier_live',
  e.direction,
  e.symbol,
  e.entry_price,
  e.sl,
  e.tp_levels,
  e.lot_size,
  s.raw_message,
  s.parsed_data,
  e.signal_at
FROM public.signals s
CROSS JOIN LATERAL public.extract_channel_trade_signal_row(s) e
WHERE s.channel_id IS NOT NULL
  AND s.telegram_message_id IS NOT NULL
ON CONFLICT (user_id, channel_id, telegram_message_id) DO NOTHING;
