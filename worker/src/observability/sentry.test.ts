import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import {
  addWorkerBreadcrumb,
  allowEventRate,
  buildSafePipelineContext,
  captureWorkerError,
  captureWorkerFatalError,
  captureWorkerLog,
  captureWorkerWarning,
  flushWorkerSentry,
  handleWorkerUncaughtException,
  handleWorkerUnhandledRejection,
  initWorkerSentry,
  installWorkerProcessSentryHandlers,
  isWorkerSentryEnabled,
  isValidSentryDsn,
  removeWorkerProcessSentryHandlersForTests,
  resetEventRateLimitsForTests,
  resetWorkerSentryForTests,
  safeForSentry,
  setSentryAdapterForTests,
  setWorkerGlobalTags,
} from './sentry'

type MockSentry = {
  initCalls: unknown[]
  capturedExceptions: unknown[]
  capturedMessages: unknown[]
  capturedLogs: Array<{ level: string; message: string; attributes?: unknown }>
  breadcrumbs: unknown[]
  tags: Record<string, string>
  contexts: Record<string, unknown>
  scopes: MockScope[]
  flushCalls: number[]
  throwInit?: boolean
  throwCapture?: boolean
  init: (opts: unknown) => void
  captureException: (err: unknown) => string
  captureMessage: (msg: string, level?: string) => string
  addBreadcrumb: (crumb: unknown) => void
  setTag: (key: string, value: string) => void
  setContext: (key: string, value: unknown) => void
  withScope: (fn: (scope: MockScope) => void) => void
  flush: (timeout?: number) => Promise<boolean>
  logger: {
    info: (message: string, attributes?: unknown) => void
    warn: (message: string, attributes?: unknown) => void
    error: (message: string, attributes?: unknown) => void
  }
}

class MockScope {
  level: string | null = null
  tags: Record<string, string> = {}
  contexts: Record<string, unknown> = {}
  extras: Record<string, unknown> = {}
  fingerprint: string[] | null = null
  setLevel(level: string): void { this.level = level }
  setTag(key: string, value: string): void { this.tags[key] = value }
  setContext(key: string, value: unknown): void { this.contexts[key] = value }
  setExtra(key: string, value: unknown): void { this.extras[key] = value }
  setFingerprint(value: string[]): void { this.fingerprint = value }
}

function mockSentry(): MockSentry {
  const mock: MockSentry = {
    initCalls: [],
    capturedExceptions: [],
    capturedMessages: [],
    capturedLogs: [],
    breadcrumbs: [],
    tags: {},
    contexts: {},
    scopes: [],
    flushCalls: [],
    init(opts: unknown) {
      if (mock.throwInit) throw new Error('init failed')
      mock.initCalls.push(opts)
    },
    captureException(err: unknown) {
      if (mock.throwCapture) throw new Error('capture failed')
      mock.capturedExceptions.push(err)
      return 'event-id'
    },
    captureMessage(msg: string, level?: string) {
      if (mock.throwCapture) throw new Error('capture failed')
      mock.capturedMessages.push({ msg, level })
      return 'event-id'
    },
    logger: {
      info(message: string, attributes?: unknown) {
        if (mock.throwCapture) throw new Error('capture failed')
        mock.capturedLogs.push({ level: 'info', message, attributes })
      },
      warn(message: string, attributes?: unknown) {
        if (mock.throwCapture) throw new Error('capture failed')
        mock.capturedLogs.push({ level: 'warn', message, attributes })
      },
      error(message: string, attributes?: unknown) {
        if (mock.throwCapture) throw new Error('capture failed')
        mock.capturedLogs.push({ level: 'error', message, attributes })
      },
    },
    addBreadcrumb(crumb: unknown) { mock.breadcrumbs.push(crumb) },
    setTag(key: string, value: string) { mock.tags[key] = value },
    setContext(key: string, value: unknown) { mock.contexts[key] = value },
    withScope(fn: (scope: MockScope) => void) {
      const scope = new MockScope()
      mock.scopes.push(scope)
      fn(scope)
    },
    async flush(timeout?: number) {
      mock.flushCalls.push(timeout ?? 0)
      return true
    },
  }
  return mock
}

function setupMock(env?: NodeJS.ProcessEnv): MockSentry {
  resetWorkerSentryForTests()
  const mock = mockSentry()
  setSentryAdapterForTests(mock as never)
  if (env) initWorkerSentry(env)
  return mock
}

function enabledMock(): MockSentry {
  return setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
}

function initOptions(mock: MockSentry): Record<string, unknown> {
  return mock.initCalls[0] as Record<string, unknown>
}

function captureWarns(fn: () => void): string[] {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(arg => String(arg)).join(' '))
  }
  try {
    fn()
  } finally {
    console.warn = originalWarn
  }
  return warnings
}

test('DSN missing disables Sentry', () => {
  const mock = setupMock({ SENTRY_ENABLED: 'true' } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
})

test('empty DSN disables Sentry without initialization', () => {
  const mock = setupMock({ SENTRY_ENABLED: 'true', SENTRY_DSN: '' } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
})

test('Sentry DSN validation rejects malformed and non-DSN values', () => {
  const invalid = [
    'plain text',
    'https://example.invalid/1',
    'ftp://public@example.invalid/1',
    'https://@example.invalid/1',
    'https://public@example.invalid',
    'https://public:secret@example.invalid/1',
    'https://public@example.invalid/1#frag',
    ' https://public@example.invalid/1',
    'https://public@example.invalid/1\n',
    'https://pub%ZZ@example.invalid/1',
  ]
  for (const dsn of invalid) assert.equal(isValidSentryDsn(dsn), false, dsn)
})

test('Sentry DSN validation accepts valid fake http and https DSNs', () => {
  assert.equal(isValidSentryDsn('http://public_key@example.invalid/123'), true)
  assert.equal(isValidSentryDsn('https://public-key_1@example.invalid/sentry/456'), true)
})

test('invalid Sentry DSN never reaches init and warning is generic', () => {
  resetWorkerSentryForTests()
  const mock = mockSentry()
  setSentryAdapterForTests(mock as never)
  const supplied = 'https://publickey@example.invalid/123?token=abc#frag'
  const warnings = captureWarns(() => {
    assert.doesNotThrow(() => initWorkerSentry({
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: supplied,
    } as NodeJS.ProcessEnv))
  })
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
  assert.deepEqual(warnings, ['[sentry] disabled: invalid DSN configuration'])
  const warningText = warnings.join(' ')
  assert.doesNotMatch(warningText, /publickey/)
  assert.doesNotMatch(warningText, /example\.invalid/)
  assert.doesNotMatch(warningText, /123/)
  assert.doesNotMatch(warningText, /token/)
  assert.doesNotMatch(warningText, /frag/)
})

test('valid Sentry DSN reaches init once', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://publickey@example.invalid/123',
  } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), true)
  assert.equal(mock.initCalls.length, 1)
})

test('repeated initialization with invalid Sentry DSN logs once and startup continues', () => {
  resetWorkerSentryForTests()
  const mock = mockSentry()
  setSentryAdapterForTests(mock as never)
  const warnings = captureWarns(() => {
    assert.doesNotThrow(() => initWorkerSentry({
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: 'not-a-dsn',
    } as NodeJS.ProcessEnv))
    assert.doesNotThrow(() => initWorkerSentry({
      SENTRY_ENABLED: 'true',
      SENTRY_DSN: 'not-a-dsn',
    } as NodeJS.ProcessEnv))
  })
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
  assert.deepEqual(warnings, ['[sentry] disabled: invalid DSN configuration'])
  assert.doesNotMatch(warnings.join(' '), /not-a-dsn/)
})

test('SENTRY_ENABLED missing or false disables Sentry', () => {
  let mock = setupMock({ SENTRY_DSN: 'https://public@example.invalid/1' } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
  mock = setupMock({ SENTRY_ENABLED: 'false', SENTRY_DSN: 'https://public@example.invalid/1' } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
})

test('initialization failure does not prevent startup helpers', () => {
  resetWorkerSentryForTests()
  const mock = mockSentry()
  mock.throwInit = true
  setSentryAdapterForTests(mock as never)
  assert.doesNotThrow(() => initWorkerSentry({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv))
  assert.equal(isWorkerSentryEnabled(), false)
})

test('capture helpers never throw and do not await network work', async () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  mock.throwCapture = true
  assert.doesNotThrow(() => captureWorkerError(new Error('boom'), { subsystem: 'worker', operation: 'test' }))
  assert.doesNotThrow(() => captureWorkerWarning('warn', { subsystem: 'worker', operation: 'test' }))
  assert.equal(mock.flushCalls.length, 0)
  assert.equal(await flushWorkerSentry(99999), true)
  assert.deepEqual(mock.flushCalls, [2000])
})

test('beforeSend redacts secret keys and JWT/Bearer strings', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  const opts = mock.initCalls[0] as { beforeSend: (event: unknown) => unknown }
  const event = opts.beforeSend({
    extra: {
      SUPABASE_SERVICE_ROLE_KEY: 'secret-value',
      nested: { Authorization: 'Bearer eyJaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbb.cccccccccccccccccc' },
    },
  }) as Record<string, unknown>
  const json = JSON.stringify(event)
  assert.doesNotMatch(json, /secret-value/)
  assert.doesNotMatch(json, /eyJaaaaaaaa/)
  assert.equal(event.extra, undefined)
})

test('beforeBreadcrumb redacts console messages and data', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  const opts = mock.initCalls[0] as { beforeBreadcrumb: (event: unknown) => unknown }
  const crumb = opts.beforeBreadcrumb({
    category: 'console',
    message: 'Authorization Bearer eyJaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbb.cccccccccccccccccc',
    data: { cookie: 'abc', url: 'https://user:pass@example.com/path?token=abc&ok=1' },
  }) as Record<string, unknown>
  const json = JSON.stringify(crumb)
  assert.equal(crumb.message, '[REDACTED_BREADCRUMB]')
  assert.doesNotMatch(json, /eyJaaaaaaaa/)
  assert.doesNotMatch(json, /user:pass/)
  assert.doesNotMatch(json, /token=abc/)
})

test('init enables the logs pipeline with a redacting beforeSendLog', () => {
  const mock = enabledMock()
  const opts = initOptions(mock) as { enableLogs?: boolean; beforeSendLog?: (log: unknown) => unknown }
  assert.equal(opts.enableLogs, true)
  assert.equal(typeof opts.beforeSendLog, 'function')
  const log = opts.beforeSendLog!({
    level: 'info',
    message: 'order failed Bearer eyJaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbb.cccccccccccccccccc fxs_abcdefghijklmnopqrstuvwxyz123',
    attributes: { apiKey: 'secret-value', safe: 'ok', nested: { password: 'pw' } },
  }) as Record<string, unknown>
  const json = JSON.stringify(log)
  assert.doesNotMatch(json, /eyJaaaaaaaa/)
  assert.doesNotMatch(json, /fxs_abcdefghijklmnopqrstuvwxyz123/)
  assert.doesNotMatch(json, /secret-value/)
  assert.doesNotMatch(json, /pw/)
  assert.equal(typeof log.message, 'string')
})

test('beforeSendLog drops gramjs flood-wait noise by default', () => {
  const mock = enabledMock()
  const opts = initOptions(mock) as { beforeSendLog?: (log: unknown) => unknown }
  const fn = opts.beforeSendLog!
  const dropped = [
    '\x1b[33m[[T07:39:33.630] [INFO] - [Sleeping for 31s on flood wait (Caused by messages.GetHistory)]\x1b[0m',
    '\x1b[33m[[T07:41:25.050] [INFO] - [Sleeping for 30s on flood wait (Caused by messages.GetDialogs)]\x1b[0m',
    '[INFO] - [Sleeping for 27s on flood wait (Caused by messages.GetHistory)]',
  ]
  for (const message of dropped) {
    assert.equal(fn({ level: 'info', message }), null, message)
  }
})

test('beforeSendLog keeps non-noise logs', () => {
  const mock = enabledMock()
  const opts = initOptions(mock) as { beforeSendLog?: (log: unknown) => unknown }
  const kept = opts.beforeSendLog!({
    level: 'warn',
    message: '[orderCloseAudit] source=fxsocket account=x ticket=1 ok=false msg=unknown ticket',
  }) as Record<string, unknown>
  assert.equal(typeof kept, 'object')
  assert.equal(kept.message, '[orderCloseAudit] source=fxsocket account=x ticket=1 ok=false msg=unknown ticket')
})

test('beforeSendLog honors SENTRY_LOG_NOISE_PATTERNS extra regexes', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_LOG_NOISE_PATTERNS: 'listener_healthy,\\bheartbeat\\b',
  } as NodeJS.ProcessEnv)
  const opts = initOptions(mock) as { beforeSendLog?: (log: unknown) => unknown }
  const fn = opts.beforeSendLog!
  assert.equal(fn({ level: 'info', message: '[telegram-conn] event=listener_healthy worker=x connected=true' }), null)
  assert.equal(fn({ level: 'info', message: '[trailingStopMonitor] heartbeat rows=3' }), null)
})

test('beforeSendLog can disable noise filtering with SENTRY_LOG_NOISE_FILTER=false', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_LOG_NOISE_FILTER: 'false',
  } as NodeJS.ProcessEnv)
  const opts = initOptions(mock) as { beforeSendLog?: (log: unknown) => unknown }
  const kept = opts.beforeSendLog!({
    level: 'info',
    message: '[INFO] - [Sleeping for 31s on flood wait (Caused by messages.GetHistory)]',
  }) as Record<string, unknown>
  assert.equal(typeof kept, 'object')
  assert.equal(kept.message, '[INFO] - [Sleeping for 31s on flood wait (Caused by messages.GetHistory)]')
})

test('captureWorkerLog maps levels, applies bounded fields, and redacts attributes', () => {
  const mock = enabledMock()
  captureWorkerLog('info', 'worker startup', {
    subsystem: 'worker',
    operation: 'startup',
    errorCode: 'STARTUP',
    attributes: {
      build_tag: 'build-1',
      shard_id: 0,
      broker_password: 'supersecret',
      user_email: 'user@example.com',
    },
  })
  captureWorkerLog('warn', 'retry backing off', { subsystem: 'queue', operation: 'retry' })
  captureWorkerLog('error', 'order rejected', { subsystem: 'broker', operation: 'order_send', tags: { reason: 'margin' } })
  assert.equal(mock.capturedLogs.length, 3)
  const [startup, retry, rejected] = mock.capturedLogs
  assert.equal(startup.level, 'info')
  assert.equal(startup.message, 'worker startup')
  assert.deepEqual(startup.attributes, {
    subsystem: 'worker',
    operation: 'startup',
    error_code: 'STARTUP',
    build_tag: 'build-1',
    shard_id: 0,
    broker_password: '[REDACTED]',
    user_email: '[REDACTED]',
  })
  assert.equal(retry.level, 'warn')
  assert.deepEqual(retry.attributes, { subsystem: 'queue', operation: 'retry' })
  assert.equal(rejected.level, 'error')
  assert.deepEqual(rejected.attributes, { subsystem: 'broker', operation: 'order_send', reason: 'margin' })
})

test('captureWorkerLog no-ops when Sentry is disabled', () => {
  const mock = setupMock({ SENTRY_ENABLED: 'true' } as NodeJS.ProcessEnv)
  captureWorkerLog('info', 'should not appear', { subsystem: 'worker', operation: 'startup' })
  assert.equal(mock.capturedLogs.length, 0)
})

test('captureWorkerLog never throws when the adapter fails', () => {
  const mock = enabledMock()
  mock.throwCapture = true
  assert.doesNotThrow(() => captureWorkerLog('info', 'boom', { subsystem: 'worker', operation: 'startup' }))
  assert.equal(mock.capturedLogs.length, 0)
})

test('safeForSentry redacts nested arrays, Error, cause, circular, phone and email', () => {
  const cause = new Error('cause has phone +15555551212')
  const err = new Error('user test@example.com failed with Bearer abcdefghijklmnopqrstuvwxyz')
  ;(err as Error & { cause?: unknown }).cause = cause
  err.stack = 'stack with FXSOCKET_API_KEY=fxs_abcdefghijklmnopqrstuvwxyz123'
  const circular: Record<string, unknown> = { err, rows: [{ broker_password: 'pw' }] }
  circular.self = circular
  const safe = safeForSentry(circular)
  const json = JSON.stringify(safe)
  assert.match(json, /\[Circular]/)
  assert.doesNotMatch(json, /test@example.com/)
  assert.doesNotMatch(json, /15555551212/)
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz123/)
  assert.doesNotMatch(json, /"pw"/)
})

test('safeForSentry redacts real phone numbers but preserves UUIDs, timestamps and SHAs', () => {
  const input = {
    message: 'call +234 801 234 5678 or (415) 555-2671 for support',
    uuid: 'd0a7c123-4567-4c5a-b8ac-e2d78339d973',
    ts: '2026-08-08T07:37:32.597+00:00',
    until: '2026-08-08T07:37:32.597+00:00',
    release: 'a35fd651b4f095fde7b8b0e5102ab2c19b',
    order_ref: '8b0e5102-0e5102ab2c19b',
  }
  const safe = safeForSentry(input)
  const json = JSON.stringify(safe)
  assert.doesNotMatch(json, /234 801 234 5678/)
  assert.doesNotMatch(json, /415.555-2671/)
  assert.doesNotMatch(json, /555-2671/)
  assert.match(json, /d0a7c123-4567-4c5a-b8ac-e2d78339d973/)
  assert.match(json, /2026-08-08T07:37:32.597/)
  assert.match(json, /a35fd651b4f095fde7b8b0e5102ab2c19b/)
  assert.match(json, /8b0e5102-0e5102ab2c19b/)
})

test('Telegram message text and broker credentials are excluded', () => {
  const safe = safeForSentry({
    raw_message: 'GOLD BUY NOW SL 2400 TP 2450',
    telegram_text: 'full channel message',
    broker_credentials: { login: '123', password: 'secret' },
    mt5_password: 'secret',
  })
  const json = JSON.stringify(safe)
  assert.doesNotMatch(json, /GOLD BUY/)
  assert.doesNotMatch(json, /full channel/)
  assert.doesNotMatch(json, /secret/)
})

test('Authorization and cookie headers plus URL query credentials are excluded', () => {
  const safe = safeForSentry({
    headers: {
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      cookie: 'sid=secret',
    },
    url: 'https://example.com/path?access_token=abc123&x=1',
  })
  const json = JSON.stringify(safe)
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz/)
  assert.doesNotMatch(json, /sid=secret/)
  assert.doesNotMatch(json, /access_token=abc123/)
})

test('context values are bounded and high-cardinality identifiers are not global tags', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  captureWorkerError(new Error('failure'), {
    subsystem: 'broker',
    operation: 'order_send_ambiguous',
    context: {
      user_id: 'user-123',
      signal_id: 'signal-123',
      broker_account_id: 'broker-123',
      extra: { large: 'x'.repeat(3000) },
    },
  })
  assert.equal(mock.tags.signal_id, undefined)
  assert.equal(mock.tags.broker_account_id, undefined)
  const scope = mock.scopes.at(-1)!
  assert.equal(scope.tags.subsystem, 'broker')
  const json = JSON.stringify(scope.contexts)
  assert.match(json, /signal-123/)
  assert.match(json, /user_hash/)
  assert.doesNotMatch(json, /user-123/)
  assert.match(json, /broker_account_id_hash/)
  assert.doesNotMatch(json, /broker-123/)
  assert.ok(json.length < 5000)
})

test('worker role, shard and environment tags are set', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    NODE_ENV: 'staging',
    RAILWAY_ENVIRONMENT_NAME: 'staging',
  } as NodeJS.ProcessEnv)
  setWorkerGlobalTags({ NODE_ENV: 'staging', RAILWAY_ENVIRONMENT_NAME: 'staging' } as NodeJS.ProcessEnv)
  assert.ok(mock.tags['worker.role'])
  assert.ok(mock.tags['worker.shard_id'])
  assert.equal(mock.tags.node_env, 'staging')
})

test('price ticks and temporary Telegram TIMEOUT are not captured by helpers unless explicitly called', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  addWorkerBreadcrumb({ category: 'telegram', message: '_updateLoop TIMEOUT', level: 'warning' })
  assert.equal(mock.capturedExceptions.length, 0)
  assert.equal(mock.capturedMessages.length, 0)
  assert.equal(mock.breadcrumbs.length, 1)
})

test('final exhausted reconnect failure is captured with stable fingerprint', () => {
  const mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  captureWorkerWarning(new Error('AUTH_KEY_DUPLICATED for user X'), {
    subsystem: 'telegram',
    operation: 'auth_key_duplicated_exhausted',
    errorCode: 'AUTH_KEY_DUPLICATED',
    fingerprint: ['telegram', 'AUTH_KEY_DUPLICATED', 'exhausted'],
    context: { user_id: 'real-user', signal_id: 'sig-1' },
  })
  const scope = mock.scopes.at(-1)!
  assert.deepEqual(scope.fingerprint, ['telegram', 'auth_key_duplicated', 'exhausted'])
  assert.equal(scope.tags.error_code, 'AUTH_KEY_DUPLICATED')
})

test('load-test mode disables by default unless explicitly isolated', () => {
  let mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    LOAD_TEST_MODE: 'true',
  } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), false)
  assert.equal(mock.initCalls.length, 0)
  mock = setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    LOAD_TEST_MODE: 'true',
    SENTRY_LOAD_TEST_ENABLED: 'true',
  } as NodeJS.ProcessEnv)
  assert.equal(isWorkerSentryEnabled(), true)
  assert.equal(mock.tags.load_test, 'true')
})

test('process handlers install once and can be removed in tests', () => {
  setupMock({ SENTRY_ENABLED: 'true', SENTRY_DSN: 'https://public@example.invalid/1' } as NodeJS.ProcessEnv)
  const beforeUncaught = process.listenerCount('uncaughtException')
  const beforeRejection = process.listenerCount('unhandledRejection')
  installWorkerProcessSentryHandlers()
  installWorkerProcessSentryHandlers()
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught + 1)
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection + 1)
  removeWorkerProcessSentryHandlersForTests()
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught)
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection)
})

test('uncaught exception handler captures and bounded-flushes', async () => {
  const mock = setupMock({ SENTRY_ENABLED: 'true', SENTRY_DSN: 'https://public@example.invalid/1' } as NodeJS.ProcessEnv)
  const originalExit = process.exit
  const exitCodes: Array<string | number | null | undefined> = []
  ;(process as unknown as { exit: typeof process.exit }).exit = ((code?: string | number | null | undefined) => {
    exitCodes.push(code)
    return undefined as never
  }) as typeof process.exit
  try {
    handleWorkerUncaughtException(new Error('fatal Bearer abcdefghijklmnopqrstuvwxyz'))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(mock.capturedExceptions.length, 1)
    assert.deepEqual(mock.flushCalls, [1800])
    assert.deepEqual(exitCodes, [1])
  } finally {
    removeWorkerProcessSentryHandlersForTests()
    ;(process as unknown as { exit: typeof process.exit }).exit = originalExit
  }
})

test('unhandled rejection handler captures and bounded-flushes', async () => {
  const mock = setupMock({ SENTRY_ENABLED: 'true', SENTRY_DSN: 'https://public@example.invalid/1' } as NodeJS.ProcessEnv)
  const originalExit = process.exit
  const exitCodes: Array<string | number | null | undefined> = []
  ;(process as unknown as { exit: typeof process.exit }).exit = ((code?: string | number | null | undefined) => {
    exitCodes.push(code)
    return undefined as never
  }) as typeof process.exit
  try {
    handleWorkerUnhandledRejection(new Error('reject cookie=sid'))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(mock.capturedExceptions.length, 1)
    assert.deepEqual(mock.flushCalls, [1800])
    assert.deepEqual(exitCodes, [1])
  } finally {
    removeWorkerProcessSentryHandlersForTests()
    ;(process as unknown as { exit: typeof process.exit }).exit = originalExit
  }
})

test('fatal handlers print a visible, redacted log before exit', async () => {
  setupMock({ SENTRY_ENABLED: 'false' } as NodeJS.ProcessEnv)
  const originalExit = process.exit
  ;(process as unknown as { exit: typeof process.exit }).exit = (() => undefined as never) as typeof process.exit
  const originalError = console.error
  const lines: string[] = []
  console.error = (msg?: unknown) => { lines.push(String(msg)) }
  try {
    handleWorkerUncaughtException(new Error('fatal Bearer abcdefghijklmnopqrstuvwxyz'))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    resetWorkerSentryForTests()
    handleWorkerUnhandledRejection(new Error('reject cookie=sid'))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lines.length, 2)
    for (const line of lines) {
      assert.match(line, /^\[worker-fatal\]/)
      assert.ok(!line.includes('abcdefghijklmnopqrstuvwxyz'), `leaked Bearer token: ${line}`)
      assert.ok(!line.includes('cookie=sid'), `leaked session cookie: ${line}`)
    }
  } finally {
    console.error = originalError
    ;(process as unknown as { exit: typeof process.exit }).exit = originalExit
    removeWorkerProcessSentryHandlersForTests()
    resetWorkerSentryForTests()
  }
})

test('buildSafePipelineContext preserves correlation as context only', () => {
  const ctx = buildSafePipelineContext({
    user_id: 'user-abc',
    signal_id: 'signal-abc',
    channel_id: 'channel-abc',
    broker_account_id: 'broker-abc',
    execution_attempt_id: 'attempt-abc',
    queue_message_id: 'queue-abc',
    pending_leg_id: 'leg-abc',
    basket_id: 'basket-abc',
    reconciliation_id: 'reconcile-abc',
    load_run_id: 'load-run',
    stage: 'order_send',
  })
  const json = JSON.stringify(ctx)
  assert.match(json, /signal-abc/)
  assert.match(json, /broker_account_id_hash/)
  assert.match(json, /user_hash/)
  assert.doesNotMatch(json, /user-abc/)
  assert.doesNotMatch(json, /broker-abc/)
})

test('default integrations and automatic tracing are disabled', () => {
  const beforeUncaught = process.listenerCount('uncaughtException')
  const beforeRejection = process.listenerCount('unhandledRejection')
  const mock = enabledMock()
  const opts = initOptions(mock)
  assert.equal(opts.defaultIntegrations, false)
  const integrations = opts.integrations as { name?: string }[]
  assert.equal(integrations.length, 1)
  assert.equal(integrations[0].name, 'ConsoleLogs')
  assert.equal(opts.sendDefaultPii, false)
  assert.equal(opts.tracesSampleRate, 0)
  assert.equal(opts.profilesSampleRate, 0)
  assert.equal(opts.skipOpenTelemetrySetup, true)
  assert.deepEqual(opts.tracePropagationTargets, [])
  assert.equal(process.listenerCount('uncaughtException'), beforeUncaught)
  assert.equal(process.listenerCount('unhandledRejection'), beforeRejection)
})

test('Sentry initialization does not mutate mocked fetch or http headers', async () => {
  const originalFetch = globalThis.fetch
  const originalHttpRequest = http.request
  const originalHttpsRequest = https.request
  const fetchHeaders: unknown[] = []
  const httpHeaders: unknown[] = []
  ;(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (_url: unknown, init?: RequestInit) => {
    fetchHeaders.push(init?.headers ?? {})
    return new Response('{}')
  }) as typeof fetch
  ;(http as unknown as { request: typeof http.request }).request = ((options: unknown) => {
    httpHeaders.push((options as { headers?: unknown })?.headers)
    return { on() { return this }, end() { return this } }
  }) as unknown as typeof http.request
  ;(https as unknown as { request: typeof https.request }).request = ((options: unknown) => {
    httpHeaders.push((options as { headers?: unknown })?.headers)
    return { on() { return this }, end() { return this } }
  }) as unknown as typeof https.request
  try {
    enabledMock()
    await fetch('https://example.invalid/test', { headers: { 'x-test': '1' } })
    http.request({ hostname: 'example.invalid', headers: { 'x-test': '1' } }).end()
    https.request({ hostname: 'example.invalid', headers: { 'x-test': '1' } }).end()
    const json = JSON.stringify({ fetchHeaders, httpHeaders })
    assert.doesNotMatch(json, /sentry-trace/i)
    assert.doesNotMatch(json, /baggage/i)
  } finally {
    ;(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch
    ;(http as unknown as { request: typeof http.request }).request = originalHttpRequest
    ;(https as unknown as { request: typeof https.request }).request = originalHttpsRequest
  }
})

test('beforeSend removes request, user, arbitrary body, env and unsafe extras', () => {
  const mock = enabledMock()
  const opts = initOptions(mock) as { beforeSend: (event: unknown) => unknown }
  const event = opts.beforeSend({
    request: { headers: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }, data: { body: 'raw' } },
    user: { id: 'real-user', email: 'person@example.com' },
    extra: {
      request_body: 'raw body',
      process_env: { FXSOCKET_API_KEY: 'fxs_abcdefghijklmnopqrstuvwxyz123' },
      safe_extra: { operation: 'order_send', access_token: 'abc123' },
    },
    contexts: {
      os: { secret: 'nope' },
      pipeline: { signal_id: 'sig-1' },
      worker: { role: 'trade' },
      durations: { total_ms: 10 },
    },
  }) as Record<string, unknown>
  const json = JSON.stringify(event)
  assert.equal(event.request, undefined)
  assert.equal(event.user, undefined)
  assert.doesNotMatch(json, /real-user/)
  assert.doesNotMatch(json, /person@example.com/)
  assert.doesNotMatch(json, /raw body/)
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz123/)
  assert.doesNotMatch(json, /abc123/)
  assert.match(json, /sig-1/)
})

test('addWorkerBreadcrumb sanitizes and allowlists breadcrumbs', () => {
  const mock = enabledMock()
  addWorkerBreadcrumb({
    category: 'http',
    message: 'GET https://user:pass@example.com?token=abc',
    level: 'info',
    data: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' },
  })
  const json = JSON.stringify(mock.breadcrumbs)
  assert.match(json, /REDACTED_BREADCRUMB/)
  assert.doesNotMatch(json, /user:pass/)
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz/)
})

test('safeForSentry handles AggregateError, Map, Set, typed arrays, Date and URL', () => {
  const safe = safeForSentry({
    aggregate: new ((globalThis as typeof globalThis & { AggregateError: new (errors: unknown[], message: string) => Error }).AggregateError)([
      new Error('Bearer abcdefghijklmnopqrstuvwxyz'),
      { broker_password: 'secret' },
    ], 'aggregate person@example.com'),
    map: new Map([['access_token', 'abc123'], ['ok', 'value']]),
    set: new Set(['Bearer abcdefghijklmnopqrstuvwxyz', 'safe']),
    bytes: new Uint8Array([1, 2, 3]),
    date: new Date('2026-07-30T00:00:00.000Z'),
    url: new URL('https://user:pass@example.com/path?token=abc&ok=1'),
  })
  const json = JSON.stringify(safe)
  assert.match(json, /AggregateError/)
  assert.match(json, /Uint8Array 3 bytes/)
  assert.match(json, /2026-07-30T00:00:00.000Z/)
  assert.doesNotMatch(json, /person@example.com/)
  assert.doesNotMatch(json, /user:pass/)
  assert.doesNotMatch(json, /token=abc/)
  assert.doesNotMatch(json, /secret/)
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz/)
})

test('safeForSentry handles circular causes, throwing getters, proxies and bounds deep or large data', () => {
  const err = new Error('root')
  ;(err as Error & { cause?: unknown }).cause = err
  const throwingGetter = {}
  Object.defineProperty(throwingGetter, 'api_key', {
    enumerable: true,
    get() { throw new Error('getter leaked secret') },
  })
  const proxy = new Proxy({}, {
    ownKeys() { throw new Error('proxy leaked secret') },
  })
  const deep: Record<string, unknown> = {}
  let cursor = deep
  for (let i = 0; i < 12; i++) {
    cursor.next = {}
    cursor = cursor.next as Record<string, unknown>
  }
  const safe = safeForSentry({
    err,
    throwingGetter,
    proxy,
    deep,
    large: Array.from({ length: 50 }, (_, i) => `item-${i}`),
    stack: 'line1\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz\n    at file.ts:10:2',
    json: JSON.stringify({ WORKER_INTERNAL_TOKEN: 'secret', ok: true }),
  })
  const json = JSON.stringify(safe)
  assert.match(json, /\[Circular]/)
  assert.match(json, /\[UNREADABLE]/)
  assert.match(json, /\[MAX_DEPTH]/)
  assert.match(json, /TRUNCATED 25 items/)
  assert.match(json, /file.ts:10:2/)
  assert.doesNotMatch(json, /getter leaked secret/)
  assert.doesNotMatch(json, /proxy leaked secret/)
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz/)
  assert.doesNotMatch(json, /"secret"/)
})

test('fatal startup failure is captured once by fatal helper', () => {
  const mock = enabledMock()
  const err = new Error('startup failure')
  assert.equal(captureWorkerFatalError(err, {
    subsystem: 'worker',
    operation: 'startup_failure',
    errorCode: 'STARTUP_FAILURE',
  }), true)
  assert.equal(captureWorkerFatalError(err, {
    subsystem: 'worker',
    operation: 'startup_failure',
    errorCode: 'STARTUP_FAILURE',
  }), false)
  assert.equal(mock.capturedExceptions.length, 1)
})


// ---------------------------------------------------------------------------
// beforeSend event rate limiting (transition-only emission).
//
// A chronic state condition is logged every monitor tick; without a limiter
// each line became its own Sentry event (prod 2026-10-23: ~90% of 213k events
// were 3 such conditions). allowEventRate lets the first event of a key
// through a window and drops repeats; 'fatal' is never limited.
// ---------------------------------------------------------------------------

test('event rate limiter allows the first event and drops a repeat of the same key', () => {
  resetEventRateLimitsForTests()
  const event = { level: 'error', fingerprint: ['broker', 'invalid_request'], message: 'order 387155920 refused' }
  assert.equal(allowEventRate(event), true, 'first event passes')
  assert.equal(allowEventRate(event), false, 'repeat within the window is dropped')
})

test('event rate limiter keeps distinct issues (different fingerprints) separate', () => {
  resetEventRateLimitsForTests()
  const a = { level: 'error', fingerprint: ['broker', 'invalid_request'], message: 'refused' }
  const b = { level: 'error', fingerprint: ['broker', 'throttle'], message: 'refused' }
  assert.equal(allowEventRate(a), true)
  assert.equal(allowEventRate(b), true, 'different fingerprint is a different issue')
})

test('event rate limiter collapses ids in the message into one template', () => {
  resetEventRateLimitsForTests()
  const first = { level: 'warning', fingerprint: ['sweep'], message: 'Ticket 387155920 not found' }
  const second = { level: 'warning', fingerprint: ['sweep'], message: 'Ticket 386551578 not found' }
  assert.equal(allowEventRate(first), true)
  assert.equal(allowEventRate(second), false, 'same template with a different ticket is a repeat')
  const different = { level: 'warning', fingerprint: ['sweep'], message: 'OrderHistory timed out' }
  assert.equal(allowEventRate(different), true, 'a new template passes immediately')
})

test('event rate limiter never limits fatal events', () => {
  resetEventRateLimitsForTests()
  const fatal = { level: 'fatal', fingerprint: ['worker'], message: 'uncaught exception' }
  assert.equal(allowEventRate(fatal), true)
  assert.equal(allowEventRate(fatal), true, 'a repeated fatal is still sent')
})

test('event rate limiter re-allows an event after the window expires', async () => {
  resetEventRateLimitsForTests()
  // A tiny window (1ms) configured through the same env path initWorkerSentry
  // uses, so this exercises the real wiring rather than a private setter.
  setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_EVENT_RATE_WINDOW_MS: '1',
  } as NodeJS.ProcessEnv)
  const event = { level: 'error', fingerprint: ['x'], message: 'repeated condition' }
  assert.equal(allowEventRate(event), true)
  assert.equal(allowEventRate(event), false, 'immediately after: still in window')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(allowEventRate(event), true, 'window elapsed: allowed again')
})

test('an empty rate-limit env value keeps limiting enabled (does not mean zero)', () => {
  resetEventRateLimitsForTests()
  setupMock({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
    SENTRY_EVENT_RATE_WINDOW_MS: '',
    SENTRY_EVENT_RATE_MAX: '',
  } as NodeJS.ProcessEnv)
  const event = { level: 'error', fingerprint: ['y'], message: 'still limited' }
  assert.equal(allowEventRate(event), true)
  assert.equal(allowEventRate(event), false, 'empty env must not disable the limiter')
})

test('event rate limiter stays bounded and usable past its key capacity', () => {
  resetEventRateLimitsForTests()
  // 2100 distinct keys exceeds the 2000-key map cap; eviction must not wedge
  // the limiter, and a brand-new key must still be allowed.
  for (let i = 0; i < 2100; i += 1) {
    allowEventRate({ level: 'error', fingerprint: [`k${i}`], message: `unique ${i}` })
  }
  assert.equal(
    allowEventRate({ level: 'error', fingerprint: ['fresh'], message: 'after eviction' }),
    true,
  )
})
