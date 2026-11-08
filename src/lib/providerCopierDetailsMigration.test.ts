import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../../supabase/migrations/20261108093835_provider_copier_details.sql', import.meta.url),
  'utf8',
)

test('provider copier details RPC exposes balance equity and risk for owned subscriptions', () => {
  assert.match(migration, /create or replace function public\.get_provider_copier_details\(p_subscription_id uuid\)/)
  assert.match(migration, /destination_balance numeric/)
  assert.match(migration, /destination_equity numeric/)
  assert.match(migration, /manual_settings jsonb/)
  assert.match(migration, /s\.source_trader_user_id = v_actor/)
  assert.match(migration, /grant execute on function public\.get_provider_copier_details\(uuid\) to authenticated/)
})

test('copy activation and stop notifications open copier details instead of subscriber profiles', () => {
  assert.match(migration, /\/social-trading\/provider\/copiers\/' \|\| new\.id::text/)
  assert.match(migration, /event_type in \('social_copy_activated', 'social_copy_stopped'\)/)
  assert.doesNotMatch(
    migration,
    /social_copy_activated[\s\S]*'\/social-trading\/' \|\| new\.subscriber_user_id/,
  )
})
