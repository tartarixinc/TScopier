import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(new URL('../../supabase/migrations/20261028120000_social_diagnostics_notifications.sql', import.meta.url), 'utf8')

test('diagnostics preserve every canonical eligibility blocker in deterministic order', () => {
  const reasons = ['source_missing', 'source_not_published', 'synthetic_preview_disabled', 'source_unsupported', 'account_mode_unknown', 'source_inactive', 'sync_failed', 'source_disconnected', 'sync_pending', 'history_stale', 'history_incomplete', 'minimum_trades_not_met', 'minimum_period_not_met']
  let previous = -1
  for (const reason of reasons) {
    const position = migration.indexOf(reason)
    assert.ok(position > previous, `${reason} must follow the canonical order`)
    previous = position
  }
  assert.match(migration, /interval '15 minutes'/)
  assert.match(migration, /closed_count < 10/)
  assert.match(migration, /interval '7 days'/)
  assert.match(migration, /eligibility_diagnostics jsonb/)
  assert.doesNotMatch(migration, /returns table \(source_id uuid, broker_account_id/)
})

test('social notifications are private, persistent, and use stable deduplication keys', () => {
  assert.match(migration, /enable row level security/)
  assert.match(migration, /using \(user_id = auth\.uid\(\)\)/)
  assert.match(migration, /unique \(user_id, event_key\)/)
  assert.match(migration, /on conflict \(user_id, event_key\) do nothing/g)
  assert.match(migration, /grant update \(read_at\)/)
})

test('events are produced only by accepted or acknowledged state transitions', () => {
  assert.match(migration, /v_transition := old\.status is distinct from 'accepted'/)
  assert.match(migration, /new\.status = 'accepted' and v_transition/)
  assert.match(migration, /new\.status = 'active'.*old\.status is distinct from 'active'/s)
  assert.match(migration, /new\.source_trader_user_id, new\.subscriber_user_id, 'social_copy_activated'/)
  assert.match(migration, /new\.status in \('stopped', 'emergency_stopped'\)/)
  assert.match(migration, /new\.status = 'error'.*new\.subscriber_user_id/s)
  assert.doesNotMatch(migration, /create_social_copy_subscription[\s\S]*insert into public\.in_app_notifications/)
})
