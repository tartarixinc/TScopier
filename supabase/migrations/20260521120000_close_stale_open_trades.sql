/*
  One-time cleanup: mark historical rows stuck as status = 'open' as closed.

  Run the preview first. This updates every open trade (not pending).
  To limit to older rows only, add e.g.:
    AND opened_at < now() - interval '7 days'

  Side effects: AFTER UPDATE triggers on trades may cancel range_pending_legs
  when a (signal, broker, symbol) basket becomes fully flat.
*/

-- Preview
-- SELECT count(*) AS open_trade_count FROM public.trades WHERE status = 'open';

UPDATE public.trades
SET
  status = 'closed',
  closed_at = COALESCE(closed_at, opened_at, now())
WHERE status = 'open';
