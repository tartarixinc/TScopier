-- Latest channel-wide SL/TP overrides (management / parameter refresh).
-- Applied when materializing or syncing range_pending_legs so new ladder rungs
-- do not revert to the original entry signal stops.

CREATE TABLE IF NOT EXISTS public.channel_active_trade_params (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES public.telegram_channels(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  stoploss numeric(20, 8),
  tp_levels numeric(20, 8)[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id, symbol)
);

CREATE INDEX IF NOT EXISTS channel_active_trade_params_channel_idx
  ON public.channel_active_trade_params (user_id, channel_id);

ALTER TABLE public.channel_active_trade_params ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_active_trade_params_user ON public.channel_active_trade_params
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.channel_active_trade_params IS
  'Per-channel symbol SL/TP from management instructions; overlays signal stops on pending ladder legs.';
