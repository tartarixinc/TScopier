import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { UserListener } from './userListener'
import { isGramjsUpdateLoopTimeout } from './gramjsLogSuppress'

/**
 * Regression tests for the 2026-09-29 incident:
 *  - the `_updateLoop` TIMEOUT recovery path was gated on `isConnected`, so a
 *    dead connection was never repaired;
 *  - discarded clients were only disconnected, never destroyed, so their
 *    gramjs update loop kept pinging a dead socket forever;
 *  - a revoked session (AUTH_KEY_UNREGISTERED) was retried every 30s forever
 *    instead of surfacing a re-link.
 */

class FakeClient {
  onError: ((err: Error) => Promise<void> | void) | null = null
  destroyed = false
  disconnects = 0
  connects = 0
  invokeResult: unknown = {}
  invokeImpl: (() => Promise<unknown>) | null = null
  session = { save: (): string => 'saved-session' }

  async connect(): Promise<void> {
    this.connects += 1
  }

  async disconnect(): Promise<void> {
    this.disconnects += 1
  }

  async destroy(): Promise<void> {
    this.destroyed = true
    this.disconnects += 1
  }

  async invoke(): Promise<unknown> {
    if (this.invokeImpl) return this.invokeImpl()
    return this.invokeResult
  }
}

function makeSupabase(): never {
  const builder: Record<string | symbol, unknown> = {}
  const proxy = new Proxy(builder, {
    get: (_t, prop) => {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve({ data: null, error: null })
      }
      return () => proxy
    },
  })
  return { from: () => proxy, removeChannel: async () => {} } as never
}

function makeListener(opts?: { clientFactory?: () => FakeClient }): {
  listener: UserListener
  client: FakeClient
  health: Array<{ reason: string; opts?: Record<string, unknown> }>
} {
  const client = new FakeClient()
  const health: Array<{ reason: string; opts?: Record<string, unknown> }> = []
  const listener = opts?.clientFactory
    ? new UserListener('user-test', 'saved-session', makeSupabase(), undefined, undefined, () => {
        return opts.clientFactory!() as never
      })
    : new UserListener('user-test', 'saved-session', makeSupabase(), client as never)
  const internal = listener as unknown as {
    updateHealth: (reason: string, o?: Record<string, unknown>) => void
    requestReconnect: (reason: string) => Promise<void>
    forceReconnect: (reason: string, cycleId: string) => Promise<void>
    noteSessionRevoked: (source: string, err: unknown) => void
    runWatchdog: () => Promise<void>
    sessionRevoked: boolean
    isConnected: boolean
    warmEntityCache: () => Promise<void>
    refreshChannelSubscription: () => Promise<void>
    runRecentCatchUp: () => Promise<void>
  }
  internal.updateHealth = (reason, o) => { health.push({ reason, opts: o }) }
  internal.warmEntityCache = async () => {}
  internal.refreshChannelSubscription = async () => {}
  internal.runRecentCatchUp = async () => {}
  return { listener, client, health }
}

describe('userListener update-loop recovery', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.cooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    savedEnv.jitter = process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS
    savedEnv.authMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS = '0'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
  })

  afterEach(() => {
    for (const [key, value] of Object.entries({
      TELEGRAM_RECONNECT_COOLDOWN_MS: savedEnv.cooldown,
      TELEGRAM_RECONNECT_JITTER_MAX_MS: savedEnv.jitter,
      TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS: savedEnv.authMax,
    })) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('requests a reconnect for an update-loop TIMEOUT even while marked disconnected', async () => {
    const { listener, client } = makeListener()
    const internal = listener as unknown as {
      isConnected: boolean
      requestReconnect: (reason: string) => Promise<void>
    }
    const reasons: string[] = []
    internal.requestReconnect = async (reason: string) => { reasons.push(reason) }
    // The exact production state: the ping failed, so the connection is already
    // flagged as down before the error handler runs.
    internal.isConnected = false

    await client.onError!(new Error('TIMEOUT'))

    assert.deepEqual(reasons, ['update_loop_timeout'])
  })

  it('ignores unrelated errors', async () => {
    const { listener, client } = makeListener()
    const internal = listener as unknown as {
      requestReconnect: (reason: string) => Promise<void>
    }
    const reasons: string[] = []
    internal.requestReconnect = async (reason: string) => { reasons.push(reason) }

    await client.onError!(new Error('something else'))

    assert.deepEqual(reasons, [])
  })

  it('waits for the reconnect cycle to finish instead of detaching from it', async () => {
    const { listener, client } = makeListener()
    const internal = listener as unknown as {
      requestReconnect: (reason: string) => Promise<void>
    }
    let finished = false
    internal.requestReconnect = async () => {
      await new Promise(r => setTimeout(r, 40))
      finished = true
    }

    await client.onError!(new Error('TIMEOUT'))

    // The pre-fix code fired the reconnect without awaiting it, so gramjs's
    // update loop kept pinging the dead socket in parallel with the recovery.
    assert.equal(finished, true, 'TIMEOUT handler must await the reconnect cycle')
  })

  it('disconnects but never destroys a client it intends to reuse', async () => {
    const { listener, client } = makeListener()
    const internal = listener as unknown as {
      forceReconnect: (reason: string, cycleId: string) => Promise<void>
    }

    await internal.forceReconnect('update_loop_timeout', 'cycle-reuse')

    // destroy() would set _destroyed on the SAME object we are about to
    // connect() again, permanently killing its update loop (gramjs starts the
    // loop only once, guarded by _loopStarted).
    assert.equal(client.destroyed, false, 'a reused client must not be destroyed')
    assert.ok(client.disconnects >= 1, 'the reused client must be disconnected first')
    assert.ok(client.connects >= 1, 'the client must be reconnected')
    assert.equal((listener as unknown as { isConnected: boolean }).isConnected, true)
  })

  it('does not kick a reconnect from the lease-renew path once revoked', () => {
    const { listener } = makeListener()
    const internal = listener as unknown as {
      sessionRevoked: boolean
      isConnected: boolean
      requestReconnect: (reason: string) => Promise<void>
      requestReconnectIfDisconnected: (reason?: string) => void
    }
    const reasons: string[] = []
    internal.requestReconnect = async (reason: string) => { reasons.push(reason) }
    internal.isConnected = false
    internal.sessionRevoked = true

    internal.requestReconnectIfDisconnected('lease_renew_disconnected')

    assert.deepEqual(reasons, [], 'a revoked session must not be reconnected')
  })

  it('refuses to promise a connection once revoked', async () => {
    const { listener } = makeListener()
    const internal = listener as unknown as {
      sessionRevoked: boolean
      ensureTelegramConnected: (reason?: string) => Promise<void>
    }
    internal.sessionRevoked = true

    await assert.rejects(
      () => internal.ensureTelegramConnected('ensure'),
      /Reconnect Telegram to resume copying/,
    )
  })

  it('still honours the reconnect cooldown when the jitter env is malformed', async () => {
    process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS = 'not-a-number'
    const { listener } = makeListener()
    const internal = listener as unknown as {
      requestReconnect: (reason: string) => Promise<void>
      forceReconnect: (reason: string, cycleId: string) => Promise<void>
      lastReconnectEndedAt: number
    }
    // Measure the delay only: forceReconnect has a cooldown of its own, which
    // would mask a skipped delay, so it is stubbed out here.
    internal.forceReconnect = async () => {}
    // Seed so the elapsed term equals the full cooldown (500ms in beforeEach)
    // and the measured wait is deterministic regardless of the random jitter.
    internal.lastReconnectEndedAt = Date.now()

    const startedAt = Date.now()
    await internal.requestReconnect('update_loop_timeout')
    const elapsedMs = Date.now() - startedAt

    // A non-numeric env value used to parse as NaN, `NaN > 0` is false, and the
    // whole delay was skipped — the cooldown protection disappeared silently.
    assert.ok(elapsedMs >= 450, `expected the delay to be honoured, waited ${elapsedMs}ms`)
  })

  it('destroys the client on stop so its update loop stops', async () => {
    const { listener, client } = makeListener()
    await listener.stop()
    assert.equal(client.destroyed, true)
  })

  it('falls back to disconnect when destroy fails on stop', async () => {
    const { listener, client } = makeListener()
    client.destroy = async () => { throw new Error('destroy failed') }
    await listener.stop()
    assert.equal(client.destroyed, false)
    assert.equal(client.disconnects, 1)
  })

  it('destroys the discarded client when forceReconnect replaces it', async () => {
    const oldClient = new FakeClient()
    let created = 0
    const { listener } = makeListener({
      clientFactory: () => {
        created += 1
        return created === 1 ? oldClient : new FakeClient()
      },
    })
    const internal = listener as unknown as {
      forceReconnect: (reason: string, cycleId: string) => Promise<void>
    }

    await internal.forceReconnect('malformed_rpc_result', 'test-cycle')

    assert.equal(oldClient.destroyed, true)
  })

  it('marks a revoked session and blocks every further reconnect', async () => {
    const { listener, health } = makeListener()
    const internal = listener as unknown as {
      sessionRevoked: boolean
      requestReconnect: (reason: string) => Promise<void>
      forceReconnect: (reason: string, cycleId: string) => Promise<void>
      noteSessionRevoked: (source: string, err: unknown) => void
    }
    let forced = 0
    internal.forceReconnect = async () => { forced += 1 }

    internal.noteSessionRevoked('watchdog_probe', new Error('401: AUTH_KEY_UNREGISTERED'))
    assert.equal(internal.sessionRevoked, true)

    await internal.requestReconnect('update_loop_timeout')
    assert.equal(forced, 0, 'revoked session must not be reconnected')
    assert.equal(health.at(-1)?.reason, 'telegram_session_revoked')
    assert.equal(health.at(-1)?.opts?.sessionInvalid, true)
    assert.equal(health.at(-1)?.opts?.recoveryExhausted, true)
  })

  it('treats a watchdog probe returning AUTH_KEY_UNREGISTERED as revoked, not as a retry', async () => {
    const { listener, client } = makeListener()
    const internal = listener as unknown as {
      sessionRevoked: boolean
      runWatchdog: () => Promise<void>
      requestReconnect: (reason: string) => Promise<void>
    }
    const reasons: string[] = []
    internal.requestReconnect = async (reason: string) => { reasons.push(reason) }
    client.invokeImpl = async () => {
      throw new Error('401: AUTH_KEY_UNREGISTERED (caused by updates.GetState)')
    }

    await internal.runWatchdog()

    assert.equal(internal.sessionRevoked, true)
    assert.deepEqual(reasons, [])
  })

  it('stops probing entirely once the session is revoked', async () => {
    const { listener, client } = makeListener()
    const internal = listener as unknown as {
      sessionRevoked: boolean
      runWatchdog: () => Promise<void>
    }
    let invokes = 0
    client.invokeImpl = async () => { invokes += 1; return {} }
    internal.sessionRevoked = true

    await internal.runWatchdog()

    assert.equal(invokes, 0)
  })
})

describe('gramjs update-loop timeout detection', () => {
  it('matches a gramjs TIMEOUT with an updates.js stack', () => {
    const err = new Error('TIMEOUT')
    err.stack = 'Error: TIMEOUT\n    at /app/node_modules/telegram/client/updates.js:250:85'
    assert.equal(isGramjsUpdateLoopTimeout(err), true)
  })

  it('does not match our own TIMEOUT errors', () => {
    const err = new Error('TIMEOUT')
    err.stack = 'Error: TIMEOUT\n    at /app/worker/src/userListener.ts:1:1'
    assert.equal(isGramjsUpdateLoopTimeout(err), false)
  })

  it('does not match other messages or non-errors', () => {
    assert.equal(isGramjsUpdateLoopTimeout(new Error('boom')), false)
    assert.equal(isGramjsUpdateLoopTimeout('TIMEOUT'), false)
    assert.equal(isGramjsUpdateLoopTimeout(undefined), false)
  })
})
