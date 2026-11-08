import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../../supabase/migrations/20261104225506_subscribe_social_copy_intent.sql', import.meta.url),
  'utf8',
)
const billingMigration = readFileSync(
  new URL('../../supabase/migrations/20261108094829_social_copy_billing_stripe.sql', import.meta.url),
  'utf8',
)
const modal = readFileSync(new URL('../components/social/CopyTraderModal.tsx', import.meta.url), 'utf8')

test('subscribe_social_copy_intent only accepts approved paid providers and rejects self-pay', () => {
  assert.match(migration, /create or replace function public\.subscribe_social_copy_intent\(p_provider_user_id uuid\)/)
  assert.match(migration, /security definer/)
  assert.match(migration, /p_provider_user_id = v_actor/)
  assert.match(migration, /You cannot subscribe to your own provider profile/)
  assert.match(migration, /sp\.provider_status = 'approved'/)
  assert.match(migration, /sp\.is_listed = true/)
  assert.match(migration, /v_price is null or v_price <= 0/)
  assert.match(migration, /This provider is free to copy/)
  assert.match(migration, /status = 'pending'/)
  assert.match(migration, /insert into public\.wallet_ledger/)
  assert.match(migration, /insert into public\.user_wallets/)
  assert.match(migration, /grant execute on function public\.subscribe_social_copy_intent\(uuid\) to authenticated/)
  assert.doesNotMatch(migration, /grant execute[\s\S]*to anon/)
})

test('pending wallet_ledger rows are de-duplicated per payer and provider', () => {
  assert.match(migration, /wl\.payer_user_id = v_actor/)
  assert.match(migration, /wl\.provider_user_id = p_provider_user_id/)
  assert.match(migration, /wl\.status = 'pending'/)
  assert.match(migration, /if v_existing is not null then\s+return v_existing;/s)
})

test('create_social_copy_subscription requires active social_copy_billing for paid providers', () => {
  assert.match(billingMigration, /create table if not exists public\.social_copy_billing/)
  assert.match(billingMigration, /has_active_social_copy_billing/)
  assert.match(billingMigration, /An active paid subscription is required before copying this provider/)
  assert.match(billingMigration, /stripe_connect_charges_enabled/)
  assert.match(billingMigration, /Connect Stripe payouts before setting a paid copy price/)
})

test('copy modal gates paid providers behind Stripe Checkout before destination sizing', () => {
  assert.match(modal, /isPaidCopyPrice/)
  assert.match(modal, /useState\(!pricePaid\)/)
  assert.match(modal, /showPaywall = pricePaid && !paywallCleared/)
  assert.match(modal, /startSocialCopyCheckout/)
  assert.match(modal, /paywallSubscribe/)
  assert.match(modal, /c\.startCopying/)
  assert.match(modal, /destinationOptions=\{destinations\}/)
  assert.match(modal, /const \[paywallCleared, setPaywallCleared\] = useState\(!pricePaid\)/)
  assert.doesNotMatch(modal, /subscribeSocialCopyIntent\(supabase, trader\.id\)/)
  const paywallBranch = modal.indexOf('if (showPaywall)')
  const configureModal = modal.indexOf('<SlaveConfigureModal')
  assert.ok(paywallBranch >= 0 && configureModal > paywallBranch, 'destination UI follows the paywall branch')
})
