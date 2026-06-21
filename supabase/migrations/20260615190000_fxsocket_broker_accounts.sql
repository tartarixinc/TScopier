-- FxSocket broker sandbox accounts (isolated from copier broker_accounts)

CREATE TABLE IF NOT EXISTS fxsocket_broker_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  fxsocket_account_id text NOT NULL DEFAULT '',
  account_login text,
  broker_server text,
  connection_status text NOT NULL DEFAULT 'connecting'
    CHECK (connection_status IN ('connecting', 'connected', 'error', 'disconnected')),
  connection_error text,
  last_balance numeric(18, 2),
  last_equity numeric(18, 2),
  last_currency text,
  last_synced_at timestamptz,
  terminal_connected boolean,
  trade_allowed boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fxsocket_broker_accounts_user_id_idx
  ON fxsocket_broker_accounts (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS fxsocket_broker_accounts_user_fxsocket_id_idx
  ON fxsocket_broker_accounts (user_id, fxsocket_account_id)
  WHERE fxsocket_account_id <> '';

ALTER TABLE fxsocket_broker_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own fxsocket broker accounts"
  ON fxsocket_broker_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own fxsocket broker accounts"
  ON fxsocket_broker_accounts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own fxsocket broker accounts"
  ON fxsocket_broker_accounts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own fxsocket broker accounts"
  ON fxsocket_broker_accounts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_fxsocket_broker_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fxsocket_broker_accounts_updated_at ON fxsocket_broker_accounts;
CREATE TRIGGER fxsocket_broker_accounts_updated_at
  BEFORE UPDATE ON fxsocket_broker_accounts
  FOR EACH ROW
  EXECUTE FUNCTION update_fxsocket_broker_accounts_updated_at();
