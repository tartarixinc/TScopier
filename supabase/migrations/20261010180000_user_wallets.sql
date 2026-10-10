/*
  # Copy-subscription wallets

  One balance row per user, plus a ledger of copy payments.
  Stripe charging and payouts write these rows later.
  Users can read their own wallet and any ledger row where they paid or were paid.
*/

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'wallet_ledger_status') THEN
    CREATE TYPE wallet_ledger_status AS ENUM ('pending', 'paid', 'reversed');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.user_wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  available_cents bigint NOT NULL DEFAULT 0,
  pending_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_wallets_available_cents_nonnegative CHECK (available_cents >= 0),
  CONSTRAINT user_wallets_pending_cents_nonnegative CHECK (pending_cents >= 0)
);

CREATE TABLE IF NOT EXISTS public.wallet_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'usd',
  status wallet_ledger_status NOT NULL DEFAULT 'pending',
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_ledger_amount_cents_positive CHECK (amount_cents > 0),
  CONSTRAINT wallet_ledger_not_self CHECK (payer_user_id <> provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_payer_user_id
  ON public.wallet_ledger (payer_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_provider_user_id
  ON public.wallet_ledger (provider_user_id, created_at DESC);

ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own wallet" ON public.user_wallets;
CREATE POLICY "Users can view own wallet"
  ON public.user_wallets
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view own wallet ledger" ON public.wallet_ledger;
CREATE POLICY "Users can view own wallet ledger"
  ON public.wallet_ledger
  FOR SELECT
  TO authenticated
  USING (auth.uid() = payer_user_id OR auth.uid() = provider_user_id);

CREATE OR REPLACE FUNCTION public.touch_user_wallet_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_wallets_touch_updated_at ON public.user_wallets;
CREATE TRIGGER user_wallets_touch_updated_at
  BEFORE UPDATE ON public.user_wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_user_wallet_updated_at();
