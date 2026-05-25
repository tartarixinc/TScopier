-- If 20260525160000 was applied with a partial unique index, upsert may not infer
-- ON CONFLICT (user_id, channel_id, telegram_message_id). Replace with a full index.

DROP INDEX IF EXISTS signals_user_channel_telegram_message_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS signals_user_channel_telegram_message_unique_idx
  ON public.signals (user_id, channel_id, telegram_message_id);
