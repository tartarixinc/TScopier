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
