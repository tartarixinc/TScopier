-- Telegram MTProto edit_date (unix seconds) for skip-fast edit sweep comparisons.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS telegram_message_edit_date integer;

COMMENT ON COLUMN public.signals.telegram_message_edit_date IS
  'Telegram message edit_date (unix seconds) last seen for this signal post.';
