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

test('tradeOutcomeIsSuccess treats failures and unknowns as failures', () => {
  assert.equal(tradeOutcomeIsSuccess({ failureReason: 'Order rejected' }), false)
  assert.equal(tradeOutcomeIsSuccess({ openedOrMerged: false }), false)
  assert.equal(tradeOutcomeIsSuccess({}), false)
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
