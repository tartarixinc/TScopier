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

const HEURISTIC_CTX = { keywords: DEFAULT_CHANNEL_KEYWORDS, lexicon: null }

export type ListenerSyncResult = {
  timestamps: PipelineTimestamps
  parsed: Record<string, unknown> | null
}

/**
 * Synchronous listener stages before dispatch transport:
 * heuristic → parse → eligibility → queue job metadata.
 */
export function runTelegramListenerSyncStages(rawMessage: string): ListenerSyncResult {
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
    signalId: 'perf-signal-id',
    userId: 'perf-user-id',
    actionClass,
    brokerAccountId: 'perf-broker-id',
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
): Promise<PipelineTimestamps> {
  const { timestamps, parsed } = runTelegramListenerSyncStages(rawMessage)
  if (!parsed) {
    throw new Error('telegram pipeline sync stages did not produce a tradable parse')
  }

  timestamps.t_order_send_start = performance.now()

  // Prewarmed session + symbol + params (no live MT terminal).
  await Promise.resolve()
  timestamps.t_send_caches_resolved = performance.now()

  // planManualOrders + leg assembly (sync work, no network).
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
