import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { UserSessionManager } from './sessionManager'
import { UserListener } from './userListener'
import { resetBusinessEventsForTests } from './observability/businessEvents'
import { initWorkerSentry, resetWorkerSentryForTests, setSentryAdapterForTests } from './observability/sentry'

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeSupabase() {
  const calls: Array<{ table: string; op: string; field?: string; value?: unknown }> = []
  const channelsRemoved: unknown[] = []
  const builder = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      delete: () => {
        calls.push({ table, op: 'delete' })
        return b
      },
      update: (value: unknown) => {
        calls.push({ table, op: 'update', value })
        return b
      },
      eq: (field: string, value: unknown) => {
        calls.push({ table, op: 'eq', field, value })
        return b
      },
      in: (field: string, value: unknown) => {
        calls.push({ table, op: 'in', field, value })
        return b
      },
      gt: () => Promise.resolve({ data: [], error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
    }
    return b
  }
  return {
    calls,
    channelsRemoved,
    from: builder,
    removeChannel: async (ch: unknown) => { channelsRemoved.push(ch) },
  }
}

class MockScope {
  tags: Record<string, string> = {}
  setLevel(): void {}
  setTag(key: string, value: string): void { this.tags[key] = value }
  setContext(): void {}
  setExtra(): void {}
  setFingerprint(): void {}
}

function setupSentry() {
  resetWorkerSentryForTests()
  resetBusinessEventsForTests()
  const mock = {
    capturedMessages: [] as unknown[],
    scopes: [] as MockScope[],
    init() {},
    captureException() { return 'event-id' },
    captureMessage(msg: string, level?: string) {
      mock.capturedMessages.push({ msg, level })
      return 'event-id'
    },
    addBreadcrumb() {},
    setTag() {},
    setContext() {},
    withScope(fn: (scope: MockScope) => void) {
      const scope = new MockScope()
      mock.scopes.push(scope)
      fn(scope)
    },
    async flush() { return true },
  }
  setSentryAdapterForTests(mock as never)
  initWorkerSentry({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  return mock
}

describe('UserSessionManager shutdown', () => {
  it('waits for all Telegram listeners to disconnect and clears ownership', async () => {
    const supabase = makeSupabase()
    const manager = new UserSessionManager(supabase as never)
    const stopped: string[] = []
    const listeners = new Map<string, unknown>([
      ['user-a', { stop: async () => { await delay(25); stopped.push('user-a') } }],
      ['user-b', { stop: async () => { await delay(5); stopped.push('user-b') } }],
    ])
    ;(manager as unknown as { listeners: Map<string, unknown> }).listeners = listeners

    await manager.disconnectAll()

    assert.deepEqual(stopped.sort(), ['user-a', 'user-b'])
    assert.equal((manager as unknown as { listeners: Map<string, unknown> }).listeners.size, 0)
  })

  it('releases every matching and orphaned owned lease during shutdown', async () => {
    const supabase = makeSupabase()
    const manager = new UserSessionManager(supabase as never)
    ;(manager as unknown as { listeners: Map<string, unknown> }).listeners = new Map([
      ['user-a', { stop: async () => {} }],
      ['user-b', { stop: async () => {} }],
    ])

    await manager.disconnectAll()

    const leaseDeletes = supabase.calls.filter(c => c.table === 'worker_session_leases' && c.op === 'delete')
    assert.equal(leaseDeletes.length >= 3, true)
    assert.equal(
      supabase.calls.some(c => c.table === 'worker_session_leases' && c.op === 'eq' && c.field === 'user_id' && c.value === 'user-a'),
      true,
    )
    assert.equal(
      supabase.calls.some(c => c.table === 'worker_session_leases' && c.op === 'eq' && c.field === 'user_id' && c.value === 'user-b'),
      true,
    )
    assert.equal(
      supabase.calls.some(c => c.table === 'worker_session_leases' && c.op === 'eq' && c.field === 'worker_id'),
      true,
    )
  })
})

describe('UserListener AUTH_KEY_DUPLICATED lifecycle', () => {
  function makeListener(connect: () => Promise<void>, exhausted?: (userId: string, reason: string) => void) {
    const supabase = makeSupabase()
    const events: string[] = []
    let probeCalls = 0
    const client = {
      connected: true,
      onError: undefined as undefined | ((err: Error) => Promise<void>),
      connect: async () => {
        events.push('connect')
        await connect()
      },
      disconnect: async () => { events.push('disconnect') },
      invoke: async () => {
        events.push('probe')
        probeCalls += 1
        return {}
      },
      session: { save: () => 'changed-session' },
    }
    const listener = new UserListener('user-a', 'saved-session', supabase as never, client as never, exhausted)
    const anyListener = listener as unknown as {
      isConnected: boolean
      requestReconnect: (reason: string) => Promise<void>
      stop: () => Promise<void>
      warmEntityCache: () => Promise<void>
      refreshChannelSubscription: () => Promise<void>
      runReplyChainSweep: () => Promise<void>
      runRecentCatchUp: () => Promise<void>
    }
    anyListener.isConnected = true
    anyListener.warmEntityCache = async () => {}
    anyListener.refreshChannelSubscription = async () => {}
    anyListener.runReplyChainSweep = async () => {}
    anyListener.runRecentCatchUp = async () => {}
    return { listener, anyListener, client, events, getProbeCalls: () => probeCalls }
  }

  it('repeated force reconnect calls cannot create overlapping clients', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    let connectCalls = 0
    try {
      const { anyListener } = makeListener(async () => {
        connectCalls += 1
        await delay(20)
      })
      const a = anyListener.requestReconnect('test')
      const b = anyListener.requestReconnect('test')
      await Promise.all([a, b])
      assert.equal(connectCalls, 1)
      await anyListener.stop()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevMax
    }
  })

  it('shutdown while reconnecting does not start another client', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    let connectCalls = 0
    try {
      const { anyListener } = makeListener(async () => { connectCalls += 1 })
      const reconnect = anyListener.requestReconnect('test')
      await anyListener.stop()
      await reconnect
      assert.equal(connectCalls, 0)
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevMax
    }
  })

  it('successful recovery before the maximum keeps the session active', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    try {
      const { listener, anyListener } = makeListener(async () => {})
      await anyListener.requestReconnect('test')
      assert.equal(listener.isTelegramConnected(), true)
      await anyListener.stop()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevMax
    }
  })

  it('maximum AUTH_KEY_DUPLICATED retries schedule deferred retry without invalidating', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    let connectCalls = 0
    try {
      const { listener, anyListener } = makeListener(async () => {
        connectCalls += 1
        throw new Error('AUTH_KEY_DUPLICATED')
      })

      await anyListener.requestReconnect('auth_key_duplicated:test')
      await delay(10)

      assert.equal(connectCalls, 1)
      assert.equal(listener.isTelegramConnected(), false)
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevMax
    }
  })

  it('malformed RPC result triggers serialized reconnect and successful probe', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
    const prevAuthMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '10'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    try {
      let connectCalls = 0
      const { listener, anyListener, client, getProbeCalls } = makeListener(async () => { connectCalls += 1 })

      await client.onError?.(Object.assign(new Error('GRAMJS_MALFORMED_RPC_RESULT: invalid RPC result body'), {
        code: 'GRAMJS_MALFORMED_RPC_RESULT',
      }))

      assert.equal(connectCalls, 1)
      assert.equal(getProbeCalls(), 1)
      assert.equal(listener.isTelegramConnected(), true)
      await anyListener.stop()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMax
      if (prevAuthMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevAuthMax
    }
  })

  it('concurrent malformed RPC errors join the same reconnect', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
    const prevAuthMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '10'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    try {
      let connectCalls = 0
      const { anyListener, client, getProbeCalls } = makeListener(async () => {
        connectCalls += 1
        await delay(20)
      })
      const err = Object.assign(new Error('GRAMJS_MALFORMED_RPC_RESULT: invalid RPC result body'), {
        code: 'GRAMJS_MALFORMED_RPC_RESULT',
      })

      await Promise.all([client.onError?.(err), client.onError?.(err)])

      assert.equal(connectCalls, 1)
      assert.equal(getProbeCalls(), 1)
      await anyListener.stop()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMax
      if (prevAuthMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevAuthMax
    }
  })

  it('successful malformed RPC recovery preserves valid auth session and does not invalidate', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
    const prevAuthMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '10'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    const exhausted: Array<{ userId: string; reason: string }> = []
    try {
      const { listener, anyListener, client } = makeListener(
        async () => {},
        (userId, reason) => exhausted.push({ userId, reason }),
      )
      await client.onError?.(Object.assign(new Error('GRAMJS_MALFORMED_RPC_RESULT: invalid RPC result body'), {
        code: 'GRAMJS_MALFORMED_RPC_RESULT',
      }))

      assert.equal(listener.isTelegramConnected(), true)
      assert.deepEqual(exhausted, [])
      await anyListener.stop()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMax
      if (prevAuthMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevAuthMax
    }
  })

  it('malformed RPC recovery requires a successful probe before restoring connected state', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
    const prevAuthMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '10'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    try {
      let connectCalls = 0
      const { listener, anyListener, client } = makeListener(async () => { connectCalls += 1 })
      client.invoke = async () => {
        throw new Error('probe failed')
      }

      await client.onError?.(Object.assign(new Error('GRAMJS_MALFORMED_RPC_RESULT: invalid RPC result body'), {
        code: 'GRAMJS_MALFORMED_RPC_RESULT',
      }))
      await delay(10)

      assert.equal(connectCalls, 1)
      assert.equal(listener.isTelegramConnected(), false)
      await anyListener.stop()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMax
      if (prevAuthMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevAuthMax
    }
  })

  it('repeated malformed RPC responses exhaust recovery without invalidating auth session', async () => {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
    const prevAuthMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
    process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '1'
    process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
    const exhausted: Array<{ userId: string; reason: string }> = []
    try {
      let connectCalls = 0
      const { listener, client } = makeListener(
        async () => { connectCalls += 1 },
        (userId, reason) => exhausted.push({ userId, reason }),
      )
      client.invoke = async () => {
        throw new Error('probe failed')
      }
      const err = Object.assign(new Error('GRAMJS_MALFORMED_RPC_RESULT: invalid RPC result body'), {
        code: 'GRAMJS_MALFORMED_RPC_RESULT',
      })

      await client.onError?.(err)
      await client.onError?.(err)
      await delay(10)

      assert.equal(connectCalls, 1)
      assert.equal(listener.isTelegramConnected(), false)
      assert.deepEqual(exhausted, [])
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMax
      if (prevAuthMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevAuthMax
    }
  })

  function makeMockTelegramClient(
    label: string,
    opts?: {
      connect?: () => Promise<void>
      disconnect?: () => Promise<void>
      invoke?: () => Promise<unknown>
      save?: () => string
    },
  ) {
    const activeHandlers: Array<{ handler: unknown; builder: unknown }> = []
    const events: string[] = []
    const client = {
      label,
      connected: true,
      onError: undefined as undefined | ((err: Error) => Promise<void>),
      connect: async () => {
        events.push(`${label}:connect`)
        await opts?.connect?.()
      },
      disconnect: async () => {
        events.push(`${label}:disconnect`)
        await opts?.disconnect?.()
      },
      invoke: async () => {
        events.push(`${label}:probe`)
        return opts?.invoke ? opts.invoke() : {}
      },
      addEventHandler: (handler: unknown, builder: unknown) => {
        events.push(`${label}:add`)
        activeHandlers.push({ handler, builder })
      },
      removeEventHandler: (handler: unknown, builder: unknown) => {
        events.push(`${label}:remove`)
        const idx = activeHandlers.findIndex(h => h.handler === handler && h.builder === builder)
        if (idx >= 0) activeHandlers.splice(idx, 1)
      },
      session: { save: () => opts?.save?.() ?? `${label}-session` },
    }
    return {
      client,
      events,
      activeHandlerCount: () => activeHandlers.length,
      addCount: () => events.filter(e => e === `${label}:add`).length,
      removeCount: () => events.filter(e => e === `${label}:remove`).length,
    }
  }

  function malformedRpcError(): Error {
    return Object.assign(new Error('GRAMJS_MALFORMED_RPC_RESULT: invalid RPC result body'), {
      code: 'GRAMJS_MALFORMED_RPC_RESULT',
    })
  }

  async function withFastMalformedRecovery<T>(fn: () => Promise<T>): Promise<T> {
    const prevCooldown = process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
    const prevJitter = process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS
    const prevMalformedMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
    const prevAuthMax = process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
    try {
      process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = '500'
      process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS = '0'
      process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '10'
      process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = '1'
      return await fn()
    } finally {
      if (prevCooldown == null) delete process.env.TELEGRAM_RECONNECT_COOLDOWN_MS
      else process.env.TELEGRAM_RECONNECT_COOLDOWN_MS = prevCooldown
      if (prevJitter == null) delete process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS
      else process.env.TELEGRAM_RECONNECT_JITTER_MAX_MS = prevJitter
      if (prevMalformedMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMalformedMax
      if (prevAuthMax == null) delete process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS
      else process.env.TELEGRAM_AUTH_DUP_MAX_RECOVERY_ATTEMPTS = prevAuthMax
    }
  }

  async function makeOwnedListenerWithSubscribedHandlers(opts?: {
    oldDisconnect?: () => Promise<void>
    probe?: () => Promise<unknown>
  }) {
    const supabase = makeSupabase()
    const allClients = [
      makeMockTelegramClient('old', { disconnect: opts?.oldDisconnect, save: () => 'persisted-session' }),
      makeMockTelegramClient('new', { invoke: opts?.probe }),
      makeMockTelegramClient('newer'),
    ]
    const clientQueue = [...allClients]
    const sessions: string[] = []
    const listener = new UserListener(
      'user-a',
      'saved-session',
      supabase as never,
      undefined,
      undefined,
      ((sessionString: string) => {
        sessions.push(sessionString)
        const next = clientQueue.shift()
        if (!next) throw new Error('unexpected client recreation')
        return next.client as never
      }),
    )
    const anyListener = listener as unknown as {
      isConnected: boolean
      loadChannels: () => Promise<Set<string>>
      warmEntityCache: () => Promise<void>
      runReplyChainSweep: () => Promise<void>
      runRecentCatchUp: () => Promise<void>
      refreshChannelSubscription: () => Promise<void>
      stop: () => Promise<void>
      client: { onError?: (err: Error) => Promise<void> }
      stopping: boolean
    }
    anyListener.isConnected = true
    anyListener.loadChannels = async () => new Set(['channel-a'])
    anyListener.warmEntityCache = async () => {}
    anyListener.runReplyChainSweep = async () => {}
    anyListener.runRecentCatchUp = async () => {}
    await anyListener.refreshChannelSubscription()
    return { listener, anyListener, clients: allClients, sessions }
  }

  it('owned malformed recovery removes old message and edit handlers before client replacement', async () => {
    await withFastMalformedRecovery(async () => {
      const { anyListener, clients, sessions } = await makeOwnedListenerWithSubscribedHandlers()
      const oldClient = clients[0]

      await anyListener.client.onError?.(malformedRpcError())

      assert.equal(oldClient.activeHandlerCount(), 0)
      assert.equal(oldClient.removeCount(), 2)
      assert.equal(clients[1].activeHandlerCount(), 2)
      assert.equal(clients[1].addCount(), 2)
      assert.deepEqual(sessions, ['saved-session', 'persisted-session'])
      assert.equal(oldClient.events.indexOf('old:remove') < oldClient.events.indexOf('old:disconnect'), true)
      await anyListener.stop()
    })
  })

  it('disconnect failure during malformed recovery does not leave old handlers registered', async () => {
    await withFastMalformedRecovery(async () => {
      const { anyListener, clients } = await makeOwnedListenerWithSubscribedHandlers({
        oldDisconnect: async () => { throw new Error('disconnect failed') },
      })
      const oldClient = clients[0]

      await anyListener.client.onError?.(malformedRpcError())

      assert.equal(oldClient.activeHandlerCount(), 0)
      assert.equal(oldClient.removeCount(), 2)
      assert.equal(clients[1].activeHandlerCount(), 2)
      await anyListener.stop()
    })
  })

  it('repeated malformed recoveries do not accumulate handlers across clients', async () => {
    await withFastMalformedRecovery(async () => {
      const { anyListener, clients } = await makeOwnedListenerWithSubscribedHandlers()
      const oldClient = clients[0]
      const secondClient = clients[1]
      const thirdClient = clients[2]

      await anyListener.client.onError?.(malformedRpcError())
      assert.equal(oldClient.activeHandlerCount(), 0)
      assert.equal(secondClient.activeHandlerCount(), 2)

      await anyListener.client.onError?.(malformedRpcError())
      assert.equal(secondClient.activeHandlerCount(), 0)
      assert.equal(secondClient.removeCount(), 2)
      assert.equal(thirdClient.activeHandlerCount(), 2)
      assert.equal(thirdClient.addCount(), 2)
      await anyListener.stop()
    })
  })

  it('probe failure during malformed recovery leaves old handlers detached and does not attach new handlers', async () => {
    await withFastMalformedRecovery(async () => {
      const { anyListener, clients } = await makeOwnedListenerWithSubscribedHandlers({
        probe: async () => { throw new Error('probe failed') },
      })
      const oldClient = clients[0]
      const newClient = clients[1]

      await anyListener.client.onError?.(malformedRpcError())
      await delay(10)

      assert.equal(oldClient.activeHandlerCount(), 0)
      assert.equal(oldClient.removeCount(), 2)
      assert.equal(newClient.activeHandlerCount(), 0)
      assert.equal(anyListener.isConnected, false)
      await anyListener.stop()
    })
  })

  it('shutdown during malformed client cleanup leaves old handlers detached', async () => {
    await withFastMalformedRecovery(async () => {
      let releaseDisconnect!: () => void
      const disconnectGate = new Promise<void>(resolve => { releaseDisconnect = resolve })
      const { anyListener, clients } = await makeOwnedListenerWithSubscribedHandlers({
        oldDisconnect: async () => { await disconnectGate },
      })
      const oldClient = clients[0]

      const recovery = anyListener.client.onError?.(malformedRpcError()) ?? Promise.resolve()
      await delay(10)
      assert.equal(oldClient.activeHandlerCount(), 0)
      assert.equal(oldClient.removeCount(), 2)

      const stop = anyListener.stop()
      releaseDisconnect()
      await recovery
      await stop
      assert.equal(oldClient.activeHandlerCount(), 0)
    })
  })

  it('malformed recovery exhaustion emits recovery exhausted without duplicate listener failed issue', async () => {
    await withFastMalformedRecovery(async () => {
      const prevMax = process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = '1'
      const mock = setupSentry()
      const { anyListener, clients } = await makeOwnedListenerWithSubscribedHandlers({
        probe: async () => { throw new Error('probe failed') },
      })

      await anyListener.client.onError?.(malformedRpcError())
      await anyListener.client.onError?.(malformedRpcError())
      await delay(10)

      const eventNames = mock.scopes.map(scope => scope.tags.event_name)
      assert.equal(eventNames.includes('telegram_recovery_exhausted'), true)
      assert.equal(eventNames.includes('telegram_listener_failed'), false)
      assert.equal(clients[0].activeHandlerCount(), 0)
      await anyListener.stop()
      if (prevMax == null) delete process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES
      else process.env.TELEGRAM_MALFORMED_RPC_MAX_RECOVERIES = prevMax
    })
  })
})
