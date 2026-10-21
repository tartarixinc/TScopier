import test from 'node:test'
import assert from 'node:assert/strict'
import {
  initWorkerSentry,
  resetWorkerSentryForTests,
  setSentryAdapterForTests,
} from './sentry'
import {
  captureWorkerHeartbeatCheckIn,
  resetWorkerHeartbeatForTests,
  workerHeartbeatCheckinMarginMinutes,
  workerHeartbeatIntervalMs,
  workerHeartbeatMonitorConfig,
  workerHeartbeatMonitorSlug,
} from './workerHeartbeat'

class MockScope {
  setLevel() {}
  setTag() {}
  setContext() {}
  setExtra() {}
  setFingerprint() {}
}

function mockSentry() {
  const mock = {
    checkIns: [] as unknown[],
    monitorConfigs: [] as unknown[],
    init() {},
    captureException() { return 'event-id' },
    captureMessage() { return 'event-id' },
    captureCheckIn(checkIn: unknown, monitorConfig?: unknown) {
      mock.checkIns.push(checkIn)
      mock.monitorConfigs.push(monitorConfig)
      return 'check-in-id'
    },
    addBreadcrumb() {},
    setTag() {},
    setContext() {},
    withScope(fn: (scope: MockScope) => void) { fn(new MockScope()) },
    async flush() { return true },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }
  return mock
}

function setupSentry() {
  resetWorkerSentryForTests()
  resetWorkerHeartbeatForTests()
  const mock = mockSentry()
  setSentryAdapterForTests(mock as never)
  initWorkerSentry({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)
  return mock
}

test.afterEach(() => {
  resetWorkerHeartbeatForTests()
  resetWorkerSentryForTests()
})

test('worker heartbeat is disabled unless a monitor slug is configured', () => {
  const mock = setupSentry()

  assert.equal(workerHeartbeatMonitorSlug({} as NodeJS.ProcessEnv), null)
  assert.equal(captureWorkerHeartbeatCheckIn({} as NodeJS.ProcessEnv), null)
  assert.equal(mock.checkIns.length, 0)
})

test('worker heartbeat sends a bounded ok check-in when configured', () => {
  const mock = setupSentry()
  const env = {
    SENTRY_WORKER_HEARTBEAT_MONITOR_SLUG: 'TScopier Worker Trade',
    SENTRY_WORKER_HEARTBEAT_INTERVAL_MS: '60000',
    SENTRY_WORKER_HEARTBEAT_CHECKIN_MARGIN_MINUTES: '3',
  } as NodeJS.ProcessEnv

  const checkInId = captureWorkerHeartbeatCheckIn(env)

  assert.equal(checkInId, 'check-in-id')
  assert.deepEqual(mock.checkIns[0], {
    monitorSlug: 'tscopier-worker-trade',
    status: 'ok',
  })
  assert.deepEqual(mock.monitorConfigs[0], {
    schedule: { type: 'interval', value: 1, unit: 'minute' },
    checkinMargin: 3,
    maxRuntime: 3,
    failureIssueThreshold: 1,
    recoveryThreshold: 1,
    timezone: 'UTC',
  })
})

test('worker heartbeat interval and margin fall back to safe bounds', () => {
  const env = {
    SENTRY_WORKER_HEARTBEAT_INTERVAL_MS: '10',
    SENTRY_WORKER_HEARTBEAT_CHECKIN_MARGIN_MINUTES: '0',
  } as NodeJS.ProcessEnv

  assert.equal(workerHeartbeatIntervalMs(env), 60_000)
  assert.equal(workerHeartbeatCheckinMarginMinutes(env), 1)
  assert.deepEqual(workerHeartbeatMonitorConfig(env).schedule, {
    type: 'interval',
    value: 1,
    unit: 'minute',
  })
})

test('worker heartbeat check-in failure is swallowed by sentry wrapper', () => {
  resetWorkerSentryForTests()
  const mock = mockSentry()
  mock.captureCheckIn = () => { throw new Error('sentry down') }
  setSentryAdapterForTests(mock as never)
  initWorkerSentry({
    SENTRY_ENABLED: 'true',
    SENTRY_DSN: 'https://public@example.invalid/1',
  } as NodeJS.ProcessEnv)

  assert.doesNotThrow(() => captureWorkerHeartbeatCheckIn({
    SENTRY_WORKER_HEARTBEAT_MONITOR_SLUG: 'worker-heartbeat',
  } as NodeJS.ProcessEnv))
})
