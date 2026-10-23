/*
  Billing transparency groundwork (admin dashboard feedback, 2026-10-21):

  1. invoice_payments — our own payment history table, one row per paid Stripe
     invoice. Written by the stripe-webhook edge function on every invoice.paid
     (going forward) and backfilled from Stripe by the billing-backfill edge
     function (historical invoices + refund state from the invoice's charge).
     RLS is enabled with no policies: deny-by-default for anon/authenticated.
     The admin dashboard reads it through an admin-only policy added in the
     tscopier-admin migrations. The service role (webhook / backfill) bypasses RLS.

  2. user_profiles.copier_pause_reason — records WHY the copier was paused so the
     admin dashboard can break paused users down by cause (user action, trial
     expiry, payment failure, subscription end). Written by every code path that
     sets copier_paused; cleared when the copier is resumed. Existing paused rows
     are backfilled by inference (subscriptions status) via billing-backfill.

  3. subscriptions.canceled_at — real cancellation date from Stripe, so the admin
     dashboard can group cancellations by month. Kept in sync by every code path
     that upserts the subscriptions row from Stripe; null while active.
*/

-- ---------------------------------------------------------------------------
-- 1. invoice_payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  stripe_invoice_id text NOT NULL UNIQUE,
  stripe_subscription_id text,
  amount_paid_cents integer NOT NULL,
  amount_refunded_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL DEFAULT 'paid'
    CHECK (status IN ('paid', 'partial_refund', 'refunded')),
  paid_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  refunded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.invoice_payments IS
  'One row per paid Stripe invoice (payment history). Written by stripe-webhook and billing-backfill.';

CREATE INDEX IF NOT EXISTS invoice_payments_user_id_idx
  ON public.invoice_payments (user_id);
CREATE INDEX IF NOT EXISTS invoice_payments_stripe_subscription_id_idx
  ON public.invoice_payments (stripe_subscription_id);
CREATE INDEX IF NOT EXISTS invoice_payments_paid_at_idx
  ON public.invoice_payments (paid_at DESC NULLS LAST);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: anon/authenticated reads are denied. The service role
-- (webhook, backfill) bypasses RLS. Admin read policy lives in tscopier-admin migrations.

-- ---------------------------------------------------------------------------
-- 2. user_profiles.copier_pause_reason
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS copier_pause_reason text;

DO $$
BEGIN
  ALTER TABLE public.user_profiles
    DROP CONSTRAINT IF EXISTS user_profiles_copier_pause_reason_check;
  ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_copier_pause_reason_check
    CHECK (
      copier_pause_reason IS NULL
      OR copier_pause_reason IN (
        'user_paused',        -- user paused from the app / assistant
        'trial_expired',      -- 5-day Advanced trial ended
        'payment_failed',     -- invoice payment failed / subscription past_due
        'subscription_ended', -- subscription canceled or expired in Stripe
        'admin',              -- paused by an admin action
        'unknown'             -- paused before this field existed / reason unclear
      )
    );
END $$;

COMMENT ON COLUMN public.user_profiles.copier_pause_reason IS
  'Why copier_paused is true (user_paused, trial_expired, payment_failed, subscription_ended, admin, unknown). Null while not paused.';

-- ---------------------------------------------------------------------------
-- 3. subscriptions.canceled_at
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

COMMENT ON COLUMN public.subscriptions.canceled_at IS
  'Cancellation timestamp from Stripe (subscriptions.canceled_at). Null while the subscription has not been canceled.';

CREATE INDEX IF NOT EXISTS subscriptions_canceled_at_idx
  ON public.subscriptions (canceled_at)
  WHERE canceled_at IS NOT NULL;
