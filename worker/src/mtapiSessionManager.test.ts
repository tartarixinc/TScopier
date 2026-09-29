import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptMtPassword, encryptMtPassword } from './brokerCredentialsCrypto'
import type { MtapiProvider } from './mtapiProvider'
import { MtapiSessionManager } from './mtapiSessionManager'

const oldBase = process.env.MTAPI_BASE_URL
const oldKey = process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY

afterEach(() => {
  if (oldBase == null) delete process.env.MTAPI_BASE_URL
  else process.env.MTAPI_BASE_URL = oldBase
  if (oldKey == null) delete process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY
  else process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = oldKey
})

test('credential encryption round-trips without embedding plaintext', () => {
  process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = 'phase-2-test-key'
  const encrypted = encryptMtPassword('broker-secret')
  assert.ok(encrypted)
  assert.equal(encrypted?.includes('broker-secret'), false)
  assert.equal(decryptMtPassword(encrypted), 'broker-secret')
})

test('startup reconciles known sessions and starts token health checks', async () => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
  const rows = [{
    id: 'broker-1',
    mtapi_session_id: 'token-1',
    account_login: '123',
    broker_server: 'Server',
    platform: 'MT5',
    broker_password_encrypted: null,
    auto_reconnect_enabled: false,
  }]
  const query = {
    select() { return this },
    eq() { return this },
    is() { return this },
    not() { return this },
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve)
    },
  }
  const supabase = { from: () => query } as unknown as SupabaseClient
  const seeded: string[] = []
  const checked: string[] = []
  const reconciled: Array<{ ids: string[]; dryRun: boolean; platform: string }> = []
  let recoveryWasConfigured = false
  const provider = {
    setRecoveryHandler(handler: unknown) {
      if (handler) recoveryWasConfigured = true
    },
    seedPlatformCache(id: string) { seeded.push(id) },
    async ensureConnected(id: string) { checked.push(id) },
    async disconnectOrphans(ids: string[], dryRun: boolean, platform: string) {
      reconciled.push({ ids, dryRun, platform })
    },
  } as unknown as MtapiProvider

  const manager = new MtapiSessionManager(supabase, provider)
  await manager.start()
  manager.stop()

  assert.deepEqual(seeded, ['token-1', 'token-1'])
  assert.deepEqual(checked, ['token-1'])
  assert.equal(recoveryWasConfigured, true)
  assert.deepEqual(reconciled, [
    { ids: ['token-1'], dryRun: true, platform: 'MT5' },
    { ids: ['token-1'], dryRun: false, platform: 'MT5' },
  ])
})

test('provisioning loses activation race without persisting or leaking the new session', async () => {
  process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = 'phase-4c-race-key'
  const row = {
    id: 'broker-race',
    provider: 'mtapi',
    mtapi_session_id: null,
    fxsocket_account_id: 'fx-preserved',
    metaapi_account_id: null,
    writer_epoch: 4,
    provider_transition_state: 'stable',
    account_login: '123',
    broker_server: 'Server',
    platform: 'MT5',
    broker_password_encrypted: encryptMtPassword('secret'),
    connection_status: 'pending',
    performance_baseline_balance: null,
  }
  let fromCalls = 0
  const supabase = {
    from() {
      fromCalls += 1
      if (fromCalls === 1) {
        const query = {
          select() { return this },
          eq() { return this },
          is() { return this },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({ data: [row], error: null }).then(resolve)
          },
        }
        return query
      }
      return {
        update() { return this },
        eq() { return this },
        is() { return this },
        select() { return this },
        maybeSingle() { return Promise.resolve({ data: null, error: null }) },
      }
    },
  } as unknown as SupabaseClient
  const disconnected: string[] = []
  const provider = {
    async connectEx() { return 'new-mtapi-session' },
    async disconnect(id: string) { disconnected.push(id) },
  } as unknown as MtapiProvider

  const manager = new MtapiSessionManager(supabase, provider) as unknown as {
    provisionNewAccounts(): Promise<void>
  }
  await manager.provisionNewAccounts()

  assert.deepEqual(disconnected, ['new-mtapi-session'])
})
