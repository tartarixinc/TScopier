# Stripe subscription setup

This document covers TScopier Stripe billing, webhook sync, and soft paywall enforcement.

## Products and prices

Configure in the Stripe Dashboard (or via CLI) and store price IDs as Supabase Edge Function secrets:

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
| `STRIPE_BASIC_PRICE_ID` | Basic monthly |
| `STRIPE_BASIC_ANNUAL_PRICE_ID` | Basic annual |
| `STRIPE_ADVANCED_PRICE_ID` | Advanced monthly |
| `STRIPE_ADVANCED_ANNUAL_PRICE_ID` | Advanced annual |
| `STRIPE_EXTRA_ACCOUNT_PRICE_ID` | Extra broker account (Advanced) monthly |
| `STRIPE_EXTRA_ACCOUNT_ANNUAL_PRICE_ID` | Extra broker account annual |

## Webhook

**URL:** `https://sso.tscopier.ai/functions/v1/stripe-webhook`

**Events:**

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

`stripe-webhook` has `verify_jwt = false` in `supabase/config.toml` (Stripe uses signature verification instead).

On subscription updates, plan and `extra_accounts` are derived from Stripe line items (price IDs) and subscription metadata (`supabase_user_id`, `plan`, `extra_accounts`).

## Database

Table `subscriptions` (one row per user via `UNIQUE (user_id)`):

- `plan`: `basic` | `advanced`
- `status`: `active` | `trialing` | `canceled` | `past_due` | `incomplete`
- `extra_accounts`: Advanced add-on quantity
- `stripe_customer_id`, `stripe_subscription_id`, period/trial dates

Idempotency table: `stripe_events`.

Apply migrations including `20260527120000_subscriptions_user_id_unique.sql` before relying on webhook upserts.

### Admin access (`user_profiles`)

Migration `20260527140000_user_profiles_admin_subscription_status.sql` adds:

- `is_admin` (boolean, default `false`) — full app access without Stripe subscription
- `subscription_status` (text, nullable) — mirror of `subscriptions.status`, synced by trigger

Migration `20260605140000_user_profiles_admin_until.sql` adds:

- `admin_until` (timestamptz, nullable) — when set with `is_admin = true`, admin bypass expires at this time; `NULL` means permanent admin
- pg_cron job `expire-timed-admin-access` (every 5 minutes) sets `is_admin = false` when `admin_until` has passed

Users cannot self-promote to admin; a DB trigger resets `is_admin`, `admin_until`, and `subscription_status` on client updates. Set admin only via SQL Editor, service role, or backoffice `set_admin_access`:

```sql
-- Permanent admin
UPDATE public.user_profiles
SET is_admin = true, admin_until = NULL
WHERE user_id = '<uuid>';

-- Timed admin (expires automatically)
UPDATE public.user_profiles
SET is_admin = true, admin_until = '2026-07-01T00:00:00Z'
WHERE user_id = '<uuid>';
```

When timed admin expires, the user returns to **Free** plan behavior (paywall / subscription limits). Paid Stripe subscriptions are **not** canceled.

Admin bypass applies in the UI (`SubscriptionContext`), edge functions (`subscriptionAccess.ts`), and the trade worker.

Optional env on edge functions / worker: `TSCOPIER_ADMIN_USER_IDS` (comma-separated user UUIDs) for admin bypass without a DB row.

After changing `subscriptionAccess.ts`, redeploy affected edge functions (at minimum `backtest-run`):

```bash
supabase functions deploy backtest-run
```

## Customer portal

Edge function: `customer-portal` (JWT required).

Enable in Stripe Dashboard: plan changes, cancellation, payment method updates. Portal return URL defaults to `/billing`.

## Checkout flow

1. Authenticated user opens `/pricing` and starts checkout (`create-checkout-session`).
2. Checkout metadata includes `supabase_user_id`, `plan`, `extra_accounts`.
3. Subscription metadata mirrors checkout metadata for portal updates.
4. Advanced plan: 10-day trial (`trial_period_days = 10`).
5. Success redirect: `/dashboard?checkout=success` (SubscriptionContext refreshes).

## Soft paywall (plan limits)

| Feature | Basic | Advanced |
|---------|-------|----------|
| Broker accounts | 1 | 5 + extra (max 100 total) |
| Telegram channels | 5 | Unlimited |
| Backtests / month | 5 | Unlimited |
| TP distribution rows | 3 | Unlimited |
| Multi/range trading, auto BE, RR modes, keyword filters | Blocked | Allowed |

**UI:** `FeatureGate`, `UpgradePrompt`, dashboard banner when no active plan or past due.

**Server:** `broker-metatrader` register, `backtest-run`, worker `handleSignal` (subscription + advanced manual settings).

`past_due` is treated as inactive for feature gates; billing page links to Customer Portal.

## Manual smoke test checklist

1. **New user** — dashboard loads; subscribe banner visible; broker/channel/backtest actions blocked with upgrade prompt.
2. **Basic checkout** — complete test checkout; `subscriptions` row `plan=basic`, `status=active` or `trialing`.
3. **Second broker on Basic** — UI + `broker-metatrader` register return limit error.
4. **Advanced trial** — extra accounts editor on `/billing` works; limits expand.
5. **Portal cancel** — webhook sets `status=canceled`; Advanced settings blocked again.
6. **Backtest limit** — sixth run in UTC month on Basic rejected by `backtest-run`.

### Stripe test card

Use `4242 4242 4242 4242`, any future expiry, any CVC, any billing postal code.

## Deploy

```bash
supabase db push
supabase functions deploy stripe-webhook create-checkout-session customer-portal update-extra-accounts
supabase functions deploy backtest-run broker-metatrader
# Redeploy worker for subscription execution gates
```

## Expected row after checkout

```json
{
  "user_id": "<uuid>",
  "plan": "basic",
  "status": "active",
  "extra_accounts": 0,
  "stripe_customer_id": "cus_...",
  "stripe_subscription_id": "sub_..."
}
```
