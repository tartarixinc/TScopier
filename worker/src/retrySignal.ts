/**
 * Re-dispatch failed/skipped entry signals from Copier Logs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { ENTRY_ZONE_FAR_FROM_MARKET_REASON } from './signalEntryZoneSanity'
import { loadSignalById } from './signalRevision'
import { isEntryAction } from './tradeSignalActions'
import type { TradeExecutor } from './tradeExecutor/TradeExecutor'
import type { SignalRow } from './tradeExecutor/types'
import { SKIP_REASON_ENTRY_NOT_OPENED } from './manualPlanner'
import { applySymbolMapping, brokerHasLinkedSession, brokerSessionUuid } from './tradeExecutor/helpers'
import { channelMatchesBrokerSignal } from './brokerChannelFilter'
import { tradeFailureReasonFromCode } from './brokerTradeError'
import { writeExecutionLog } from './observability/executionLog'
export const SIGNAL_RETRY_DISPATCH_SOURCE = 'signal_retry'
export const AI_REVIEW_MAX_AGE_MS = 2 * 60_000
export const AI_REVIEW_EXPIRED_REASON = 'ai_review_expired'
export const AI_REVIEW_PRICE_PASSED_REASON = 'ai_review_price_passed'

export const RETRYABLE_SIGNAL_SKIP_REASONS = new Set([
  SKIP_REASON_ENTRY_NOT_OPENED,
  ENTRY_ZONE_FAR_FROM_MARKET_REASON,
  'broker_session_not_connected',
  'entry_zone_far_from_market',
  'ai classified as uncertain; human review required',
])

function reviewAgeAllowed(createdAt: string, now = Date.now()): boolean {
  const createdMs = Date.parse(createdAt)
  return Number.isFinite(createdMs) && now - createdMs >= 0 && now - createdMs <= AI_REVIEW_MAX_AGE_MS
}

async function reviewPriceAllowed(
  executor: TradeExecutor,
  signal: NonNullable<Awaited<ReturnType<typeof loadSignalById>>>,
): Promise<boolean> {
  const parsed = signal.parsed_data
  const action = String(parsed?.action ?? '').toLowerCase()
  const symbol = String(parsed?.symbol ?? '').trim()
  const entry = Number(parsed?.entry_price)
  const zoneLow = Number(parsed?.entry_zone_low)
  const zoneHigh = Number(parsed?.entry_zone_high)
  if (!symbol || (action !== 'buy' && action !== 'sell')) return false
  const hasZone = Number.isFinite(zoneLow) && Number.isFinite(zoneHigh) && zoneLow > 0 && zoneHigh > 0
  if (!hasZone && (!Number.isFinite(entry) || entry <= 0)) return false

  const brokers = (executor.brokersByUser.get(signal.user_id) ?? []).filter(b =>
    b.is_active && brokerHasLinkedSession(b) && channelMatchesBrokerSignal(b, signal.channel_id),
  )
  if (brokers.length === 0) return false

  for (const broker of brokers) {
    const uuid = brokerSessionUuid(broker)
    const api = uuid ? executor.apiFor(broker) : null
    if (!uuid || !api) return false
    const brokerSymbol = applySymbolMapping(symbol, broker).symbol
    const params = await executor.getSymbolParams(uuid, brokerSymbol).catch(() => null)
    const point = Number(params?.point ?? 0)
    const tolerancePips = Math.max(0, Number((broker.manual_settings ?? {}).signal_entry_pip_tolerance ?? 10))
    if (!Number.isFinite(point) || point <= 0) return false
    const tolerance = tolerancePips * point
    const quote = await api.quote(uuid, brokerSymbol).catch(() => null)
    if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) return false
    const ref = action === 'buy' ? quote.ask : quote.bid
    const within = hasZone
      ? ref >= Math.min(zoneLow, zoneHigh) - tolerance && ref <= Math.max(zoneLow, zoneHigh) + tolerance
      : Math.abs(ref - entry) <= tolerance
    if (!within) return false
  }
  return true
}

async function expireReviewSignal(
  supabase: SupabaseClient,
  signal: { id: string; user_id: string },
  reason: string,
): Promise<void> {
  await supabase.from('signals').update({ status: 'skipped', skip_reason: reason })
    .eq('id', signal.id).eq('user_id', signal.user_id).eq('status', 'skipped')
}

export type RetrySignalResult = {
  ok: boolean
  accepted?: boolean
  reason?: string
}

export type StructuredRetryability = { retryable: boolean } | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function structuredRetryabilityFromPayload(payload: unknown): StructuredRetryability {
  if (!isRecord(payload)) return null
  const embedded = payload.trade_failure
  if (isRecord(embedded) && typeof embedded.retryable === 'boolean') {
    return { retryable: embedded.retryable }
  }
  const reasonCode = typeof payload.reason_code === 'string'
    ? payload.reason_code
    : typeof payload.skip_reason === 'string'
      ? payload.skip_reason
      : null
  if (!reasonCode) return null
  const reason = tradeFailureReasonFromCode(reasonCode)
  return reason ? { retryable: reason.retryable } : null
}

async function loadLatestStructuredRetryability(
  supabase: SupabaseClient,
  signal: { id: string; user_id: string },
): Promise<StructuredRetryability> {
  const { data, error } = await supabase
    .from('trade_execution_logs')
    .select('request_payload')
    .eq('signal_id', signal.id)
    .eq('user_id', signal.user_id)
    .order('created_at', { ascending: false })
    .limit(10)
  if (error || !data) return null
  for (const row of data as { request_payload?: unknown }[]) {
    const retryability = structuredRetryabilityFromPayload(row.request_payload)
    if (retryability) return retryability
  }
  return null
}

async function resetSignalForRetry(
  supabase: SupabaseClient,
  args: { userId: string; signalId: string },
): Promise<boolean> {
  const { data, error } = await supabase
    .from('signals')
    .update({ status: 'parsed', skip_reason: null })
    .eq('id', args.signalId)
    .eq('user_id', args.userId)
    .in('status', ['executed', 'skipped', 'failed', 'pending'])
    .select('id')
  if (error) {
    console.warn(`[retrySignal] signal reset failed id=${args.signalId}: ${error.message}`)
    return false
  }
  return (data?.length ?? 0) > 0
}

function toDispatchRow(signal: NonNullable<Awaited<ReturnType<typeof loadSignalById>>>): SignalRow {
  return {
    id: signal.id,
    user_id: signal.user_id,
    channel_id: signal.channel_id,
    parsed_data: signal.parsed_data,
    status: 'parsed',
    parent_signal_id: signal.parent_signal_id,
    is_modification: signal.is_modification,
    telegram_message_id: signal.telegram_message_id,
    reply_to_message_id: signal.reply_to_message_id,
    created_at: signal.created_at,
    user_override: signal.user_override,
  }
}

export function isRetryableSignal(signal: {
  status: string
  skip_reason: string | null
  parsed_data: { action?: string } | null
  structuredRetryability?: StructuredRetryability
}): boolean {
  const action = String(signal.parsed_data?.action ?? '').toLowerCase()
  if (!isEntryAction(action)) return false
  const status = String(signal.status).toLowerCase()
  if (signal.structuredRetryability?.retryable === false) return false
  if (status === 'failed') return true
  if (status !== 'skipped') return false
  const reason = String(signal.skip_reason ?? '').trim().toLowerCase()
  if (!reason) return false
  return RETRYABLE_SIGNAL_SKIP_REASONS.has(reason)
}

export async function retrySignal(
  executor: TradeExecutor,
  args: { userId: string; signalId: string },
): Promise<RetrySignalResult> {
  const supabase = executor.supabase
  const existing = await loadSignalById(supabase, args.signalId)
  if (!existing || existing.user_id !== args.userId) {
    return { ok: false, reason: 'signal_not_found' }
  }
  const structuredRetryability = await loadLatestStructuredRetryability(supabase, existing)
  if (!isRetryableSignal({ ...existing, structuredRetryability })) {
    return { ok: false, reason: 'signal_not_retryable' }
  }

  if (String(existing.skip_reason ?? '').trim().toLowerCase() === 'ai classified as uncertain; human review required') {
    if (!reviewAgeAllowed(existing.created_at)) {
      await expireReviewSignal(supabase, existing, AI_REVIEW_EXPIRED_REASON)
      return { ok: false, reason: AI_REVIEW_EXPIRED_REASON }
    }
    if (!(await reviewPriceAllowed(executor, existing))) {
      await expireReviewSignal(supabase, existing, AI_REVIEW_PRICE_PASSED_REASON)
      return { ok: false, reason: AI_REVIEW_PRICE_PASSED_REASON }
    }
  }

  if (existing.status !== 'parsed') {
    const reset = await resetSignalForRetry(supabase, { userId: args.userId, signalId: args.signalId })
    if (!reset) {
      return { ok: false, reason: 'signal_not_retryable' }
    }
  }
  await writeExecutionLog(supabase, {
    user_id: args.userId,
    signal_id: args.signalId,
    action: 'signal_retry',
    status: 'success',
    request_payload: { source: SIGNAL_RETRY_DISPATCH_SOURCE },
  })
  const fresh = await loadSignalById(supabase, args.signalId)
  if (!fresh?.parsed_data?.action) {
    return { ok: false, reason: 'signal_not_found' }
  }

  const accepted = await executor.acceptDispatchSignalAwait(toDispatchRow(fresh), {
    source: SIGNAL_RETRY_DISPATCH_SOURCE,
    priority: 'high',
  })
  if (!accepted) {
    return { ok: false, accepted: false, reason: 'dispatch_not_accepted' }
  }
  return { ok: true, accepted: true }
}
