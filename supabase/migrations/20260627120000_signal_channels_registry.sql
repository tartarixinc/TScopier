-- Permanent global channel registry + canonical stores (channel-scoped listener master plan).

-- ── signal_channels: immortal registry keyed by Telegram chat id ─────────────

CREATE TABLE IF NOT EXISTS public.signal_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_chat_id text NOT NULL,
  channel_username text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_live_at timestamptz,
  subscriber_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_channels_telegram_chat_id_unique UNIQUE (telegram_chat_id)
);

CREATE INDEX IF NOT EXISTS signal_channels_subscriber_count_idx
  ON public.signal_channels (subscriber_count DESC);

COMMENT ON TABLE public.signal_channels IS
  'Permanent global registry for Telegram VIP channels. Never deleted on user unsubscribe.';

ALTER TABLE public.signal_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view signal channels"
  ON public.signal_channels FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated can insert signal channels"
  ON public.signal_channels FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated can update signal channels"
  ON public.signal_channels FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Backfill from existing telegram_channels (one row per distinct numeric channel_id).
INSERT INTO public.signal_channels (telegram_chat_id, channel_username, display_name, first_seen_at, last_live_at)
SELECT
  tc.channel_id,
  COALESCE(NULLIF(TRIM(MAX(tc.channel_username)), ''), ''),
  COALESCE(NULLIF(TRIM(MAX(tc.display_name)), ''), MAX(tc.channel_id)),
  MIN(tc.created_at),
  MAX(tc.last_live_at)
FROM public.telegram_channels tc
WHERE tc.channel_id IS NOT NULL
  AND TRIM(tc.channel_id) <> ''
  AND tc.channel_id ~ '^-?\d+$'
GROUP BY tc.channel_id
ON CONFLICT (telegram_chat_id) DO UPDATE SET
  channel_username = COALESCE(NULLIF(EXCLUDED.channel_username, ''), signal_channels.channel_username),
  display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), signal_channels.display_name),
  last_live_at = GREATEST(signal_channels.last_live_at, EXCLUDED.last_live_at),
  updated_at = now();

-- Subscription FK on telegram_channels.
ALTER TABLE public.telegram_channels
  ADD COLUMN IF NOT EXISTS signal_channel_id uuid REFERENCES public.signal_channels(id) ON DELETE RESTRICT;

UPDATE public.telegram_channels tc
SET signal_channel_id = sc.id
FROM public.signal_channels sc
WHERE tc.signal_channel_id IS NULL
  AND tc.channel_id IS NOT NULL
  AND TRIM(tc.channel_id) <> ''
  AND tc.channel_id ~ '^-?\d+$'
  AND sc.telegram_chat_id = tc.channel_id;

CREATE INDEX IF NOT EXISTS telegram_channels_signal_channel_id_idx
  ON public.telegram_channels (signal_channel_id);

-- Denormalized subscriber count.
UPDATE public.signal_channels sc
SET subscriber_count = sub.cnt,
    updated_at = now()
FROM (
  SELECT signal_channel_id, COUNT(*)::integer AS cnt
  FROM public.telegram_channels
  WHERE is_active = true AND signal_channel_id IS NOT NULL
  GROUP BY signal_channel_id
) sub
WHERE sc.id = sub.signal_channel_id;

-- ── canonical message + signal stores ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.channel_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_channel_id uuid NOT NULL REFERENCES public.signal_channels(id) ON DELETE RESTRICT,
  telegram_message_id text NOT NULL,
  raw_message text NOT NULL DEFAULT '',
  edit_date timestamptz,
  reply_to_message_id text,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_messages_signal_channel_message_unique
    UNIQUE (signal_channel_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS channel_messages_signal_channel_received_idx
  ON public.channel_messages (signal_channel_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.channel_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_channel_id uuid NOT NULL REFERENCES public.signal_channels(id) ON DELETE RESTRICT,
  telegram_message_id text NOT NULL,
  raw_message text NOT NULL DEFAULT '',
  parsed_data jsonb,
  parent_message_id text,
  status text NOT NULL DEFAULT 'pending',
  skip_reason text,
  pipeline_ts jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_signals_signal_channel_message_unique
    UNIQUE (signal_channel_id, telegram_message_id)
);

CREATE INDEX IF NOT EXISTS channel_signals_signal_channel_created_idx
  ON public.channel_signals (signal_channel_id, created_at DESC);

-- Traceability: canonical → per-user projection.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS channel_signal_id uuid REFERENCES public.channel_signals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS signals_channel_signal_id_idx
  ON public.signals (channel_signal_id)
  WHERE channel_signal_id IS NOT NULL;

-- ── shared parse profile / lexicon at signal_channel level ───────────────────

ALTER TABLE public.channel_signal_profiles
  ADD COLUMN IF NOT EXISTS signal_channel_id uuid REFERENCES public.signal_channels(id) ON DELETE CASCADE;

UPDATE public.channel_signal_profiles csp
SET signal_channel_id = tc.signal_channel_id
FROM public.telegram_channels tc
WHERE csp.signal_channel_id IS NULL
  AND csp.channel_id = tc.id
  AND tc.signal_channel_id IS NOT NULL;

-- Merge duplicate profiles per signal_channel (keep best-trained row).
WITH ranked AS (
  SELECT
    id,
    signal_channel_id,
    ROW_NUMBER() OVER (
      PARTITION BY signal_channel_id
      ORDER BY sample_size DESC NULLS LAST, analyzed_at DESC NULLS LAST, updated_at DESC
    ) AS rn
  FROM public.channel_signal_profiles
  WHERE signal_channel_id IS NOT NULL
),
losers AS (SELECT id FROM ranked WHERE rn > 1)
DELETE FROM public.channel_signal_profiles WHERE id IN (SELECT id FROM losers);

CREATE UNIQUE INDEX IF NOT EXISTS channel_signal_profiles_signal_channel_unique_idx
  ON public.channel_signal_profiles (signal_channel_id)
  WHERE signal_channel_id IS NOT NULL;

ALTER TABLE public.channel_signal_lexicon
  ADD COLUMN IF NOT EXISTS signal_channel_id uuid REFERENCES public.signal_channels(id) ON DELETE CASCADE;

UPDATE public.channel_signal_lexicon csl
SET signal_channel_id = tc.signal_channel_id
FROM public.telegram_channels tc
WHERE csl.signal_channel_id IS NULL
  AND csl.channel_id = tc.id
  AND tc.signal_channel_id IS NOT NULL;

WITH ranked AS (
  SELECT
    id,
    signal_channel_id,
    ROW_NUMBER() OVER (
      PARTITION BY signal_channel_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC
    ) AS rn
  FROM public.channel_signal_lexicon
  WHERE signal_channel_id IS NOT NULL
),
losers AS (SELECT id FROM ranked WHERE rn > 1)
DELETE FROM public.channel_signal_lexicon WHERE id IN (SELECT id FROM losers);

CREATE UNIQUE INDEX IF NOT EXISTS channel_signal_lexicon_signal_channel_unique_idx
  ON public.channel_signal_lexicon (signal_channel_id)
  WHERE signal_channel_id IS NOT NULL;

-- ── channel listener leases (one elected reader per signal_channel) ──────────

CREATE TABLE IF NOT EXISTS public.channel_listener_leases (
  signal_channel_id uuid PRIMARY KEY REFERENCES public.signal_channels(id) ON DELETE RESTRICT,
  reader_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  role text NOT NULL DEFAULT 'channel_listener',
  shard_id integer NOT NULL DEFAULT 0,
  shard_count integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channel_listener_leases_expires_idx
  ON public.channel_listener_leases (expires_at);

COMMENT ON TABLE public.channel_listener_leases IS
  'Elected subscriber MTProto session that reads Telegram for a signal_channel.';

ALTER TABLE public.channel_listener_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY channel_listener_leases_service ON public.channel_listener_leases
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- Active subscriptions view (fan-out targets).
CREATE OR REPLACE VIEW public.channel_subscriptions AS
SELECT
  tc.signal_channel_id,
  tc.id AS subscription_id,
  tc.user_id,
  tc.is_active,
  tc.channel_keywords,
  tc.lot_size_override,
  tc.pip_tolerance_override
FROM public.telegram_channels tc
WHERE tc.signal_channel_id IS NOT NULL
  AND tc.is_active = true;

-- Atomic channel lease acquire (mirrors worker_session_leases).
CREATE OR REPLACE FUNCTION acquire_channel_listener_lease(
  p_signal_channel_id uuid,
  p_reader_user_id uuid,
  p_worker_id text,
  p_role text,
  p_shard_id integer,
  p_shard_count integer,
  p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_signal_channel_id::text));

  UPDATE channel_listener_leases
  SET
    reader_user_id = p_reader_user_id,
    worker_id = p_worker_id,
    role = p_role,
    shard_id = p_shard_id,
    shard_count = p_shard_count,
    expires_at = p_expires_at,
    updated_at = now()
  WHERE signal_channel_id = p_signal_channel_id
    AND (worker_id = p_worker_id OR expires_at <= now());

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated > 0 THEN
    RETURN true;
  END IF;

  BEGIN
    INSERT INTO channel_listener_leases (
      signal_channel_id, reader_user_id, worker_id, role, shard_id, shard_count, expires_at, updated_at
    ) VALUES (
      p_signal_channel_id, p_reader_user_id, p_worker_id, p_role, p_shard_id, p_shard_count, p_expires_at, now()
    );
    RETURN true;
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;
END;
$$;

REVOKE ALL ON FUNCTION acquire_channel_listener_lease FROM PUBLIC;
GRANT EXECUTE ON FUNCTION acquire_channel_listener_lease TO service_role;

-- Keep subscriber_count in sync.
CREATE OR REPLACE FUNCTION refresh_signal_channel_subscriber_count(p_signal_channel_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE signal_channels sc
  SET
    subscriber_count = (
      SELECT COUNT(*)::integer
      FROM telegram_channels tc
      WHERE tc.signal_channel_id = p_signal_channel_id AND tc.is_active = true
    ),
    updated_at = now()
  WHERE sc.id = p_signal_channel_id;
$$;

REVOKE ALL ON FUNCTION refresh_signal_channel_subscriber_count FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_signal_channel_subscriber_count TO service_role;

CREATE OR REPLACE FUNCTION trg_telegram_channels_refresh_subscriber_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.signal_channel_id IS NOT NULL THEN
      PERFORM refresh_signal_channel_subscriber_count(OLD.signal_channel_id);
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.signal_channel_id IS DISTINCT FROM NEW.signal_channel_id AND OLD.signal_channel_id IS NOT NULL THEN
      PERFORM refresh_signal_channel_subscriber_count(OLD.signal_channel_id);
    END IF;
  END IF;

  IF NEW.signal_channel_id IS NOT NULL THEN
    PERFORM refresh_signal_channel_subscriber_count(NEW.signal_channel_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telegram_channels_subscriber_count_trg ON public.telegram_channels;
CREATE TRIGGER telegram_channels_subscriber_count_trg
  AFTER INSERT OR UPDATE OF is_active, signal_channel_id OR DELETE
  ON public.telegram_channels
  FOR EACH ROW
  EXECUTE FUNCTION trg_telegram_channels_refresh_subscriber_count();
