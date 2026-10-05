import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptMtPassword, encryptMtPassword } from './brokerCredentialsCrypto'
import { MtapiApiError, type MtapiProvider } from './mtapiProvider'
import { MtapiSessionManager, mtapiFailureDetail, mtapiFailureSummary, resolveIntervalMs } from './mtapiSessionManager'

const oldBase = process.env.MTAPI_BASE_URL
const oldKey = process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY
const oldMt4Url = process.env.MTAPI_MT4_BASE_URL
const oldMt5Url = process.env.MTAPI_MT5_BASE_URL
const oldSweepConcurrency = process.env.MTAPI_SESSION_HEALTH_CONCURRENCY
const oldSweepGap = process.env.MTAPI_SESSION_HEALTH_GAP_MS

afterEach(() => {
  if (oldBase == null) delete process.env.MTAPI_BASE_URL
  else process.env.MTAPI_BASE_URL = oldBase
  if (oldKey == null) delete process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY
  else process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = oldKey
  if (oldMt4Url == null) delete process.env.MTAPI_MT4_BASE_URL
  else process.env.MTAPI_MT4_BASE_URL = oldMt4Url
  if (oldMt5Url == null) delete process.env.MTAPI_MT5_BASE_URL
  else process.env.MTAPI_MT5_BASE_URL = oldMt5Url
  if (oldSweepConcurrency == null) delete process.env.MTAPI_SESSION_HEALTH_CONCURRENCY
  else process.env.MTAPI_SESSION_HEALTH_CONCURRENCY = oldSweepConcurrency
  if (oldSweepGap == null) delete process.env.MTAPI_SESSION_HEALTH_GAP_MS
  else process.env.MTAPI_SESSION_HEALTH_GAP_MS = oldSweepGap
})

function sweepRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `broker-${i}`,
    mtapi_session_id: `token-${i}`,
    account_login: '123',
    broker_server: 'Server',
    platform: 'MT5',
    broker_password_encrypted: null,
    auto_reconnect_enabled: false,
  }))
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

function sweepSupabase(rows: unknown[]) {
  const query = {
    select() { return this },
    eq() { return this },
    is() { return this },
    not() { return this },
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve)
    },
  }
  return { from: () => query } as unknown as SupabaseClient
}

test('credential encryption round-trips without embedding plaintext', () => {
  process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = 'phase-2-test-key'
  const encrypted = encryptMtPassword('broker-secret')
  assert.ok(encrypted)
  assert.equal(encrypted?.includes('broker-secret'), false)
  assert.equal(decryptMtPassword(encrypted), 'broker-secret')
})

test('bridge rejection codes carry plain-English detail, unknown codes stay bare', () => {
  assert.equal(mtapiFailureDetail('INVALID_ACCOUNT'), 'invalid login or password')
  assert.equal(mtapiFailureSummary('INVALID_ACCOUNT'), 'invalid login or password')
  assert.equal(mtapiFailureDetail('HTTP_500'), '')
  assert.equal(mtapiFailureSummary('HTTP_500'), 'HTTP_500')
  assert.equal(mtapiFailureDetail(''), '')
  assert.equal(mtapiFailureSummary(''), '')
  // A code that collides with Object.prototype must not resolve to a function.
  assert.equal(mtapiFailureDetail('toString'), '')
  assert.equal(mtapiFailureDetail('constructor'), '')
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

test('orphan reconciliation skips MT4 because the MT4 bridge has no bulk cleanup', async () => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
  process.env.MTAPI_MT4_BASE_URL = 'https://mt4.test'
  process.env.MTAPI_MT5_BASE_URL = 'https://mt5.test'
  const rows = [{
    id: 'broker-1',
    mtapi_session_id: 'mt4-token',
    account_login: '123',
    broker_server: 'Server',
    platform: 'MT4',
    broker_password_encrypted: null,
    auto_reconnect_enabled: false,
  }, {
    id: 'broker-2',
    mtapi_session_id: 'mt5-token',
    account_login: '456',
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
  const reconciled: Array<{ ids: string[]; dryRun: boolean; platform: string }> = []
  const provider = {
    setRecoveryHandler() { },
    seedPlatformCache() { },
    async ensureConnected() { },
    async disconnectOrphans(ids: string[], dryRun: boolean, platform: string) {
      reconciled.push({ ids, dryRun, platform })
    },
  } as unknown as MtapiProvider

  const manager = new MtapiSessionManager(supabase, provider)
  await manager.start()
  manager.stop()

  assert.deepEqual(reconciled, [
    { ids: ['mt5-token'], dryRun: true, platform: 'MT5' },
    { ids: ['mt5-token'], dryRun: false, platform: 'MT5' },
  ])
})

test('resolveIntervalMs falls back on empty or malformed values and clamps finite ones', () => {
  // Empty / missing → the default, never the floor (a blank Railway var must
  // not turn the health sweep into a 30 s loop).
  assert.equal(resolveIntervalMs(undefined, 15_000, 5_000), 15_000)
  assert.equal(resolveIntervalMs('', 15_000, 5_000), 15_000)
  assert.equal(resolveIntervalMs('   ', 15_000, 5_000), 15_000)
  // Malformed → the default, never 1 ms.
  assert.equal(resolveIntervalMs('15000ms', 15_000, 5_000), 15_000)
  assert.equal(resolveIntervalMs('Infinity', 15_000, 5_000), 15_000)
  // Finite values are honoured, trimmed, and clamped at the floor.
  assert.equal(resolveIntervalMs('15000', 15_000, 5_000), 15_000)
  assert.equal(resolveIntervalMs(' 20000 ', 15_000, 5_000), 20_000)
  assert.equal(resolveIntervalMs('1000', 15_000, 5_000), 5_000)
  assert.equal(resolveIntervalMs('0', 15_000, 5_000), 5_000)
  // Absurd values: Node clamps any delay above 2^31-1 to 1 ms, so they must
  // fall back to the default instead.
  assert.equal(resolveIntervalMs('1e12', 15_000, 5_000), 15_000)
  assert.equal(resolveIntervalMs('9999999999999', 15_000, 5_000), 15_000)
})

test('orphan reconciliation protects prepared MTAPI sessions on FXSocket accounts', async () => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
  process.env.MTAPI_MT4_BASE_URL = 'https://mt4.test'
  process.env.MTAPI_MT5_BASE_URL = 'https://mt5.test'
  const activeRows = [{
    id: 'broker-active',
    provider: 'mtapi',
    mtapi_session_id: 'active-token',
    platform: 'MT5',
  }]
  const allSessionRows = [{
    id: 'broker-prepared',
    provider: 'fxsocket',
    mtapi_session_id: 'prepared-token',
    platform: 'MT5',
  }, ...activeRows]
  let fromCalls = 0
  const supabase = {
    from() {
      fromCalls += 1
      const data = fromCalls === 1 ? activeRows : fromCalls === 2 ? allSessionRows : []
      return {
        select() { return this },
        update() { return this },
        eq() { return this },
        is() { return this },
        not() { return this },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data, error: null }).then(resolve)
        },
      }
    },
  } as unknown as SupabaseClient
  const reconciled: Array<{ ids: string[]; dryRun: boolean; platform: string }> = []
  const provider = {
    setRecoveryHandler() { },
    seedPlatformCache() { },
    async ensureConnected() { },
    async accountSummary() { return {} },
    async disconnectOrphans(ids: string[], dryRun: boolean, platform: string) {
      reconciled.push({ ids, dryRun, platform })
    },
  } as unknown as MtapiProvider

  const manager = new MtapiSessionManager(supabase, provider)
  await manager.start()
  manager.stop()

  assert.deepEqual(reconciled, [
    { ids: ['prepared-token', 'active-token'], dryRun: true, platform: 'MT5' },
    { ids: ['prepared-token', 'active-token'], dryRun: false, platform: 'MT5' },
  ])
})

test('a rejected provision stores plain-English connection_error and logs the detail', async () => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
  process.env.MTAPI_MT4_BASE_URL = 'https://mt4.test'
  process.env.MTAPI_MT5_BASE_URL = 'https://mt5.test'
  process.env.BROKER_CREDENTIALS_ENCRYPTION_KEY = 'phase-2-test-key'
  const rows = [{
    id: 'broker-1',
    mtapi_session_id: null,
    account_login: '123',
    broker_server: 'Server',
    platform: 'MT5',
    broker_password_encrypted: encryptMtPassword('broker-secret'),
    auto_reconnect_enabled: true,
    connection_status: 'pending',
    performance_baseline_balance: null,
  }]
  const updates: Array<Record<string, unknown>> = []
  const query = {
    select() { return this },
    update(payload: Record<string, unknown>) { updates.push(payload); return this },
    eq() { return this },
    is() { return this },
    not() { return this },
    then(resolve: (value: unknown) => unknown) {
      return Promise.resolve({ data: rows, error: null }).then(resolve)
    },
  }
  const supabase = { from: () => query } as unknown as SupabaseClient
  const provider = {
    setRecoveryHandler() {},
    seedPlatformCache() {},
    async ensureConnected() {},
    async disconnectOrphans() {},
    async connectEx() { throw new MtapiApiError('rejected', 201, 'INVALID_ACCOUNT') },
  } as unknown as MtapiProvider

  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const manager = new MtapiSessionManager(supabase, provider)
    await manager.start()
    manager.stop()
  } finally {
    console.warn = originalWarn
  }

  const stored = updates.find((u) => typeof u.connection_error === 'string')
  assert.equal(stored?.connection_error, 'MTAPI connect failed: invalid login or password')
  assert.ok(
    warnings.some((w) => w.includes('code=INVALID_ACCOUNT detail=invalid login or password')),
    'expected the provision failure log to carry the plain-English detail'
  )
})

test('health sweep bounds concurrent bridge checks instead of firing all sessions at once', async () => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
  process.env.MTAPI_SESSION_HEALTH_CONCURRENCY = '2'
  process.env.MTAPI_SESSION_HEALTH_GAP_MS = '0'
  const rows = sweepRows(6)
  const supabase = sweepSupabase(rows)
  let active = 0
  let maxActive = 0
  const checked: string[] = []
  const provider = {
    setRecoveryHandler() {},
    seedPlatformCache() {},
    async ensureConnected(id: string) {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>(resolve => setTimeout(resolve, 5))
      active -= 1
      checked.push(id)
    },
    async disconnectOrphans() {},
  } as unknown as MtapiProvider

  const manager = new MtapiSessionManager(supabase, provider)
  await manager.start()
  // The initial sweep is intentionally fire-and-forget (it must not delay the
  // trade executor), so wait for it to drain before asserting.
  await waitFor(() => checked.length === 6).catch(() => undefined)
  manager.stop()

  assert.equal(checked.length, 6)
  assert.ok(maxActive <= 2, `expected at most 2 concurrent checks, saw ${maxActive}`)
})

test('health sweep paces request starts by the configured gap', async () => {
  process.env.MTAPI_BASE_URL = 'https://mtapi.test'
  process.env.MTAPI_SESSION_HEALTH_CONCURRENCY = '1'
  process.env.MTAPI_SESSION_HEALTH_GAP_MS = '50'
  const rows = sweepRows(3)
  const supabase = sweepSupabase(rows)
  const starts: number[] = []
  const provider = {
    setRecoveryHandler() {},
    seedPlatformCache() {},
    async ensureConnected() { starts.push(Date.now()) },
    async disconnectOrphans() {},
  } as unknown as MtapiProvider

  const manager = new MtapiSessionManager(supabase, provider)
  await manager.start()
  await waitFor(() => starts.length === 3).catch(() => undefined)
  manager.stop()

  assert.equal(starts.length, 3)
  // Each gap is jittered to 0.5x-1.5x the base, so two gaps take at least
  // 50ms; assert a conservative lower bound to avoid timer flakiness.
  assert.ok(
    starts[2] - starts[0] >= 40,
    `expected paced starts (>=40ms apart), saw span ${starts[2] - starts[0]}ms`,
  )
})
