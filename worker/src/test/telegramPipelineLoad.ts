import { performance } from 'node:perf_hooks'
import { parallelMap } from '../parallelPool'
import {
  buildMultiUserTradeRequests,
  runTelegramToMockBrokerOrderSend,
  workerSideTelegramToBrokerMs,
  type ConcurrentPipelineResult,
  type TelegramPipelineRequest,
} from './telegramPipelineStages'

/**
 * Run many users × many trades concurrently (mock-warm broker path).
 * Uses the same bounded-concurrency pool as management leg execution.
 */
export async function runConcurrentTelegramToTradePipeline(
  requests: TelegramPipelineRequest[],
  concurrency: number,
): Promise<ConcurrentPipelineResult> {
  const samplesMs: number[] = []
  let failures = 0
  const wallStart = performance.now()

  await parallelMap(requests, concurrency, async (req) => {
    try {
      const ts = await runTelegramToMockBrokerOrderSend(req.rawMessage, req)
      const ms = workerSideTelegramToBrokerMs(ts)
      if (ms == null || ms < 0) {
        failures += 1
        return
      }
      samplesMs.push(ms)
    } catch {
      failures += 1
    }
  })

  return {
    samplesMs,
    wallMs: performance.now() - wallStart,
    failures,
    totalRequests: requests.length,
  }
}

export async function runMultiUserTradeLoad(
  userCount: number,
  tradesPerUser: number,
  concurrency: number,
): Promise<ConcurrentPipelineResult> {
  const requests = buildMultiUserTradeRequests(userCount, tradesPerUser)
  return runConcurrentTelegramToTradePipeline(requests, concurrency)
}
