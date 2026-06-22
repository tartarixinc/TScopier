import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LOAD_BURST_CONCURRENCY,
  LOAD_BURST_TRADES_PER_USER,
  LOAD_BURST_USER_COUNT,
  LOAD_TEST_CONCURRENCY,
  LOAD_TEST_TRADES_PER_USER,
  LOAD_TEST_USER_COUNT,
  TELEGRAM_TO_TRADE_MAX_MS,
  TELEGRAM_TO_TRADE_TARGET_MS,
} from './test/pipelineLatencyBudgets'
import {
  assertLatencyBudget,
  assertMaxBudget,
  assertP95Budget,
  percentileMs,
} from './test/perfBudget'
import { runMultiUserTradeLoad } from './test/telegramPipelineLoad'

describe('Telegram → trade concurrent load (multi-user, multi-trade)', () => {
  it(`${LOAD_TEST_USER_COUNT} users × ${LOAD_TEST_TRADES_PER_USER} trades: all succeed`, async () => {
    const result = await runMultiUserTradeLoad(
      LOAD_TEST_USER_COUNT,
      LOAD_TEST_TRADES_PER_USER,
      LOAD_TEST_CONCURRENCY,
    )

    const expected = LOAD_TEST_USER_COUNT * LOAD_TEST_TRADES_PER_USER
    assert.equal(result.totalRequests, expected)
    assert.equal(result.failures, 0)
    assert.equal(result.samplesMs.length, expected)
  })

  it(`${LOAD_TEST_USER_COUNT} users × ${LOAD_TEST_TRADES_PER_USER} trades: per-request median ≤ 80ms under load`, async () => {
    const result = await runMultiUserTradeLoad(
      LOAD_TEST_USER_COUNT,
      LOAD_TEST_TRADES_PER_USER,
      LOAD_TEST_CONCURRENCY,
    )

    // Under concurrency, p50 rises vs idle (5ms target); hard ceiling remains 80ms.
    assertLatencyBudget(
      `concurrent ${LOAD_TEST_USER_COUNT}×${LOAD_TEST_TRADES_PER_USER} (median under load)`,
      result.samplesMs,
      TELEGRAM_TO_TRADE_MAX_MS,
    )
  })

  it(`${LOAD_TEST_USER_COUNT} users × ${LOAD_TEST_TRADES_PER_USER} trades: per-request p95 ≤ 80ms`, async () => {
    const result = await runMultiUserTradeLoad(
      LOAD_TEST_USER_COUNT,
      LOAD_TEST_TRADES_PER_USER,
      LOAD_TEST_CONCURRENCY,
    )

    assertP95Budget(
      `concurrent ${LOAD_TEST_USER_COUNT}×${LOAD_TEST_TRADES_PER_USER} (p95)`,
      result.samplesMs,
      TELEGRAM_TO_TRADE_MAX_MS,
    )
  })

  it(`${LOAD_TEST_USER_COUNT} users × ${LOAD_TEST_TRADES_PER_USER} trades: no request exceeds 80ms`, async () => {
    const result = await runMultiUserTradeLoad(
      LOAD_TEST_USER_COUNT,
      LOAD_TEST_TRADES_PER_USER,
      LOAD_TEST_CONCURRENCY,
    )

    assertMaxBudget(
      `concurrent ${LOAD_TEST_USER_COUNT}×${LOAD_TEST_TRADES_PER_USER} (max)`,
      result.samplesMs,
      TELEGRAM_TO_TRADE_MAX_MS,
    )
  })

  it(`${LOAD_BURST_USER_COUNT} users × ${LOAD_BURST_TRADES_PER_USER} trades burst: all succeed under load`, async () => {
    const result = await runMultiUserTradeLoad(
      LOAD_BURST_USER_COUNT,
      LOAD_BURST_TRADES_PER_USER,
      LOAD_BURST_CONCURRENCY,
    )

    const expected = LOAD_BURST_USER_COUNT * LOAD_BURST_TRADES_PER_USER
    assert.equal(result.totalRequests, expected)
    assert.equal(result.failures, 0)
    assert.equal(result.samplesMs.length, expected)

    assertP95Budget(
      `burst ${LOAD_BURST_USER_COUNT}×${LOAD_BURST_TRADES_PER_USER} (p95)`,
      result.samplesMs,
      TELEGRAM_TO_TRADE_MAX_MS,
    )

    assertMaxBudget(
      `burst ${LOAD_BURST_USER_COUNT}×${LOAD_BURST_TRADES_PER_USER} (max)`,
      result.samplesMs,
      TELEGRAM_TO_TRADE_MAX_MS,
    )
  })

  it('concurrent batch completes with bounded per-request latency spread', async () => {
    const result = await runMultiUserTradeLoad(
      LOAD_BURST_USER_COUNT,
      LOAD_BURST_TRADES_PER_USER,
      LOAD_BURST_CONCURRENCY,
    )

    const p50 = percentileMs(result.samplesMs, 50)
    const p95 = percentileMs(result.samplesMs, 95)
    const max = Math.max(...result.samplesMs)
    const multiplier = Number(process.env.WORKER_PERF_BUDGET_MULTIPLIER ?? 1)

    assert.ok(p95 <= Math.max(TELEGRAM_TO_TRADE_MAX_MS, p50 * 16))
    assert.ok(max <= TELEGRAM_TO_TRADE_MAX_MS * multiplier)
    assert.ok(result.wallMs > 0)
  })
})
