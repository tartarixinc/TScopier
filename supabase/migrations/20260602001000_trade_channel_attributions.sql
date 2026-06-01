-- Durable trade → channel attribution for performance analytics.
-- Keeps channel linkage even if current broker/channel wiring changes later.

CREATE TABLE IF NOT EXISTS public.trade_channel_attributions (
  trade_id uuid PRIMARY KEY REFERENCES public.trades(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker_account_id uuid REFERENCES public.broker_accounts(id) ON DELETE SET NULL,
  metaapi_order_id text,
  signal_id uuid REFERENCES public.signals(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES public.telegram_channels(id) ON DELETE SET NULL,
  channel_label text NOT NULL DEFAULT 'Unlinked / manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trade_channel_attrib_user_ticket_idx
  ON public.trade_channel_attributions(user_id, broker_account_id, metaapi_order_id);

CREATE INDEX IF NOT EXISTS trade_channel_attrib_user_channel_idx
  ON public.trade_channel_attributions(user_id, channel_id);

CREATE INDEX IF NOT EXISTS trade_channel_attrib_user_signal_idx
  ON public.trade_channel_attributions(user_id, signal_id);

ALTER TABLE public.trade_channel_attributions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'trade_channel_attributions'
      AND policyname = 'trade_channel_attributions_user'
  ) THEN
    CREATE POLICY trade_channel_attributions_user
      ON public.trade_channel_attributions
      FOR ALL
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.trg_sync_trade_channel_attribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  resolved_channel_id uuid;
  resolved_channel_label text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.trade_channel_attributions WHERE trade_id = OLD.id;
    RETURN OLD;
  END IF;

  resolved_channel_id := NEW.telegram_channel_id;
  IF resolved_channel_id IS NULL AND NEW.signal_id IS NOT NULL THEN
    SELECT s.channel_id
      INTO resolved_channel_id
    FROM public.signals s
    WHERE s.id = NEW.signal_id;
  END IF;

  IF resolved_channel_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(trim(c.display_name), ''), NULLIF(trim(c.channel_username), ''), 'Unlinked / manual')
      INTO resolved_channel_label
    FROM public.telegram_channels c
    WHERE c.id = resolved_channel_id;
  END IF;

  resolved_channel_label := COALESCE(resolved_channel_label, 'Unlinked / manual');

  INSERT INTO public.trade_channel_attributions (
    trade_id,
    user_id,
    broker_account_id,
    metaapi_order_id,
    signal_id,
    channel_id,
    channel_label,
    updated_at
  ) VALUES (
    NEW.id,
    NEW.user_id,
    NEW.broker_account_id,
    NEW.metaapi_order_id,
    NEW.signal_id,
    resolved_channel_id,
    resolved_channel_label,
    now()
  )
  ON CONFLICT (trade_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    broker_account_id = EXCLUDED.broker_account_id,
    metaapi_order_id = EXCLUDED.metaapi_order_id,
    signal_id = EXCLUDED.signal_id,
    channel_id = EXCLUDED.channel_id,
    channel_label = EXCLUDED.channel_label,
    updated_at = now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trades_sync_trade_channel_attribution ON public.trades;
CREATE TRIGGER trades_sync_trade_channel_attribution
  AFTER INSERT OR UPDATE OF user_id, broker_account_id, metaapi_order_id, signal_id, telegram_channel_id
  ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_trade_channel_attribution();

-- Backfill existing trade rows.
INSERT INTO public.trade_channel_attributions (
  trade_id,
  user_id,
  broker_account_id,
  metaapi_order_id,
  signal_id,
  channel_id,
  channel_label,
  created_at,
  updated_at
)
SELECT
  t.id,
  t.user_id,
  t.broker_account_id,
  t.metaapi_order_id,
  t.signal_id,
  COALESCE(t.telegram_channel_id, s.channel_id) AS channel_id,
  COALESCE(NULLIF(trim(c.display_name), ''), NULLIF(trim(c.channel_username), ''), 'Unlinked / manual') AS channel_label,
  now(),
  now()
FROM public.trades t
LEFT JOIN public.signals s
  ON s.id = t.signal_id
LEFT JOIN public.telegram_channels c
  ON c.id = COALESCE(t.telegram_channel_id, s.channel_id)
ON CONFLICT (trade_id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  broker_account_id = EXCLUDED.broker_account_id,
  metaapi_order_id = EXCLUDED.metaapi_order_id,
  signal_id = EXCLUDED.signal_id,
  channel_id = EXCLUDED.channel_id,
  channel_label = EXCLUDED.channel_label,
  updated_at = now();
