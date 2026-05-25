-- Telegram message IDs are unique per chat, NOT per user account.
-- The old unique index (user_id, telegram_message_id) caused cross-channel collisions:
-- when SIGNALS PRO ingested message id 42, SIGNALS 2 message id 42 was silently dropped.

-- Dedupe within (user_id, channel_id, telegram_message_id) before adding the new index.
DELETE FROM signals s
USING (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY user_id, channel_id, telegram_message_id
        ORDER BY created_at DESC, id DESC
      ) AS rn
    FROM signals
    WHERE telegram_message_id IS NOT NULL
      AND channel_id IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
) d
WHERE s.id = d.id;

DROP INDEX IF EXISTS signals_user_telegram_message_unique_idx;

-- Non-partial index so Supabase upsert ON CONFLICT (user_id, channel_id, telegram_message_id) infers correctly.
CREATE UNIQUE INDEX IF NOT EXISTS signals_user_channel_telegram_message_unique_idx
  ON public.signals (user_id, channel_id, telegram_message_id);

COMMENT ON INDEX public.signals_user_channel_telegram_message_unique_idx IS
  'One signal row per Telegram message within each monitored channel (message ids collide across channels).';
