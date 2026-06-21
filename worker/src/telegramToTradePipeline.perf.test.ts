import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pipelineSummaryPayload } from './pipelineTimestamps'
import {
  TELEGRAM_TO_TRADE_MAX_MS,
  TELEGRAM_TO_TRADE_TARGET_MS,
  TELEGRAM_SYNC_STAGE_TARGET_MS,
} from './test/pipelineLatencyBudgets'
import {
  assertLatencyBudget,
  assertMaxBudget,
  assertP95Budget,
  benchmarkSync,
} from './test/perfBudget'
import {
  runTelegramListenerSyncStages,
  runTelegramToMockBrokerOrderSend,
  TELEGRAM_EURUSD_BUY_SAMPLE,
  TELEGRAM_GOLD_BUY_SAMPLE,
  workerSideTelegramToBrokerMs,
} from './test/telegramPipelineStages'

function syncListenerToDispatchMs(rawMessage: string): number {
  const { timestamps } = runTelegramListenerSyncStages(rawMessage)
  const start = timestamps.t_listener_received
  const end = timestamps.t_dispatch_sent
  assert.ok(start != null && end != null)
  return end - start
}

describe('Telegram → trade pipeline latency (worker-side)', () => {
  it('sync listener→dispatch stages: median ≤ 5ms (Gold buy now)', () => {
    const samples = benchmarkSync(() => {
      syncListenerToDispatchMs(TELEGRAM_GOLD_BUY_SAMPLE)
    }, 300)

    assertLatencyBudget('telegram:listener→dispatch (Gold)', samples, TELEGRAM_SYNC_STAGE_TARGET_MS)
  })

  it('sync listener→dispatch stages: median ≤ 5ms (EURUSD buy now)', () => {
    const samples = benchmarkSync(() => {
      syncListenerToDispatchMs(TELEGRAM_EURUSD_BUY_SAMPLE)
    }, 300)

    assertLatencyBudget('telegram:listener→dispatch (EURUSD)', samples, TELEGRAM_SYNC_STAGE_TARGET_MS)
  })

  it('full worker path to mock OrderSend: median ≤ 5ms target', async () => {
    const samples: number[] = []
    for (let i = 0; i < 200; i++) {
      const ts = await runTelegramToMockBrokerOrderSend(TELEGRAM_GOLD_BUY_SAMPLE)
      const ms = workerSideTelegramToBrokerMs(ts)
      assert.ok(ms != null)
      samples.push(ms)
    }

    assertLatencyBudget(
      'telegram→mock OrderSend (p50 target)',
      samples,
      TELEGRAM_TO_TRADE_TARGET_MS,
    )
  })

  it('full worker path to mock OrderSend: p95 ≤ 80ms ceiling', async () => {
    const samples: number[] = []
    for (let i = 0; i < 250; i++) {
      const ts = await runTelegramToMockBrokerOrderSend(TELEGRAM_GOLD_BUY_SAMPLE)
      const ms = workerSideTelegramToBrokerMs(ts)
      assert.ok(ms != null && ms >= 0)
      samples.push(ms)
    }

    assertP95Budget(
      'telegram→mock OrderSend (p95 ceiling)',
      samples,
      TELEGRAM_TO_TRADE_MAX_MS,
    )
  })

  it('full worker path: no sample exceeds 80ms hard ceiling', async () => {
    const samples: number[] = []
    for (let i = 0; i < 150; i++) {
      const ts = await runTelegramToMockBrokerOrderSend(TELEGRAM_EURUSD_BUY_SAMPLE)
      const ms = workerSideTelegramToBrokerMs(ts)
      assert.ok(ms != null)
      samples.push(ms)
    }

    assertMaxBudget(
      'telegram→mock OrderSend (max ceiling)',
      samples,
      TELEGRAM_TO_TRADE_MAX_MS,
    )
  })

  it('pipeline summary segments stay within parse and prep budgets', async () => {
    const ts = await runTelegramToMockBrokerOrderSend(TELEGRAM_GOLD_BUY_SAMPLE)
    const summary = pipelineSummaryPayload(ts)

    assert.ok(typeof summary.parse_ms === 'number')
    assert.ok((summary.parse_ms as number) <= TELEGRAM_SYNC_STAGE_TARGET_MS * 2)

    const workerMs = workerSideTelegramToBrokerMs(ts)
    assert.ok(workerMs != null)
    assert.ok(workerMs <= TELEGRAM_TO_TRADE_MAX_MS)
  })
})
