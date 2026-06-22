import { performance } from 'node:perf_hooks'
import { buildIdempotencyKey, queueLaneForParsed } from '../queue/signalQueueConfig'
import {
  DEFAULT_CHANNEL_KEYWORDS,
  parseChannelMessageSync,
} from '../parseSignal'
import type { PipelineTimestamps } from '../pipelineTimestamps'
import { pipelineSummaryPayload } from '../pipelineTimestamps'
import { parsedAction } from '../tradeSignalActions'
import { evaluateParsedSignalExecutionEligibility } from '../signalExecutionEligibility'
import { looksLikeTradingSignal } from '../signalTradingHeuristic'

/** Typical live entry message (Gold buy now + SL/TP). */
export const TELEGRAM_GOLD_BUY_SAMPLE =
  'Gold buy now @ 4500\nSL 4490\nTP: 4510'

export const TELEGRAM_EURUSD_BUY_SAMPLE =
  'BUY EURUSD NOW SL 1.0850 TP 1.0900 TP 1.0950'

export const TELEGRAM_GBPUSD_SELL_SAMPLE =
  'SELL GBPUSD 1.2650\nSL 1.2680\nTP 1.2600'

export const TELEGRAM_USDJPY_BUY_SAMPLE =
  'BUY USDJPY NOW SL 150.50 TP 151.20'

export const TELEGRAM_BTCUSD_BUY_SAMPLE =
  'BTCUSD buy now @ 65000 SL 64000 TP 67000'

export const TELEGRAM_SAMPLE_MESSAGES = [
  TELEGRAM_GOLD_BUY_SAMPLE,
  TELEGRAM_EURUSD_BUY_SAMPLE,
  TELEGRAM_GBPUSD_SELL_SAMPLE,
  TELEGRAM_USDJPY_BUY_SAMPLE,
  TELEGRAM_BTCUSD_BUY_SAMPLE,
] as const

const HEURISTIC_CTX = { keywords: DEFAULT_CHANNEL_KEYWORDS, lexicon: null }

const DEFAULT_REQUEST: TelegramPipelineRequest = {
  userId: 'perf-user-id',
  signalId: 'perf-signal-id',
  brokerAccountId: 'perf-broker-id',
  rawMessage: TELEGRAM_GOLD_BUY_SAMPLE,
}

export type TelegramPipelineRequest = {
  userId: string
  signalId: string
  brokerAccountId: string
  rawMessage: string
}

export type ListenerSyncResult = {
  timestamps: PipelineTimestamps
  parsed: Record<string, unknown> | null
}

export type ConcurrentPipelineResult = {
  samplesMs: number[]
  wallMs: number
  failures: number
  totalRequests: number
}

/**
 * Synchronous listener stages before dispatch transport:
 * heuristic → parse → eligibility → queue job metadata.
 */
export function runTelegramListenerSyncStages(
  rawMessage: string,
  request: Partial<TelegramPipelineRequest> = {},
): ListenerSyncResult {
  const ctx = { ...DEFAULT_REQUEST, ...request, rawMessage }

  const timestamps: PipelineTimestamps = {
    t_telegram_event: performance.now(),
    t_listener_received: performance.now(),
  }

  if (!looksLikeTradingSignal(rawMessage, false, HEURISTIC_CTX)) {
    return { timestamps, parsed: null }
  }

  const parseResult = parseChannelMessageSync(rawMessage, DEFAULT_CHANNEL_KEYWORDS, null)
  timestamps.t_parse_done = performance.now()

  if (parseResult.status !== 'parsed') {
    return { timestamps, parsed: null }
  }

  const eligibility = evaluateParsedSignalExecutionEligibility(
    parseResult.parsed,
    rawMessage,
    DEFAULT_CHANNEL_KEYWORDS,
  )
  if (!eligibility.eligible) {
    return { timestamps, parsed: null }
  }

  const actionClass = parsedAction(parseResult.parsed as { action?: string })
  buildIdempotencyKey({
    signalId: ctx.signalId,
    userId: ctx.userId,
    actionClass,
    brokerAccountId: ctx.brokerAccountId,
  })
  queueLaneForParsed(parseResult.parsed as { action?: string })

  timestamps.t_dispatch_sent = performance.now()
  timestamps.t_dispatch_received = timestamps.t_dispatch_sent

  return { timestamps, parsed: parseResult.parsed as unknown as Record<string, unknown> }
}

/**
 * Full worker-side path through mock-warm broker prep to first OrderSend.
 * Simulates in-process dispatch + prewarmed FXSocket/MT4/MT5 session/symbol caches.
 */
export async function runTelegramToMockBrokerOrderSend(
  rawMessage: string,
  request: Partial<TelegramPipelineRequest> = {},
): Promise<PipelineTimestamps> {
  const { timestamps, parsed } = runTelegramListenerSyncStages(rawMessage, request)
  if (!parsed) {
    throw new Error('telegram pipeline sync stages did not produce a tradable parse')
  }

  timestamps.t_order_send_start = performance.now()

  await Promise.resolve()
  timestamps.t_send_caches_resolved = performance.now()

  await Promise.resolve()
  timestamps.t_first_broker_send = performance.now()
  timestamps.t_last_broker_send = timestamps.t_first_broker_send
  timestamps.t_order_send_done = performance.now()

  return timestamps
}

export function workerSideTelegramToBrokerMs(ts: PipelineTimestamps): number | null {
  const listener = ts.t_listener_received ?? ts.t_telegram_event
  const firstSend = ts.t_first_broker_send
  if (listener == null || firstSend == null) return null
  return firstSend - listener
}

export function parseStageMs(ts: PipelineTimestamps): number | null {
  const summary = pipelineSummaryPayload(ts)
  return typeof summary.parse_ms === 'number' ? summary.parse_ms : null
}

/** Build N users × M trades each (unique user/signal/broker ids). */
export function buildMultiUserTradeRequests(
  userCount: number,
  tradesPerUser: number,
): TelegramPipelineRequest[] {
  const requests: TelegramPipelineRequest[] = []
  for (let userIndex = 0; userIndex < userCount; userIndex++) {
    for (let tradeIndex = 0; tradeIndex < tradesPerUser; tradeIndex++) {
      const messageIndex = (userIndex + tradeIndex) % TELEGRAM_SAMPLE_MESSAGES.length
      requests.push({
        userId: `perf-user-${userIndex}`,
        signalId: `perf-sig-${userIndex}-${tradeIndex}`,
        brokerAccountId: `perf-broker-${userIndex}`,
        rawMessage: TELEGRAM_SAMPLE_MESSAGES[messageIndex]!,
      })
    }
  }
  return requests
}
