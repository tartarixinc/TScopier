/*
  Automatically update signal_channels.last_live_at when any signal is created.

  The canonical pipeline (channel_signals → signal_channels.last_live_at) only
  runs on the elected reader. The Python listener and legacy TS listener paths
  write directly to the per-user signals table without touching signal_channels.

  This trigger catches ALL signal creations regardless of source and bumps
  the corresponding signal_channel's last_live_at via the telegram_channels
  bridge (signals → telegram_channels → signal_channels).
*/

CREATE OR REPLACE FUNCTION public.bump_signal_channel_last_live()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.signal_channels sc
  SET
    last_live_at = GREATEST(sc.last_live_at, NEW.created_at),
    updated_at = now()
  FROM public.telegram_channels tc
  WHERE tc.id = NEW.channel_id
    AND tc.signal_channel_id IS NOT NULL
    AND tc.signal_channel_id = sc.id
    AND (sc.last_live_at IS NULL OR NEW.created_at > sc.last_live_at);
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.bump_signal_channel_last_live() IS
  'Updates signal_channels.last_live_at whenever a new signal is inserted, bridging via telegram_channels.';

DROP TRIGGER IF EXISTS trg_bump_signal_channel_last_live ON public.signals;

CREATE TRIGGER trg_bump_signal_channel_last_live
  AFTER INSERT ON public.signals
  FOR EACH ROW
  WHEN (NEW.channel_id IS NOT NULL)
  EXECUTE FUNCTION public.bump_signal_channel_last_live();
