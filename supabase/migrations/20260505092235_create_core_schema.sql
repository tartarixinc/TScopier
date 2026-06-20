/*
  # TScopier AI - Core Schema

  ## Overview
  Creates the foundational tables for TScopier AI, an automated trade copier that
  reads Telegram signals and executes trades via MetaAPI.

  ## New Tables

  ### broker_accounts
  Stores user-connected broker accounts via MetaAPI.
  - id: UUID primary key
  - user_id: References auth.users
  - label: User-defined name for the account
  - platform: MT4, MT5, cTrader, DXTrade, or TradeLocker
  - metaapi_account_id: MetaAPI's account identifier
  - is_active: Whether this account is currently being used
  - default_lot_size: Default trade size
  - pip_tolerance: Max pips from signal price before skipping
  - max_trades_per_zone: Zone entry frequency control

  ### telegram_sessions
  Stores MTProto session strings per user for persistent Telegram connections.
  - id: UUID primary key
  - user_id: References auth.users (unique - one session per user)
  - session_string: Encrypted MTProto session token
  - phone_number: User's Telegram phone number
  - is_active: Session validity flag

  ### telegram_channels
  Tracks which Telegram channels each user is monitoring.
  - id: UUID primary key
  - user_id: References auth.users
  - channel_id: Telegram's internal channel ID
  - channel_username: @username or invite hash
  - display_name: Human-readable channel name
  - is_active: Monitoring toggle
  - lot_size_override: Per-channel lot size (overrides broker default if set)
  - pip_tolerance_override: Per-channel pip tolerance

  ### signals
  Logs every parsed Telegram message.
  - id: UUID primary key
  - user_id, channel_id: References to owner and source
  - raw_message: Original message text
  - raw_image_url: If message was an image
  - parsed_data: AI-extracted trade instruction as JSONB
  - status: pending | parsed | executed | skipped | failed
  - skip_reason: Why a signal was skipped (pip tolerance, non-trade message, etc.)

  ### trades
  Records every trade placed via MetaAPI.
  - id: UUID primary key
  - user_id, signal_id, broker_account_id: References
  - metaapi_order_id: Order ID from MetaAPI
  - symbol, direction, entry_price, sl, tp, lot_size
  - status: open | closed | modified | cancelled
  - opened_at, closed_at: Timestamps

  ## Security
  - RLS enabled on all tables
  - All policies restrict access to authenticated users who own the row
*/

-- Broker accounts
CREATE TABLE IF NOT EXISTS broker_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  platform text NOT NULL DEFAULT 'MT4',
  metaapi_account_id text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  default_lot_size numeric(10,2) NOT NULL DEFAULT 0.01,
  pip_tolerance integer NOT NULL DEFAULT 20,
  max_trades_per_zone integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE broker_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own broker accounts"
  ON broker_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own broker accounts"
  ON broker_accounts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own broker accounts"
  ON broker_accounts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own broker accounts"
  ON broker_accounts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Telegram sessions
CREATE TABLE IF NOT EXISTS telegram_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  session_string text NOT NULL DEFAULT '',
  phone_number text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own telegram session"
  ON telegram_sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own telegram session"
  ON telegram_sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own telegram session"
  ON telegram_sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own telegram session"
  ON telegram_sessions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Telegram channels
CREATE TABLE IF NOT EXISTS telegram_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id text NOT NULL DEFAULT '',
  channel_username text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  lot_size_override numeric(10,2),
  pip_tolerance_override integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own telegram channels"
  ON telegram_channels FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own telegram channels"
  ON telegram_channels FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own telegram channels"
  ON telegram_channels FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own telegram channels"
  ON telegram_channels FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Signals
CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES telegram_channels(id) ON DELETE SET NULL,
  raw_message text NOT NULL DEFAULT '',
  raw_image_url text,
  parsed_data jsonb,
  status text NOT NULL DEFAULT 'pending',
  skip_reason text,
  telegram_message_id text,
  is_modification boolean NOT NULL DEFAULT false,
  parent_signal_id uuid REFERENCES signals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own signals"
  ON signals FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own signals"
  ON signals FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own signals"
  ON signals FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Trades
CREATE TABLE IF NOT EXISTS trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id uuid REFERENCES signals(id) ON DELETE SET NULL,
  broker_account_id uuid REFERENCES broker_accounts(id) ON DELETE SET NULL,
  metaapi_order_id text,
  symbol text NOT NULL DEFAULT '',
  direction text NOT NULL DEFAULT 'buy',
  entry_price numeric(20,8),
  sl numeric(20,8),
  tp numeric(20,8),
  lot_size numeric(10,2) NOT NULL DEFAULT 0.01,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  profit numeric(20,8),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own trades"
  ON trades FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own trades"
  ON trades FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own trades"
  ON trades FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS signals_user_id_idx ON signals(user_id);
CREATE INDEX IF NOT EXISTS signals_channel_id_idx ON signals(channel_id);
CREATE INDEX IF NOT EXISTS signals_status_idx ON signals(status);
CREATE INDEX IF NOT EXISTS trades_user_id_idx ON trades(user_id);
CREATE INDEX IF NOT EXISTS trades_status_idx ON trades(status);
CREATE INDEX IF NOT EXISTS telegram_channels_user_id_idx ON telegram_channels(user_id);
