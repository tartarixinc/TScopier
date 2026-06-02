-- Repair trade → channel attributions where channel can be inferred from trades/signals.

UPDATE public.trade_channel_attributions tca
SET
  channel_id = resolved.channel_id,
  channel_label = resolved.channel_label,
  updated_at = now()
FROM (
  SELECT
    tca.trade_id,
    COALESCE(t.telegram_channel_id, s.channel_id) AS channel_id,
    COALESCE(
      NULLIF(trim(c.display_name), ''),
      NULLIF(trim(c.channel_username), ''),
      'Unlinked / manual'
    ) AS channel_label
  FROM public.trade_channel_attributions tca
  JOIN public.trades t ON t.id = tca.trade_id
  LEFT JOIN public.signals s ON s.id = tca.signal_id
  LEFT JOIN public.telegram_channels c
    ON c.id = COALESCE(t.telegram_channel_id, s.channel_id)
  WHERE tca.channel_id IS NULL
    AND COALESCE(t.telegram_channel_id, s.channel_id) IS NOT NULL
) resolved
WHERE tca.trade_id = resolved.trade_id;

-- Clear misleading default label when channel is now linked.
UPDATE public.trade_channel_attributions
SET channel_label = c.display_name,
    updated_at = now()
FROM public.telegram_channels c
WHERE trade_channel_attributions.channel_id = c.id
  AND lower(trim(coalesce(trade_channel_attributions.channel_label, ''))) = 'unlinked / manual'
  AND NULLIF(trim(c.display_name), '') IS NOT NULL;
