import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TradeExecutionMonitor,
  resetTradeExecutionMonitorForTests,
  tradeOutcomeIsSuccess,
} from './tradeExecutionMonitor'

test.afterEach(() => {
  resetTradeExecutionMonitorForTests()
})

test('tradeOutcomeIsSuccess classifies opened/merged as success', () => {
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: true }), true)
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: true, failureReason: 'boom' }), false)
})

test('tradeOutcomeIsSuccess treats deterministic skips as non-failures', () => {
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: false, finalizeSkipReason: 'signal_entry_range_expired' }), true)
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: false, finalizeSkipReason: 'add_new_trades_to_existing=false' }), true)
})

test('tradeOutcomeIsSuccess treats guard refusals and prepare-phase exits as non-failures', () => {
  // Merge/teaser guard refusals return openedOrMerged:false with no reason.
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: false }), true)
  // Prepare-phase policy exits return an empty outcome (symbol exempted,
  // news blackout, no broker API, empty plan).
  assert.equal(tradeOutcomeIsSuccess({}), true)
})

test('tradeOutcomeIsSuccess treats deferral and skip flags as non-failures', () => {
  assert.equal(tradeOutcomeIsSuccess({ signalRangeEntryDeferred: true }), true)
  assert.equal(tradeOutcomeIsSuccess({ signalEntryRequiredSkip: true }), true)
  assert.equal(tradeOutcomeIsSuccess({ signalRangeEntryRequiredSkip: true }), true)
  assert.equal(
    tradeOutcomeIsSuccess({ openedOrMerged: false, signalRangeEntryDeferred: true, channelDelayMs: 5 }),
    true,
  )
})

test('tradeOutcomeIsSuccess treats only explicit failure reasons as failures', () => {
  assert.equal(tradeOutcomeIsSuccess({ failureReason: 'Order rejected' }), false)
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: false, failureReason: 'Not enough money' }), false)
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: true, failureReason: 'boom' }), false)
})

test('no alert below min attempts', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 5; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 0)
})

test('alert fires when failure rate >= threshold with enough attempts', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 7; i++) m.recordExecution(false, 'b1', 'ERR')
  for (let i = 0; i < 3; i++) m.recordExecution(true, 'b1')
  assert.equal(alerted, 1)
  // Still above threshold, so no re-alert on more failures (no storm).
  for (let i = 0; i < 5; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 1)
})

test('recovers and re-arms so a later spike can alert again', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 7; i++) m.recordExecution(false, 'b1', 'ERR')
  for (let i = 0; i < 3; i++) m.recordExecution(true, 'b1')
  assert.equal(alerted, 1)
  // Recover: enough successes to push rate below 50%.
  for (let i = 0; i < 8; i++) m.recordExecution(true, 'b1')
  assert.equal(alerted, 1)
  // Second spike: 8 failures + 18 history => rate crosses 50% again => new alert.
  for (let i = 0; i < 8; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 2)
})

test('no alert when failure rate is below threshold', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 90,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 3; i++) m.recordExecution(false, 'b1', 'ERR')
  for (let i = 0; i < 7; i++) m.recordExecution(true, 'b1')
  assert.equal(alerted, 0)
})

test('old records outside window are pruned and do not count', () => {
  let now = 1_000_000
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 3,
    failureThresholdPct: 50,
    nowMs: () => now,
    onAlert: () => { alerted += 1 },
  })
  m.recordExecution(false, 'b1', 'ERR') // old failure at t=1_000_000
  now += 301_000
  m.recordExecution(true, 'b1')
  m.recordExecution(true, 'b1')
  m.recordExecution(true, 'b1')
  // Old failure pruned; 3 successes => 0% failure => no alert.
  assert.equal(alerted, 0)
  assert.equal(m.getStats().failures, 0)
})

test('disabled monitor records nothing and never alerts', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    enabled: false,
    minAttempts: 1,
    failureThresholdPct: 1,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 0)
  assert.equal(m.getStats().total, 0)
})

test('reset clears history and allows a fresh alert', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 3,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 3; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 1)
  m.reset()
  for (let i = 0; i < 3; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 2)
})

test('per-account trading-disabled failures do not trip the systemic alert', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 12; i++) m.recordExecution(false, 'b1', 'BROKER_SYMBOL_TRADE_DISABLED')
  assert.equal(alerted, 0)
})

test('money and credential rejections do not trip the systemic alert', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 12; i++) {
    m.recordExecution(false, 'b1', 'There is not enough money to complete the request (:252862389)')
  }
  for (let i = 0; i < 6; i++) m.recordExecution(false, 'b1', 'Missing or invalid access token')
  for (let i = 0; i < 6; i++) m.recordExecution(false, 'b1', 'Invalid account (:62136328)')
  for (let i = 0; i < 6; i++) m.recordExecution(false, 'b1', 'INSUFFICIENT_MARGIN')
  assert.equal(alerted, 0)
})

test('symbol-not-found rejections do not trip the systemic alert', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'BROKER_SYMBOL_NOT_FOUND')
  for (let i = 0; i < 6; i++) m.recordExecution(false, 'b1', 'XAUUSD not exist')
  assert.equal(alerted, 0)
})

test('session availability failures still count toward the systemic alert', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'BROKER_ACCOUNT_UNAVAILABLE')
  assert.equal(alerted, 1)
})

test('non-symbol "not exist" text still counts toward the systemic alert', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'order not exist')
  assert.equal(alerted, 1)
})

test('excluded rejections still count as attempts in the denominator', () => {
  let alerted = 0
  const m = new TradeExecutionMonitor({
    windowMs: 300_000,
    minAttempts: 10,
    failureThresholdPct: 50,
    onAlert: () => { alerted += 1 },
  })
  // 10 excluded rejections + 10 successes: 0% system failures => quiet.
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'Not enough money')
  for (let i = 0; i < 10; i++) m.recordExecution(true, 'b1')
  assert.equal(alerted, 0)
  // +10 real failures: 10/30 = 33% => still below threshold => quiet.
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 0)
  // +10 more real failures: 20/40 = 50% => threshold crossed => alert.
  for (let i = 0; i < 10; i++) m.recordExecution(false, 'b1', 'ERR')
  assert.equal(alerted, 1)
})
