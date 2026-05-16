-- Normalized buy/sell channel signals for backtesting (sourced from public.signals).

CREATE TABLE IF NOT EXISTS public.channel_trade_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.telegram_channels(id) ON DELETE CASCADE,
  signal_id uuid NOT NULL UNIQUE REFERENCES public.signals(id) ON DELETE CASCADE,
  telegram_message_id text,
  direction text NOT NULL CHECK (direction IN ('buy', 'sell')),
  symbol text NOT NULL,
  entry_price numeric(18,8) NOT NULL,
  sl numeric(18,8),
  tp_levels numeric(18,8)[] NOT NULL DEFAULT '{}',
  lot_size numeric(12,4),
  signal_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_trade_signals_user_signal_at
  ON public.channel_trade_signals(user_id, signal_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_trade_signals_channel_signal_at
  ON public.channel_trade_signals(channel_id, signal_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_trade_signals_user_channel_signal_at
  ON public.channel_trade_signals(user_id, channel_id, signal_at DESC);

ALTER TABLE public.channel_trade_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_trade_signals_user ON public.channel_trade_signals
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Extract buy/sell rows from signals.parsed_data (matches backtest parseSignal.ts rules).
CREATE OR REPLACE FUNCTION public.extract_channel_trade_signal_row(
  p_signal public.signals
)
RETURNS TABLE (
  user_id uuid,
  channel_id uuid,
  signal_id uuid,
  telegram_message_id text,
  direction text,
  symbol text,
  entry_price numeric,
  sl numeric,
  tp_levels numeric[],
  lot_size numeric,
  signal_at timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  pd jsonb;
  act text;
  sym text;
  ent numeric;
  sl_v numeric;
  tps numeric[];
  lot_v numeric;
BEGIN
  IF p_signal.channel_id IS NULL THEN
    RETURN;
  END IF;
  IF p_signal.status NOT IN ('parsed', 'executed') THEN
    RETURN;
  END IF;
  pd := p_signal.parsed_data;
  IF pd IS NULL THEN
    RETURN;
  END IF;

  act := lower(trim(coalesce(pd->>'action', '')));
  IF act NOT IN ('buy', 'sell') THEN
    RETURN;
  END IF;

  sym := upper(trim(coalesce(pd->>'symbol', '')));
  IF sym = '' THEN
    RETURN;
  END IF;

  ent := NULLIF(trim(coalesce(pd->>'entry_price', '')), '')::numeric;
  IF ent IS NULL OR ent <= 0 THEN
    ent := NULLIF(trim(coalesce(pd->>'entry_zone_low', '')), '')::numeric;
  END IF;
  IF ent IS NULL OR ent <= 0 THEN
    ent := NULLIF(trim(coalesce(pd->>'entry_zone_high', '')), '')::numeric;
  END IF;
  IF ent IS NULL OR ent <= 0 THEN
    RETURN;
  END IF;

  sl_v := NULLIF(trim(coalesce(pd->>'sl', '')), '')::numeric;

  SELECT coalesce(array_agg(v ORDER BY ord), '{}'::numeric[])
  INTO tps
  FROM (
    SELECT (elem::text)::numeric AS v, ord
    FROM jsonb_array_elements(coalesce(pd->'tp', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    WHERE elem IS NOT NULL AND trim(elem::text) <> '' AND (elem::text)::numeric IS NOT NULL
  ) sub;

  IF sl_v IS NULL AND coalesce(array_length(tps, 1), 0) = 0 THEN
    RETURN;
  END IF;

  lot_v := NULLIF(trim(coalesce(pd->>'lot_size', '')), '')::numeric;

  user_id := p_signal.user_id;
  channel_id := p_signal.channel_id;
  signal_id := p_signal.id;
  telegram_message_id := p_signal.telegram_message_id;
  direction := act;
  symbol := sym;
  entry_price := ent;
  sl := sl_v;
  tp_levels := coalesce(tps, '{}'::numeric[]);
  lot_size := lot_v;
  signal_at := p_signal.created_at;
  RETURN NEXT;
END;
$$;

-- Upsert tradeable rows for a user/channel/date window (call before each backtest run).
CREATE OR REPLACE FUNCTION public.refresh_channel_trade_signals(
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
  INSERT INTO public.channel_trade_signals (
    user_id, channel_id, signal_id, telegram_message_id,
    direction, symbol, entry_price, sl, tp_levels, lot_size, signal_at, updated_at
  )
  SELECT
    e.user_id, e.channel_id, e.signal_id, e.telegram_message_id,
    e.direction, e.symbol, e.entry_price, e.sl, e.tp_levels, e.lot_size, e.signal_at, now()
  FROM public.signals s
  CROSS JOIN LATERAL public.extract_channel_trade_signal_row(s) e
  WHERE s.user_id = p_user_id
    AND s.channel_id = ANY (p_channel_ids)
    AND s.created_at >= p_from
    AND s.created_at <= p_to
  ON CONFLICT (signal_id) DO UPDATE SET
    direction = EXCLUDED.direction,
    symbol = EXCLUDED.symbol,
    entry_price = EXCLUDED.entry_price,
    sl = EXCLUDED.sl,
    tp_levels = EXCLUDED.tp_levels,
    lot_size = EXCLUDED.lot_size,
    signal_at = EXCLUDED.signal_at,
    updated_at = now();

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_channel_trade_signals(uuid, uuid[], timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_channel_trade_signals(uuid, uuid[], timestamptz, timestamptz) TO service_role;

-- Keep channel_trade_signals in sync when signals are parsed.
CREATE OR REPLACE FUNCTION public.trg_sync_channel_trade_signal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.channel_trade_signals WHERE signal_id = OLD.id;
    RETURN OLD;
  END IF;

  DELETE FROM public.channel_trade_signals WHERE signal_id = NEW.id;

  INSERT INTO public.channel_trade_signals (
    user_id, channel_id, signal_id, telegram_message_id,
    direction, symbol, entry_price, sl, tp_levels, lot_size, signal_at, updated_at
  )
  SELECT
    e.user_id, e.channel_id, e.signal_id, e.telegram_message_id,
    e.direction, e.symbol, e.entry_price, e.sl, e.tp_levels, e.lot_size, e.signal_at, now()
  FROM public.extract_channel_trade_signal_row(NEW) e;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS signals_sync_channel_trade_signal ON public.signals;
CREATE TRIGGER signals_sync_channel_trade_signal
  AFTER INSERT OR UPDATE OF parsed_data, status ON public.signals
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_channel_trade_signal();

-- Backfill existing parsed buy/sell signals.
INSERT INTO public.channel_trade_signals (
  user_id, channel_id, signal_id, telegram_message_id,
  direction, symbol, entry_price, sl, tp_levels, lot_size, signal_at
)
SELECT
  e.user_id, e.channel_id, e.signal_id, e.telegram_message_id,
  e.direction, e.symbol, e.entry_price, e.sl, e.tp_levels, e.lot_size, e.signal_at
FROM public.signals s
CROSS JOIN LATERAL public.extract_channel_trade_signal_row(s) e
WHERE s.channel_id IS NOT NULL
ON CONFLICT (signal_id) DO NOTHING;

-- Backtest query index on raw signals (fallback path).
CREATE INDEX IF NOT EXISTS idx_signals_backtest_lookup
  ON public.signals(user_id, channel_id, created_at DESC)
  WHERE status IN ('parsed', 'executed');
