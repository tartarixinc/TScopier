import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../../supabase/migrations/20261027110000_social_full_flow_preview.sql', import.meta.url),
  'utf8',
)
const worker = readFileSync(new URL('../../worker/src/socialCopyMonitor.ts', import.meta.url), 'utf8')

test('captures exact source and destination modes without a Demo-only source rule', () => {
  assert.match(migration, /source_account_mode text not null/)
  assert.match(migration, /destination_account_mode text not null/)
  assert.match(migration, /v_source_mode not in \('demo', 'live'\)/)
  assert.match(migration, /p_requested_account_mode <> v_destination_mode/)
  assert.doesNotMatch(migration, /when sc\.account_mode <> 'demo'/)
})

test('keeps ownership, sharing, provider, connection, follow, and history authorization', () => {
  assert.match(migration, /destination_account\.user_id = s\.subscriber_user_id/)
  assert.match(migration, /src\.status = 'published'/)
  assert.match(migration, /provider.*\('fxsocket', 'mtapi'\)/s)
  assert.match(migration, /connection_status.*\('connected', 'healthy'\)/s)
  assert.match(migration, /r\.status = 'accepted'/)
  assert.match(migration, /minimum_trades_not_met/)
  assert.match(migration, /minimum_period_not_met/)
})

test('synthetic participation is server-controlled and broker-isolated', () => {
  assert.match(migration, /allow_synthetic_participants boolean not null default false/)
  assert.match(migration, /execution_path = 'synthetic_simulation'/)
  assert.match(worker, /SOCIAL_COPY_SYNTHETIC_SIMULATION_ENABLED/)
  assert.match(worker, /broker_orders_created: 0/)
  const simulationBranch = worker.slice(worker.indexOf('if (syntheticSimulation)'))
  assert.ok(simulationBranch.indexOf('return') < simulationBranch.indexOf('const sourceApi'))
})

test('public discovery returns masked routing data and no broker account id or credentials', () => {
  const discovery = migration.slice(
    migration.indexOf('create function public.get_social_copy_sources'),
    migration.indexOf('create or replace function public.reject_synthetic_social_copy_subscription'),
  )
  assert.match(discovery, /account_hint/)
  assert.match(discovery, /right\(btrim\(b\.account_login\), 4\)/)
  const publicSignature = discovery.slice(0, discovery.indexOf('language sql'))
  assert.doesNotMatch(publicSignature, /broker_account_id|password|token|credential|secret/i)
})
