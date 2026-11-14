import type { SupabaseClient } from '@supabase/supabase-js'
import type { CopierLogsTranslations } from '../i18n/locales/types'
import type { Signal } from '../types/database'
import {
  COPIER_SKIP_REASON_DETAILS,
  COPIER_SKIP_REASON_LABELS,
  resolveCopierSkipReasonKey,
} from './copierSkipReasonLabels'
import {
  resolveTradeFailureDisplay,
  type TradeFailureDisplay,
} from './tradeFailureDisplay'

export type CopierExecutionLogRow = {
  action: string
  status: string
  error_message: string | null
  request_payload: Record<string, unknown> | null
  created_at: string
}

export type CopierBrokerFailureRow = {
  action: string
  status: string
  error_message: string | null
  request_payload: Record<string, unknown> | null
  created_at: string
}

/**
 * Fetch failed broker executions for a trade's signal family: the linked entry
 * signal plus its management child signals (parent_signal_id → entry).
 * Broker rejections are logged as `trade_execution_logs` rows with
 * `status='failed'` under the signal that triggered them.
 */
export async function fetchBrokerFailuresForTrade(
  supabase: SupabaseClient,
  args: { userId: string; signalId: string; brokerAccountId: string },
): Promise<CopierBrokerFailureRow[]> {
  const { data: children } = await supabase
    .from('signals')
    .select('id')
    .eq('user_id', args.userId)
    .eq('parent_signal_id', args.signalId)
    .limit(50)

  const signalIds = [args.signalId, ...((children ?? []) as { id: string }[]).map(c => c.id)]

  const { data, error } = await supabase
    .from('trade_execution_logs')
    .select('action, status, error_message, request_payload, created_at')
    .in('signal_id', signalIds)
    .eq('user_id', args.userId)
    .eq('broker_account_id', args.brokerAccountId)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(10)

  if (error || !data?.length) return []
  return data as CopierBrokerFailureRow[]
}

/** Friendly one-line summary of a failed broker execution log row. */
export function formatBrokerFailureRow(
  row: CopierBrokerFailureRow,
  copierLogs: CopierLogsTranslations,
): string {
  const structured = getTradeFailureDisplayFromLog(row)
  if (structured) return structured.title
  const err = String(row.error_message ?? '').trim()
  if (row.action === 'order_send' && err) {
    return formatCopierSkipReasonShort(err, copierLogs)
  }
  const actionLabel = row.action.replace(/_/g, ' ')
  if (err) return `${actionLabel}: ${formatCopierSkipReasonShort(err, copierLogs)}`
  return actionLabel
}

export function getTradeFailureDisplayFromLog(row: {
  error_message: string | null
  request_payload: Record<string, unknown> | null
}): TradeFailureDisplay | null {
  return resolveTradeFailureDisplay({
    payload: row.request_payload,
    legacyMessage: row.error_message,
  })
}

export function formatCopierSkipReasonShort(
  reason: string | null | undefined,
  copierLogs: CopierLogsTranslations,
): string {
  const raw = String(reason ?? '').trim()
  if (!raw) return '—'
  const key = resolveCopierSkipReasonKey(raw)
  return (
    copierLogs.skipReasons[key]
    ?? COPIER_SKIP_REASON_LABELS[key]
    ?? raw.replace(/_/g, ' ')
  )
}

export function formatCopierSkipReasonDetail(
  reason: string | null | undefined,
  copierLogs: CopierLogsTranslations,
): string | null {
  const raw = String(reason ?? '').trim()
  if (!raw) return null
  const key = resolveCopierSkipReasonKey(raw)
  return (
    copierLogs.skipReasonDetails?.[key]
    ?? COPIER_SKIP_REASON_DETAILS[key]
    ?? null
  )
}

export function formatParsedLevels(signal: Signal): {
  entry: string | null
  sl: string | null
  tp: string | null
} {
  const parsed = signal.parsed_data as Record<string, unknown> | null
  if (!parsed) return { entry: null, sl: null, tp: null }

  const fmt = (v: unknown): string | null => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n > 0 ? String(n) : null
  }

  const entry =
    fmt(parsed.entry_price)
    ?? fmt(parsed.entry)
    ?? (parsed.entry_zone_low != null && parsed.entry_zone_high != null
      ? `${parsed.entry_zone_low}–${parsed.entry_zone_high}`
      : null)

  const tpList = Array.isArray(parsed.tp)
    ? parsed.tp
        .map(fmt)
        .filter((v): v is string => v != null)
    : []

  return {
    entry,
    sl: fmt(parsed.sl),
    tp: tpList.length ? tpList.join(', ') : null,
  }
}

/** Drop synthetic pre-attempt markers that were logged as status=success. */
export function isDispatchPushStartMarker(row: {
  action: string
  request_payload?: Record<string, unknown> | null
}): boolean {
  if (row.action !== 'dispatch_push_attempt') return false
  return String(row.request_payload?.phase ?? '') === 'start'
}

export function summarizeDispatchPushAttempt(row: CopierExecutionLogRow): string {
  const payload = row.request_payload ?? {}
  const attempt = Number(payload.attempt)
  const attemptLabel = Number.isFinite(attempt) && attempt > 0 ? ` #${attempt}` : ''
  if (row.status === 'success') {
    return `Dispatch to trade worker${attemptLabel} succeeded`
  }
  const statusCode = Number(payload.status_code)
  const detail = String(payload.detail ?? payload.reason ?? '').trim().toLowerCase()
  if (statusCode === 429 || detail.includes('rate limit')) {
    return `Dispatch to trade worker${attemptLabel} rate-limited — retrying or using backup`
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504
    || detail.includes('failed to respond') || detail.includes('application failed')) {
    return `Dispatch to trade worker${attemptLabel} — worker unreachable (will retry / backup)`
  }
  if (statusCode === 0 || detail.includes('timeout') || detail.includes('trade-push-timeout')) {
    return `Dispatch to trade worker${attemptLabel} timed out — retrying or using backup`
  }
  if (statusCode === 401 || statusCode === 403) {
    return `Dispatch to trade worker${attemptLabel} unauthorized — check worker token`
  }
  if (detail.includes('wrong_shard') || String(payload.reason ?? '') === 'wrong_shard') {
    return `Dispatch to trade worker${attemptLabel} hit wrong shard — using backup path`
  }
  if (String(payload.phase ?? '') === 'breaker_short_circuit') {
    return 'Dispatch paused briefly after repeated worker auth/route failures'
  }
  const snippet = String(payload.reason ?? payload.detail ?? '').trim()
  if (snippet) {
    return `Dispatch to trade worker${attemptLabel} failed: ${snippet.slice(0, 80)}`
  }
  return `Dispatch to trade worker${attemptLabel} failed`
}

export async function fetchCopierLogExecutionDetails(
  supabase: SupabaseClient,
  signalId: string,
): Promise<CopierExecutionLogRow[]> {
  const { data, error } = await supabase
    .from('trade_execution_logs')
    .select('action, status, error_message, request_payload, created_at')
    .eq('signal_id', signalId)
    .order('created_at', { ascending: true })
    .limit(40)

  if (error || !data?.length) return []

  const rows = (data as CopierExecutionLogRow[]).filter(row => !isDispatchPushStartMarker(row))
  return rows.slice(0, 20)
}

export function summarizeExecutionLogRow(
  row: CopierExecutionLogRow,
  copierLogs: CopierLogsTranslations,
): string {
  const payload = row.request_payload ?? {}
  const structured = getTradeFailureDisplayFromLog(row)
  if (structured) return structured.title
  if (row.action === 'dispatch_push_attempt') {
    return summarizeDispatchPushAttempt(row)
  }
  const skipReason = String(payload.skip_reason ?? row.error_message ?? '').trim()
  if (row.action === 'dispatch_skipped' && skipReason) {
    return formatCopierSkipReasonShort(skipReason, copierLogs)
  }
  if (row.action === 'order_send' && row.status === 'failed') {
    const err = String(row.error_message ?? 'Order failed').trim()
    return formatCopierSkipReasonShort(err, copierLogs)
  }
  if (row.action === 'pipeline_summary') {
    const failure = String(payload.failure_reason ?? '').trim()
    if (failure) return formatCopierSkipReasonShort(failure, copierLogs)
  }
  const actionLabel = row.action.replace(/_/g, ' ')
  if (row.error_message) {
    return `${actionLabel}: ${formatCopierSkipReasonShort(row.error_message, copierLogs)}`
  }
  return `${actionLabel} (${row.status})`
}
