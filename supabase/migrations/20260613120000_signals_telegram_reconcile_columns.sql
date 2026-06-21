-- Track last Telegram reconciliation fetch for each signal post.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS telegram_reconciled_at timestamptz,
  ADD COLUMN IF NOT EXISTS telegram_edit_date_seen integer;

COMMENT ON COLUMN public.signals.telegram_reconciled_at IS
  'When the listener last fetched this Telegram message and compared text to raw_message.';
COMMENT ON COLUMN public.signals.telegram_edit_date_seen IS
  'Telegram message edit_date (unix seconds) last seen during reconciliation.';

CREATE INDEX IF NOT EXISTS idx_signals_reconcile_candidates
  ON public.signals (user_id, created_at DESC)
  WHERE telegram_message_id IS NOT NULL
    AND status IN ('parsed', 'executed');
