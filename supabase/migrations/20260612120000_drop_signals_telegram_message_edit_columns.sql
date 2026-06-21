-- Remove unused Telegram message-edit tracking columns (replaced by AI message revision).
ALTER TABLE public.signals
  DROP COLUMN IF EXISTS telegram_message_edited_at,
  DROP COLUMN IF EXISTS telegram_message_edit_date;
