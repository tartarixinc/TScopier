import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initWorkerSentry,
  resetWorkerSentryForTests,
  setSentryAdapterForTests,
} from './sentry'
import {
  captureBusinessIssue,
  classifyBrokerFailureReason,
  resetBusinessEventsForTests,
} from './businessEvents'
import { captureDeferredBusinessFailure } from './deferredBusinessEvents'

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

function mockSentry() {
  const mock = {
    initCalls: [] as unknown[],
    capturedMessages: [] as unknown[],
    capturedExceptions: [] as unknown[],
    breadcrumbs: [] as unknown[],
    tags: {} as Record<string, string>,
    contexts: {} as Record<string, unknown>,
    scopes: [] as MockScope[],
    flushCalls: [] as number[],
    throwCapture: false,
    init(opts: unknown) { mock.initCalls.push(opts) },
    captureException(err: unknown) {
      mock.capturedExceptions.push(err)
      return 'event-id'
    },
    captureMessage(msg: string, level?: string) {
      if (mock.throwCapture) throw new Error('capture failed')
      mock.capturedMessages.push({ msg, level })
      return 'event-id'
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

function setup() {
  resetWorkerSentryForTests()
  resetBusinessEventsForTests()
  delete process.env.SENTRY_BUSINESS_EVENT_COOLDOWN_MS
  delete process.env.SENTRY_BUSINESS_EVENTS_ENABLED
  const mock = mockSentry()
  setSentryAdapterForTests(mock as never)
  initWorkerSentry({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  return mock
}

test('business event helper never throws and is fire-and-forget', () => {
  const mock = setup()
  mock.throwCapture = true
  assert.doesNotThrow(() => captureBusinessIssue({
    category: 'trade',
    event: 'broker_order_rejected',
    severity: 'error',
    reasonCode: 'BROKER_ORDER_REJECTED',
    message: 'rejected',
    userImpact: 'failed',
  }))
  assert.equal(mock.flushCalls.length, 0)
})

test('business event fingerprints exclude high-cardinality ids and hash user/account context', () => {
  const mock = setup()
  captureBusinessIssue({
    category: 'broker',
    event: 'broker_order_rejected',
    severity: 'error',
    reasonCode: 'INSUFFICIENT_MARGIN',
    message: 'margin rejected',
    userImpact: 'failed',
    context: {
      user_id: 'user-a',
      broker_account_id: 'broker-a',
      signal_id: 'signal-a',
      trade_id: 'trade-a',
      operation: 'order_send',
      broker_provider: 'MT4',
    },
  })
  captureBusinessIssue({
    category: 'broker',
    event: 'broker_order_rejected',
    severity: 'error',
    reasonCode: 'INSUFFICIENT_MARGIN',
    message: 'margin rejected',
    userImpact: 'failed',
    context: {
      user_id: 'user-b',
      broker_account_id: 'broker-b',
      signal_id: 'signal-b',
      trade_id: 'trade-b',
      operation: 'order_send',
      broker_provider: 'MT4',
    },
  })
  assert.equal(mock.scopes.length, 1)
  const scope = mock.scopes[0]!
  assert.deepEqual(scope.fingerprint, ['broker_order_rejected', 'order_send', 'insufficient_margin', 'mt4'])
  const json = JSON.stringify(scope.contexts)
  assert.match(json, /user_hash/)
  assert.match(json, /broker_account_id_hash/)
  assert.match(json, /signal-a/)
  assert.doesNotMatch(json, /user-a/)
  assert.doesNotMatch(json, /broker-a/)
})

test('business event cooldown suppresses duplicates and later events pass', () => {
  const mock = setup()
  process.env.SENTRY_BUSINESS_EVENT_COOLDOWN_MS = '10'
  const event = () => captureBusinessIssue({
    category: 'copier',
    event: 'copier_engine_offline',
    severity: 'error',
    reasonCode: 'COPIER_ENGINE_OFFLINE',
    message: 'offline',
    userImpact: 'failed',
    context: { operation: 'listener_health' },
  })
  event()
  event()
  assert.equal(mock.capturedMessages.length, 1)
  return new Promise<void>(resolve => setTimeout(resolve, 15)).then(() => {
    event()
    assert.equal(mock.capturedMessages.length, 2)
  })
})

test('manual-review events are not suppressed by cooldown', () => {
  const mock = setup()
  captureBusinessIssue({
    category: 'layering',
    event: 'layering_manual_review_required',
    severity: 'error',
    reasonCode: 'BROKER_PENDING_MISSING',
    message: 'manual review',
    userImpact: 'manual_review_required',
  })
  captureBusinessIssue({
    category: 'layering',
    event: 'layering_manual_review_required',
    severity: 'error',
    reasonCode: 'BROKER_PENDING_MISSING',
    message: 'manual review',
    userImpact: 'manual_review_required',
  })
  assert.equal(mock.capturedMessages.length, 2)
})

test('deferred business failure helper emits one redacted fire-and-forget issue', () => {
  const mock = setup()
  captureDeferredBusinessFailure({
    category: 'layering',
    event: 'layering_materialization_failed',
    severity: 'error',
    reasonCode: 'VIRTUAL_MATERIALIZATION_FAILED',
    message: 'deferred virtual materialization failed',
    userImpact: 'partial',
    operation: 'deferred_virtual_pending_materialize',
    err: new Error('session_string=secret account_number=12345678'),
    context: {
      user_id: 'user-a',
      broker_account_id: 'broker-a',
      signal_id: 'signal-a',
      symbol: 'XAUUSD',
      extra: {
        targeted_count: 3,
        successful_count: 0,
        failed_count: 3,
        request_body: { secret: true },
      },
    },
  })
  assert.equal(mock.capturedMessages.length, 1)
  assert.equal(mock.flushCalls.length, 0)
  const json = JSON.stringify(mock.scopes)
  assert.match(json, /broker_database_state_may_disagree/)
  assert.doesNotMatch(json, /secret/)
  assert.doesNotMatch(json, /12345678/)
})

test('business event names and reason codes are stable and redact nested secrets', () => {
  const mock = setup()
  captureBusinessIssue({
    category: 'trade',
    event: 'broker_order_rejected_user_123',
    severity: 'error',
    reasonCode: 'bad code user 123',
    message: 'token Bearer abcdefghijklmnopqrstuvwxyz',
    userImpact: 'failed',
    context: {
      user_id: 'user-secret',
      broker_account_id: 'broker-secret',
      operation: 'order_send',
      extra: {
        authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
        nested: { email: 'person@example.com', account_number: '1234567890' },
      },
    },
  })
  const scope = mock.scopes[0]!
  assert.equal(scope.tags.event_name, 'broker_order_rejected_user_123')
  assert.equal(scope.tags.reason_code, 'BAD_CODE_USER_123')
  const json = JSON.stringify({ messages: mock.capturedMessages, scopes: mock.scopes })
  assert.doesNotMatch(json, /abcdefghijklmnopqrstuvwxyz/)
  assert.doesNotMatch(json, /person@example.com/)
  assert.doesNotMatch(json, /1234567890/)
})

test('classifyBrokerFailureReason separates trading-disabled from missing symbols', () => {
  assert.equal(
    classifyBrokerFailureReason('Trading is disabled for symbol XAUUSD.crp (:1387714)'),
    'BROKER_SYMBOL_TRADE_DISABLED',
  )
  assert.equal(
    classifyBrokerFailureReason('Symbol not found: XAUUSD (:1387714)'),
    'BROKER_SYMBOL_NOT_FOUND',
  )
})
