import type { ChannelWorkerTranslations } from '../i18n/channelWorker/types'
import { interpolate } from '../i18n/interpolate'
import {
  instrumentGuessFromRawTelegram,
  isPlausibleCopierSymbol,
  MANAGEMENT_COPIER_ACTIONS,
} from './copierLogDisplay'

export type ChannelWorkerLogRow = {
  action: string
  status: string
  request_payload: Record<string, unknown> | null
  response_payload: Record<string, unknown> | null
  error_message: string | null
  signals?: {
    channel_id?: string | null
    parsed_data?: Record<string, unknown> | null
    raw_message?: string | null
    status?: string | null
    skip_reason?: string | null
  } | null
}

function isNonTradeSkipReason(value: unknown): boolean {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  return normalized === 'non_trade_message'
}

function normalizeSkipReasonKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/** Expected setup gaps — hidden from the Channel Worker feed to reduce noise. */
const SILENCED_CHANNEL_WORKER_SKIP_REASONS = new Set([
  'no_broker_channel_match',
])

export function isSilencedChannelWorkerSkipReason(value: unknown): boolean {
  return SILENCED_CHANNEL_WORKER_SKIP_REASONS.has(normalizeSkipReasonKey(value))
}

function resolveLogSkipReason(row: ChannelWorkerLogRow): string {
  return String(
    row.signals?.skip_reason ?? row.request_payload?.skip_reason ?? row.error_message ?? '',
  ).trim()
}

export function resolveChannelNameFromLog(
  row: ChannelWorkerLogRow,
  channelDisplayNames?: Record<string, string>,
): string | null {
  const payload = row.request_payload ?? {}
  const fromPayloadName =
    typeof payload.channel_name === 'string' ? payload.channel_name.trim() : ''
  if (fromPayloadName) return fromPayloadName

  const channelId =
    (typeof payload.channel_id === 'string' ? payload.channel_id : null) ??
    row.signals?.channel_id ??
    null
  if (!channelId || !channelDisplayNames) return null
  const label = channelDisplayNames[channelId]?.trim()
  return label || null
}

function shouldOmitChannelSuffix(logAction: string): boolean {
  return logAction === 'pipeline_parse_dispatch'
    || logAction === 'handle_start'
    || logAction === 'handle_end'
    || logAction === 'dispatch_received'
}

function withFromChannel(
  message: string,
  channel: string | null,
  cw: ChannelWorkerTranslations,
): string {
  if (!channel) return message
  const suffix = interpolate(cw.fromChannel, { channel })
  if (message.endsWith('.')) return `${message.slice(0, -1)}${suffix}.`
  return `${message}${suffix}`
}

function cleanSymbolLabel(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!s || s === 'null' || s === 'undefined' || s === 'trade') return null
  return s
}

function symbolFromRecord(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const raw = cleanSymbolLabel((data as Record<string, unknown>).symbol)
  if (!raw || !isPlausibleCopierSymbol(raw)) return null
  return raw.toUpperCase().replace(/\s+/g, '')
}

/** Parsed signal fields attached to a log row (request, response, or linked signal). */
export function getSignalParsedFromLog(row: ChannelWorkerLogRow): Record<string, unknown> {
  const payload = row.request_payload ?? {}
  const response = row.response_payload ?? {}
  if (row.action === 'keyword_parse' && response && typeof response === 'object' && 'action' in response) {
    return response as Record<string, unknown>
  }
  const reqParsed = payload.parsed
  if (reqParsed && typeof reqParsed === 'object') return reqParsed as Record<string, unknown>
  if (row.signals?.parsed_data && typeof row.signals.parsed_data === 'object') {
    return row.signals.parsed_data as Record<string, unknown>
  }
  return {}
}

function collectSymbolHints(node: unknown, out: Set<string>, depth: number): void {
  if (depth <= 0 || node == null) return
  if (typeof node === 'string') {
    const s = node.trim().toUpperCase().replace(/\s+/g, '')
    if (s && /^[A-Z0-9._]{5,}$/.test(s) && isPlausibleCopierSymbol(s)) out.add(s)
    return
  }
  if (typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const x of node) collectSymbolHints(x, out, depth - 1)
    return
  }
  const o = node as Record<string, unknown>
  for (const k of ['symbol', 'Symbol', 'name', 'Name']) {
    const sym = symbolFromRecord({ symbol: o[k] })
    if (sym) out.add(sym)
  }
  for (const v of Object.values(o)) collectSymbolHints(v, out, depth - 1)
}

function symbolFromMtResponse(response: Record<string, unknown> | null | undefined): string | null {
  if (!response) return null
  const hints = new Set<string>()
  collectSymbolHints(response, hints, 5)
  return hints.values().next().value ?? null
}

/** Resolved instrument code (e.g. XAUUSD), or null when unknown. */
export function resolveInstrumentSymbol(row: ChannelWorkerLogRow): string | null {
  const payload = row.request_payload ?? {}
  const response = row.response_payload ?? {}
  const parsed = getSignalParsedFromLog(row)

  const fromParsed = symbolFromRecord(parsed)
  const fromResponseParsed = symbolFromRecord(response)
  const fromPayloadSymbol = cleanSymbolLabel(payload.symbol)
  const fromMt = symbolFromMtResponse(response)
  const fromTelegram = instrumentGuessFromRawTelegram(row.signals?.raw_message)

  const signalAction = String(parsed.action ?? '').toLowerCase()
  const logAction = row.action.toLowerCase()
  const isMgmt =
    logAction.startsWith('mgmt_') ||
    MANAGEMENT_COPIER_ACTIONS.has(signalAction) ||
    MANAGEMENT_COPIER_ACTIONS.has(logAction.replace(/^mgmt_/, ''))

  const fromPayload =
    fromPayloadSymbol && isPlausibleCopierSymbol(fromPayloadSymbol) ? fromPayloadSymbol.toUpperCase() : null

  if (isMgmt) {
    const mgmtCorr = payload.management_correlation as Record<string, unknown> | undefined
    const fromCorr = cleanSymbolLabel(mgmtCorr?.effective_symbol)
    const corr =
      fromCorr && isPlausibleCopierSymbol(fromCorr) ? fromCorr.toUpperCase() : null
    return corr ?? fromMt ?? fromTelegram ?? fromParsed ?? fromResponseParsed ?? fromPayload ?? null
  }

  return fromParsed ?? fromResponseParsed ?? fromPayload ?? fromMt ?? fromTelegram ?? null
}

/** @deprecated Use resolveInstrumentSymbol; kept for callers expecting a string fallback. */
export function resolveChannelWorkerSymbol(row: ChannelWorkerLogRow): string {
  return resolveInstrumentSymbol(row) ?? 'your trade'
}

function formatLot(lots: number): string {
  if (!Number.isFinite(lots) || lots <= 0) return ''
  const n = lots >= 1 ? Number(lots.toFixed(2)) : Number.parseFloat(lots.toFixed(8))
  return String(n)
}

function signalActionFromLog(row: ChannelWorkerLogRow): string {
  const parsed = getSignalParsedFromLog(row)
  const fromParsed = String(parsed.action ?? '').toLowerCase()
  if (fromParsed) return fromParsed
  const logAction = row.action.toLowerCase()
  if (logAction.startsWith('mgmt_')) return logAction.slice(5)
  return logAction
}

function translateBrokerError(message: string, cw: ChannelWorkerTranslations): string {
  if (/uuid\s*~~\*|operator does not exist.*uuid/i.test(message)) {
    return cw.errorSignalLinkFailed ?? 'Could not link this trade to its signal.'
  }
  const ticket = message.match(/Ticket\s+(\d+)\s+not found/i)
  if (ticket) return interpolate(cw.errorTicketNotFound, { ticket: ticket[1] })
  const sym = message.match(/symbol not found:\s*([A-Z0-9._#+]+)/i)
  if (sym) return interpolate(cw.errorSymbolNotFound, { symbol: sym[1]!.toUpperCase() })
  if (/not connected/i.test(message) || /broker session is not connected/i.test(message)) {
    return cw.errorBrokerNotConnected
  }
  if (/order rejected|invalid stops?|invalid stop/i.test(message)) {
    return cw.errorInvalidStops
  }
  if (/object reference not set|nullreferenceexception|an error occurred while handling/i.test(message)) {
    return cw.errorBridgeGlitch
  }
  if (/already\s+have\s+(this\s+)?parameters/i.test(message)) {
    return cw.errorStopsAlreadySet
  }
  return message
}

function isBenignStopsAlreadySetMessage(message: string | null | undefined): boolean {
  if (!message?.trim()) return false
  return /already\s+have\s+(this\s+)?parameters/i.test(message)
}

function errSuffix(row: ChannelWorkerLogRow, cw: ChannelWorkerTranslations): string {
  if (!row.error_message) return ''
  if (isBenignStopsAlreadySetMessage(row.error_message)) return ''
  return interpolate(cw.errSuffix, { detail: translateBrokerError(row.error_message, cw) })
}

function translateSkipReason(reason: string, cw: ChannelWorkerTranslations): string {
  const key = reason.trim().toLowerCase()
  return cw.skipReasons[key] ?? reason.replace(/_/g, ' ')
}

const SYMBOL_EXEMPTED_SKIP_REASONS = new Set([
  'symbol_exempted_from_trading',
  'symbol_not_in_whitelist',
  'symbol_excluded',
])

function symbolFromNotFoundError(message: string): string | null {
  const m = message.match(/symbol not found:\s*([A-Z0-9._#+]+)/i)
  return m?.[1]?.toUpperCase() ?? null
}

function cleanTradeSymbol(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : ''
  return s && isPlausibleCopierSymbol(s) ? s.replace(/\s+/g, '') : null
}

function allowedSymbolsFromPayload(payload: Record<string, unknown>): string[] {
  const raw = payload.allowed_symbols ?? payload.allowed
  if (!Array.isArray(raw)) return []
  return raw.map(s => String(s).toUpperCase()).filter(Boolean)
}

function forInstrument(instr: string | null, cw: ChannelWorkerTranslations): string {
  return instr ? interpolate(cw.forSymbol, { symbol: instr }) : ''
}

function onInstrument(instr: string | null, cw: ChannelWorkerTranslations): string {
  return instr ? interpolate(cw.onSymbol, { symbol: instr }) : cw.onOpenTrade
}

function namedOrGeneric(
  instr: string | null,
  named: (symbol: string) => string,
  generic: () => string,
): string {
  return instr ? named(instr) : generic()
}

function pctSuffix(frac: number): string {
  if (!Number.isFinite(frac) || frac <= 0 || frac > 1) return ''
  return ` (${Math.round(frac * 100)}%)`
}

function slPart(newSl: unknown, cw: ChannelWorkerTranslations, mode: 'to' | 'at' | 'paren'): string {
  if (newSl == null || newSl === '') return ''
  const sl = String(newSl)
  if (mode === 'paren') return interpolate(cw.slParen, { sl })
  if (mode === 'at') return interpolate(cw.slAt, { sl })
  return interpolate(cw.slTo, { sl })
}

function localizedSide(side: string, cw: ChannelWorkerTranslations): string {
  if (side === 'buy') return cw.sideBuy
  if (side === 'sell') return cw.sideSell
  return side
}

function localizedVerb(side: string, cw: ChannelWorkerTranslations): string {
  if (side === 'sell') return cw.verbSell
  if (side === 'buy') return cw.verbBuy
  return cw.verbTrade
}

/** User-facing reason for order_send skipped/failed (symbol filters, broker "not found", etc.). */
export function orderSendOutcomeSuffix(
  row: ChannelWorkerLogRow,
  instr: string | null,
  cw: ChannelWorkerTranslations,
): string {
  const payload = row.request_payload ?? {}
  const exempted = `: ${cw.symbolExempted}`
  const skipReason = String(payload.skip_reason ?? '')
  if (SYMBOL_EXEMPTED_SKIP_REASONS.has(skipReason)) {
    return exempted
  }

  const allowed = allowedSymbolsFromPayload(payload)
  const signalSym = String(
    payload.signal_symbol ?? getSignalParsedFromLog(row).symbol ?? '',
  ).toUpperCase()
  if (allowed.length > 0 && signalSym && !allowed.includes(signalSym)) {
    return exempted
  }

  const err = (row.error_message ?? '').trim()
  if (!err) return ''

  const errSym = symbolFromNotFoundError(err)
  const sentSym = String(payload.symbol ?? payload.trade_symbol ?? '').toUpperCase()
  const displaySym = instr?.toUpperCase() ?? ''

  if (/symbol not found/i.test(err)) {
    if (allowed.length > 0 && signalSym && !allowed.includes(signalSym)) {
      return exempted
    }
    if (errSym && displaySym && errSym !== displaySym) {
      return exempted
    }
    if (errSym && sentSym && displaySym && errSym === sentSym && displaySym !== sentSym) {
      return exempted
    }
  }

  return interpolate(cw.errSuffix, { detail: translateBrokerError(err, cw) })
}

function signalWasSkipped(row: ChannelWorkerLogRow): boolean {
  return String(row.signals?.status ?? '').toLowerCase() === 'skipped'
}

function skipReasonForSignal(row: ChannelWorkerLogRow, cw: ChannelWorkerTranslations): string {
  const raw = String(
    row.signals?.skip_reason ?? row.request_payload?.skip_reason ?? row.error_message ?? '',
  ).trim()
  return raw ? translateSkipReason(raw, cw) : cw.notPlaced
}

function isMgmtNoOpenSkipReason(row: ChannelWorkerLogRow): boolean {
  const skip = String(row.signals?.skip_reason ?? row.request_payload?.skip_reason ?? '').toLowerCase()
  return skip === 'mgmt_no_open_trades'
    || skip.startsWith('mgmt_no_open_trades_')
    || skip === 'mgmt_ambiguous_modify'
}

function isMgmtPipelineNoiseLogAction(logAction: string): boolean {
  return logAction === 'pipeline_parse_dispatch'
    || logAction === 'keyword_parse'
    || logAction === 'handle_start'
    || logAction === 'handle_end'
    || logAction === 'dispatch_received'
}

/** Remap success-style execution logs when the linked signal was ultimately skipped. */
function applySkippedSignalOverride(
  row: ChannelWorkerLogRow,
  cw: ChannelWorkerTranslations,
  message: string,
): string {
  if (!message.trim()) return message
  if (!signalWasSkipped(row) || row.status.toLowerCase() !== 'success') return message

  const logAction = row.action.toLowerCase()
  if (isMgmtNoOpenSkipReason(row) && isMgmtPipelineNoiseLogAction(logAction)) {
    return message
  }

  if (logAction === 'dispatch_skipped') return message
  if (isMgmtPipelineNoiseLogAction(logAction)) {
    return message
  }

  const reason = skipReasonForSignal(row, cw)
  const instr = resolveInstrumentSymbol(row)
  const signalAction = signalActionFromLog(row)

  if (logAction.startsWith('mgmt_') || MANAGEMENT_COPIER_ACTIONS.has(signalAction)) {
    const mgmt = logAction.startsWith('mgmt_') ? logAction.slice(5) : signalAction
    return interpolate(cw.mgmtSkippedReason, {
      phrase: mgmtSkippedPhrase(mgmt, instr, cw),
      reason,
    })
  }

  if (
    logAction === 'virtual_pending_fired'
    || logAction === 'virtual_pending_inserted'
    || logAction === 'order_send'
    || logAction === 'signal_entry_pending_placed'
    || logAction === 'signal_entry_pending_filled'
  ) {
    return interpolate(cw.orderDidNotPlaceSkipped, { on: onInstrument(instr, cw), reason })
  }

  if (
    logAction === 'merge_routed_modify_only'
    || logAction === 'merge_modify_summary'
    || logAction === 'signal_merge_into_open_trade'
    || logAction === 'merge_anchor_selected'
  ) {
    return interpolate(cw.mgmtSkippedReason, {
      phrase: mgmtSkippedPhrase('modify', instr, cw),
      reason,
    })
  }

  if (
    (signalAction === 'buy' || signalAction === 'sell' || signalAction === 'close')
    && !isMgmtNoOpenSkipReason(row)
  ) {
    return interpolate(cw.dispatchSkipped, { reason })
  }

  return interpolate(cw.dispatchSkipped, { reason })
}

function signalMarkedIgnored(row: ChannelWorkerLogRow): boolean {
  const sig = row.signals
  const parsed = getSignalParsedFromLog(row)
  const action = String(parsed.action ?? '').toLowerCase()
  const skip = String(sig?.skip_reason ?? row.request_payload?.skip_reason ?? '').toLowerCase()
  const status = String(sig?.status ?? '').toLowerCase()
  if (action === 'ignore') return true
  if (skip === 'channel_filter_ignored') return true
  if (status === 'skipped' && skip === 'non-trade message') return true
  return false
}

function ignoredChannelWorkerReason(row: ChannelWorkerLogRow, cw: ChannelWorkerTranslations): string {
  const sig = row.signals
  const parsed = getSignalParsedFromLog(row)
  const action = String(parsed.action ?? '').toLowerCase()
  const skip = String(sig?.skip_reason ?? row.request_payload?.skip_reason ?? '').trim()
  if (skip) return translateSkipReason(skip, cw)
  if (action === 'ignore') return translateSkipReason('non_trade_message', cw)
  return translateSkipReason('channel_filter_ignored', cw)
}

/** Internal modify pipeline rows — hidden from the Channel Worker feed (see merge_modify_summary). */
const CHANNEL_WORKER_HIDDEN_LOG_ACTIONS = new Set([
  'merge_routed_modify_only',
  'merge_anchor_selected',
  'dispatch_route_decision',
  'dispatch_enqueue_attempt',
  'dispatch_enqueue_failed',
  'queue_consume_start',
  'queue_consume_ack',
  'queue_consume_retry',
  'queue_dead_letter',
  'basket_reconcile_tick',
  'virtual_pending_tp_lock',
  'signal_entry_pending_sync',
  'news_pre_close',
])

function isEntryOpenLogAction(logAction: string): boolean {
  return logAction === 'order_send'
    || logAction === 'virtual_pending_fired'
    || logAction === 'virtual_pending_inserted'
    || logAction === 'signal_entry_pending_placed'
    || logAction === 'signal_entry_pending_filled'
    || logAction === 'signal_merge_into_open_trade'
}

export type ChannelWorkerDisplayLogRow = ChannelWorkerLogRow & {
  id: string
  created_at: string
  signal_id?: string | null
  broker_account_id?: string | null
}

/**
 * Drop duplicate / internal rows before rendering the Channel Worker feed.
 * Newest-first input is preserved.
 */
export function filterChannelWorkerDisplayLogs<T extends ChannelWorkerDisplayLogRow>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const recentMergeOk = new Map<string, number>()

  return sorted.filter(row => {
    const action = row.action.toLowerCase()
    if (CHANNEL_WORKER_HIDDEN_LOG_ACTIONS.has(action)) return false
    if (isSilencedChannelWorkerSkipReason(resolveLogSkipReason(row))) return false

    if (action === 'merge_modify_summary' && row.status.toLowerCase() === 'success') {
      const payload = row.request_payload ?? {}
      const anchor = String(payload.parent_signal_id ?? row.signal_id ?? '')
      const broker = String(row.broker_account_id ?? '')
      const rowMs = Date.parse(row.created_at)
      if (!anchor || !Number.isFinite(rowMs)) return true
      const key = `${anchor}|${broker}`
      const lastMs = recentMergeOk.get(key)
      if (lastMs != null && Math.abs(rowMs - lastMs) <= 30_000) return false
      recentMergeOk.set(key, rowMs)
    }
    return true
  })
}

function isTradeUpdateAction(logAction: string, signalAction: string): boolean {
  if (logAction === 'merge_routed_modify_only' || logAction === 'merge_modify_summary') return true
  if (logAction === 'trailing_stop' || logAction === 'auto_be' || logAction === 'cwe_close') return true
  if (logAction === 'opposite_signal_close' || logAction === 'partial_tp_fired') return true
  if (logAction.startsWith('mgmt_')) return true
  if (MANAGEMENT_COPIER_ACTIONS.has(signalAction)) return true
  return false
}

/** Localized line for the dashboard Channel Worker feed. Returns null to hide internal pipeline rows. */
export function channelWorkerLogMessage(
  row: ChannelWorkerLogRow,
  cw: ChannelWorkerTranslations,
  channelDisplayNames?: Record<string, string>,
): string | null {
  const skipReason = resolveLogSkipReason(row)
  if (isNonTradeSkipReason(skipReason)) return null
  if (isSilencedChannelWorkerSkipReason(skipReason)) return null
  const logAction = row.action.toLowerCase()
  const signalAction = signalActionFromLog(row)
  if (CHANNEL_WORKER_HIDDEN_LOG_ACTIONS.has(logAction)) return null
  if (signalAction === 'ignore') return null

  if (
    signalWasSkipped(row)
    && isMgmtNoOpenSkipReason(row)
    && isMgmtPipelineNoiseLogAction(logAction)
    && row.status.toLowerCase() === 'success'
  ) {
    return null
  }

  const signalStatus = String(row.signals?.status ?? '').toLowerCase()
  const logStatus = row.status.toLowerCase()
  // Show skipped/failed management and SL/TP updates; only suppress in-flight rows for
  // still-pending entry signals (avoids duplicate noise before execution completes).
  if (
    isTradeUpdateAction(logAction, signalAction)
    && signalStatus !== 'executed'
    && logStatus !== 'skipped'
    && logStatus !== 'failed'
    && logStatus !== 'success'
  ) {
    return null
  }
  const message = applySkippedSignalOverride(row, cw, buildChannelWorkerLogMessage(row, cw))
  if (!message.trim()) return null
  const channel = resolveChannelNameFromLog(row, channelDisplayNames)
  if (!channel || shouldOmitChannelSuffix(logAction)) return message
  return withFromChannel(message, channel, cw)
}

function buildChannelWorkerLogMessage(row: ChannelWorkerLogRow, cw: ChannelWorkerTranslations): string {
  const instr = resolveInstrumentSymbol(row)
  const logAction = row.action.toLowerCase()
  const status = row.status.toLowerCase()
  const signalAction = signalActionFromLog(row)
  const payload = row.request_payload ?? {}
  const parsed = getSignalParsedFromLog(row)
  const forInstr = forInstrument(instr, cw)
  const err = errSuffix(row, cw)

  if (logAction === 'mgmt_skip') {
    const reason = translateSkipReason(
      String(payload.skip_reason ?? row.error_message ?? cw.noMatchingOpenTrade),
      cw,
    )
    const mgmt = signalAction === 'close' ? 'close' : signalAction || 'modify'
    return interpolate(cw.mgmtSkippedReason, {
      phrase: mgmtSkippedPhrase(mgmt, instr, cw),
      reason,
    })
  }

  if (logAction === 'dispatch_skipped') {
    const reason = translateSkipReason(
      String(payload.skip_reason ?? row.error_message ?? cw.notPlaced),
      cw,
    )
    return interpolate(cw.dispatchSkipped, { reason })
  }

  if (logAction === 'pipeline_parse_dispatch') {
    if (status === 'attempt') {
      return interpolate(cw.pipelineReading, { for: forInstr })
    }
    if (status === 'success') {
      return interpolate(cw.pipelineUnderstood, { for: forInstr })
    }
    return interpolate(cw.pipelineCouldNotRead, { for: forInstr, err })
  }

  if (logAction === 'keyword_parse') {
    if (status === 'failed') {
      return interpolate(cw.keywordCouldNotUnderstand, { for: forInstr, err })
    }
    return messageForSignalAction(signalAction, instr, parsed, 'understood', cw)
  }

  if (logAction === 'plan_fallback') {
    return namedOrGeneric(
      instr,
      s => interpolate(cw.planFallbackNamed, { symbol: s }),
      () => cw.planFallbackGeneric,
    )
  }

  if (logAction === 'order_send') {
    const op = String(payload.operation ?? '').toLowerCase()
    const side = op.includes('sell') ? 'sell' : op.includes('buy') ? 'buy' : signalAction
    const lot = Number(payload.volume_executed ?? payload.volume)
    const price = Number(payload.price)
    const isPending = op.includes('limit') || op.includes('stop')
    const tradeSym = cleanTradeSymbol(payload.trade_symbol)
    const orderInstr = tradeSym ?? instr
    const on = onInstrument(orderInstr, cw)

    if (status === 'skipped') {
      const outcome = orderSendOutcomeSuffix(row, orderInstr, cw)
      if (outcome.includes(cw.symbolExempted)) {
        return orderInstr
          ? interpolate(cw.orderDidNotPlaceNamed, { on, err: outcome })
          : interpolate(cw.orderDidNotPlaceGeneric, { err: outcome })
      }
      const reason = translateSkipReason(
        String(payload.skip_reason ?? row.error_message ?? cw.notPlaced),
        cw,
      )
      return interpolate(cw.orderDidNotPlaceSkipped, { on, reason })
    }
    if (status === 'failed') {
      const verb = localizedVerb(side, cw)
      const outcome = orderSendOutcomeSuffix(row, orderInstr, cw)
      return orderInstr
        ? interpolate(cw.orderCouldNotVerb, { verb, symbol: orderInstr, err: outcome })
        : interpolate(cw.orderCouldNotPlace, { err: outcome })
    }
    if (isPending && Number.isFinite(price) && price > 0) {
      const lotStr = Number.isFinite(lot) && lot > 0 ? formatLot(lot) : ''
      const lots = lotStr ? interpolate(cw.lotsParen, { lots: lotStr.trim() }) : ''
      return interpolate(cw.orderPending, {
        side: localizedSide(side, cw),
        on,
        price,
        lots,
      })
    }
    if (side === 'buy' || side === 'sell') {
      const lotStr = Number.isFinite(lot) && lot > 0 ? `${formatLot(lot)} ` : ''
      const priceBit =
        Number.isFinite(price) && price > 0 ? interpolate(cw.priceAt, { price }) : ''
      return interpolate(cw.orderOpened, {
        lots: lotStr,
        side: localizedSide(side, cw),
        on,
        price: priceBit,
      })
    }
    return interpolate(cw.orderSent, { on })
  }

  if (logAction.startsWith('mgmt_') || MANAGEMENT_COPIER_ACTIONS.has(signalAction)) {
    const mgmt = logAction.startsWith('mgmt_') ? logAction.slice(5) : signalAction
    if ((signalMarkedIgnored(row) || signalWasSkipped(row)) && status === 'success') {
      const reason = signalWasSkipped(row)
        ? skipReasonForSignal(row, cw)
        : ignoredChannelWorkerReason(row, cw)
      return interpolate(cw.mgmtSkippedReason, {
        phrase: mgmtSkippedPhrase(mgmt, instr, cw),
        reason,
      })
    }
    if (status === 'failed' && isBenignStopsAlreadySetMessage(row.error_message)) {
      return mgmtSuccessPhrase(mgmt, instr, parsed, cw)
    }
    if (status === 'failed') {
      return `${mgmtFailurePhrase(mgmt, instr, cw)}${err}`
    }
    if (status === 'skipped') {
      const phrase = mgmtSkippedPhrase(mgmt, instr, cw)
      const reason = translateSkipReason(
        String(payload.skip_reason ?? row.error_message ?? cw.noMatchingOpenTrade),
        cw,
      )
      return interpolate(cw.mgmtSkippedReason, { phrase, reason })
    }
    return mgmtSuccessPhrase(mgmt, instr, parsed, cw)
  }

  if (logAction === 'virtual_pending_inserted') {
    const rows = Number(payload.rows)
    const count = Number.isFinite(rows) && rows > 0 ? String(rows) : cw.several
    return namedOrGeneric(
      instr,
      s => interpolate(cw.virtualInsertedNamed, { count, symbol: s }),
      () => interpolate(cw.virtualInsertedGeneric, { count }),
    )
  }
  if (logAction === 'virtual_pending_fired') {
    return interpolate(cw.virtualFired, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'basket_leg_modify' && payload.internal_rebalance === true) {
    return ''
  }
  if (logAction === 'range_basket_tp_rebalance') {
    return ''
  }
  if (logAction === 'virtual_pending_cancelled') {
    return interpolate(cw.virtualCancelled, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'virtual_pending_expired') {
    return interpolate(cw.virtualExpired, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'virtual_pending_failed') {
    return namedOrGeneric(
      instr,
      s => interpolate(cw.virtualFailedNamed, { symbol: s, err }),
      () => interpolate(cw.virtualFailedGeneric, { err }),
    )
  }

  if (logAction === 'signal_entry_pending_placed') {
    return interpolate(cw.entryPlaced, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'signal_entry_pending_filled') {
    return interpolate(cw.entryFilled, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'signal_entry_pending_cancelled') {
    return interpolate(cw.entryCancelled, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'signal_entry_pending_failed') {
    return interpolate(cw.entryFailed, { on: onInstrument(instr, cw), err })
  }

  if (logAction === 'signal_range_entry_no_price') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    return interpolate(cw.rangeEntryWaitingNoPrice, { side: sideLabel })
  }
  if (logAction === 'signal_range_entry_waiting') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    const ep = payload.entry_price
    const lo = payload.zone_lo
    const hi = payload.zone_hi
    if (lo != null && hi != null && String(lo) !== '' && String(hi) !== '') {
      return interpolate(cw.rangeEntryWaitingZone, { side: sideLabel, lo: String(lo), hi: String(hi) })
    }
    const price = ep != null && String(ep) !== '' ? String(ep) : '—'
    return interpolate(cw.rangeEntryWaitingAtPrice, { side: sideLabel, price })
  }
  if (logAction === 'signal_range_entry_fired') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    return interpolate(cw.rangeEntryFired, { side: sideLabel, on: onInstrument(instr, cw) })
  }
  if (logAction === 'signal_range_entry_expired') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    return interpolate(cw.rangeEntryExpired, { side: sideLabel })
  }
  if (logAction === 'signal_range_entry_tp_before_entry') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    return interpolate(cw.rangeEntryTpBeforeEntry, { side: sideLabel })
  }
  if (logAction === 'signal_range_entry_sl_before_entry') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    return interpolate(cw.rangeEntrySlBeforeEntry, { side: sideLabel })
  }
  if (logAction === 'signal_range_entry_updated') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    const lo = payload.zone_lo != null ? String(payload.zone_lo) : '—'
    const hi = payload.zone_hi != null ? String(payload.zone_hi) : '—'
    return interpolate(cw.rangeEntryUpdated, { side: sideLabel, lo, hi })
  }
  if (logAction === 'signal_range_entry_cancelled') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    const reason = String(payload.reason ?? 'cancelled')
    return interpolate(cw.rangeEntryCancelled, { side: sideLabel, reason })
  }
  if (logAction === 'signal_range_entry_wake_retry') {
    const dir = String(payload.direction ?? signalAction ?? 'buy').toLowerCase()
    const side = dir === 'sell' ? cw.sideSell : cw.sideBuy
    const sideLabel = side.charAt(0).toUpperCase() + side.slice(1)
    return interpolate(cw.rangeEntryWakeRetry, { side: sideLabel })
  }

  if (logAction === 'signal_merge_into_open_trade') {
    const userMsg = typeof payload.user_message === 'string' ? payload.user_message.trim() : ''
    const errMsg = typeof row.error_message === 'string' ? row.error_message.trim() : ''
    if (status !== 'success') {
      const message = userMsg || errMsg
      if (message) {
        return namedOrGeneric(
          instr,
          s => interpolate(cw.mergeUserMsgNamed, { message, symbol: s }),
          () => message,
        )
      }
      const openLegs = Number(payload.openLegs)
      const modified = Number(payload.modified)
      const skippedBroker = Number(payload.skippedNotOnBroker)
      const detail =
        Number.isFinite(openLegs) && Number.isFinite(modified)
          ? interpolate(cw.legsUpdated, { modified, openLegs })
          : cw.partialUpdate
      const extra =
        Number.isFinite(skippedBroker) && skippedBroker > 0
          ? ` (${skippedBroker} not on broker)`
          : ''
      return namedOrGeneric(
        instr,
        s => `${detail.replace(/\.$/, '')} on ${s}.${extra}`,
        () => `${detail}${extra}`,
      )
    }
    return namedOrGeneric(
      instr,
      s => interpolate(cw.mergeAddedNamed, { symbol: s }),
      () => cw.mergeAddedGeneric,
    )
  }
  if (logAction === 'merge_routed_modify_only' || logAction === 'merge_modify_summary') {
    if (status === 'skipped' && String(payload.skip_reason ?? '').toLowerCase() === 'channel_filter_ignored') {
      return interpolate(cw.dispatchSkipped, {
        reason: ignoredChannelWorkerReason(row, cw),
      })
    }
    const openLegs = Number(payload.openLegs)
    const modified = Number(payload.modified)
    const skipped = Number(payload.skippedNoTicket)
    const failed = Number(payload.failed)
    const userMsg = typeof payload.user_message === 'string' ? payload.user_message : null
    if (status === 'success') {
      const n = Number.isFinite(modified) && modified > 0 ? modified : null
      const count = n ?? cw.all
      const legsLabel = n === 1 ? cw.leg : cw.legs
      const legsDetail =
        n != null
          ? interpolate(cw.legsDetail, { count: n, legsLabel })
          : ''
      return namedOrGeneric(
        instr,
        s =>
          interpolate(cw.mergeSlTpSuccessNamed, {
            count,
            symbol: s,
            legsLabel,
          }),
        () => interpolate(cw.mergeSlTpSuccessGeneric, { legsDetail }),
      )
    }
    if (userMsg) {
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mergeUserMsgNamed, { message: userMsg, symbol: s }),
        () => userMsg,
      )
    }
    if (isBenignStopsAlreadySetMessage(row.error_message)) {
      const n = Number.isFinite(modified) && modified > 0 ? modified : null
      const count = n ?? cw.all
      const legsLabel = n === 1 ? cw.leg : cw.legs
      return namedOrGeneric(
        instr,
        s =>
          interpolate(cw.mergeSlTpSuccessNamed, {
            count,
            symbol: s,
            legsLabel,
          }),
        () => interpolate(cw.mergeSlTpSuccessGeneric, {
          legsDetail: n != null ? interpolate(cw.legsDetail, { count: n, legsLabel }) : '',
        }),
      )
    }
    const detail =
      Number.isFinite(openLegs) && Number.isFinite(modified)
        ? interpolate(cw.legsUpdated, { modified, openLegs })
        : cw.partialUpdate
    const legErrors = payload.leg_errors
    const firstLegErr =
      Array.isArray(legErrors) && legErrors.length > 0 && typeof legErrors[0] === 'object' && legErrors[0] !== null
        ? String((legErrors[0] as Record<string, unknown>).error ?? '').trim()
        : ''
    const extra =
      (Number.isFinite(skipped) && skipped > 0
        ? interpolate(cw.awaitingTicket, { count: skipped })
        : '')
      + (Number.isFinite(failed) && failed > 0 ? interpolate(cw.brokerErrors, { count: failed }) : '')
      + (firstLegErr ? interpolate(cw.egError, { error: firstLegErr.slice(0, 120) }) : '')
    return namedOrGeneric(
      instr,
      s => interpolate(cw.mergeCouldNotUpdateNamed, { symbol: s, detail, extra }),
      () => interpolate(cw.mergeCouldNotUpdateGeneric, { detail, extra }),
    )
  }
  if (logAction === 'merge_anchor_selected') {
    if (status === 'success') {
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mergeAnchorNamed, { symbol: s }),
        () => cw.mergeAnchorGeneric,
      )
    }
  }
  if (logAction === 'opposite_signal_close') {
    return namedOrGeneric(
      instr,
      s => interpolate(cw.oppositeCloseNamed, { symbol: s }),
      () => cw.oppositeCloseGeneric,
    )
  }
  if (logAction === 'partial_tp_fired') {
    return interpolate(cw.partialTpFired, { on: onInstrument(instr, cw) })
  }
  if (logAction === 'trailing_stop') {
    if (status === 'success') {
      return interpolate(cw.trailingMoved, {
        on: onInstrument(instr, cw),
        sl: slPart(payload.new_sl, cw, 'to'),
      })
    }
    return interpolate(cw.trailingCouldNot, { on: onInstrument(instr, cw), err })
  }
  if (logAction === 'auto_be') {
    if (status === 'success') {
      const half = payload.half_close === true
      const on = onInstrument(instr, cw)
      const sl = slPart(payload.new_sl, cw, half ? 'paren' : 'at')
      return half ? interpolate(cw.autoBeHalf, { on, sl }) : interpolate(cw.autoBe, { on, sl })
    }
    return interpolate(cw.autoBeFailed, { on: onInstrument(instr, cw), err })
  }
  if (logAction === 'cwe_close') {
    return namedOrGeneric(
      instr,
      s => interpolate(cw.cweCloseNamed, { symbol: s }),
      () => cw.cweCloseGeneric,
    )
  }

  if (status === 'failed') {
    return namedOrGeneric(
      instr,
      s => interpolate(cw.genericFailedNamed, { symbol: s, err }),
      () => interpolate(cw.genericFailedGeneric, { err }),
    )
  }

  if (
    logAction === 'handle_start'
    || logAction === 'handle_end'
    || logAction === 'dispatch_received'
    || logAction === 'pipeline_summary'
    || logAction === 'multi_range_plan'
    || logAction === 'stale_basket_reconciled'
    || CHANNEL_WORKER_HIDDEN_LOG_ACTIONS.has(logAction)
  ) {
    return ''
  }

  // Unknown success rows must not read as a filled entry — real opens use order_send / pending paths.
  if (
    status === 'success'
    && (signalAction === 'buy' || signalAction === 'sell')
    && !isEntryOpenLogAction(logAction)
  ) {
    const signalStatus = String(row.signals?.status ?? '').toLowerCase()
    if (signalStatus !== 'executed') return ''
    return ''
  }

  return messageForSignalAction(signalAction, instr, parsed, 'completed', cw)
}

function messageForSignalAction(
  action: string,
  instr: string | null,
  parsed: Record<string, unknown>,
  tense: 'understood' | 'completed',
  cw: ChannelWorkerTranslations,
): string {
  const prefix = tense === 'understood' ? cw.understood : cw.completed
  const on = onInstrument(instr, cw)
  const forInstr = forInstrument(instr, cw)
  switch (action) {
    case 'buy':
      return instr
        ? interpolate(cw.signalBuyNamed, { prefix, symbol: instr })
        : interpolate(cw.signalBuyGeneric, { prefix })
    case 'sell':
      return instr
        ? interpolate(cw.signalSellNamed, { prefix, symbol: instr })
        : interpolate(cw.signalSellGeneric, { prefix })
    case 'close':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.signalCloseNamed, { prefix, symbol: s }),
        () => interpolate(cw.signalCloseGeneric, { prefix }),
      )
    case 'close_worse_entries':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.signalCloseWorseNamed, { prefix, symbol: s }),
        () => interpolate(cw.signalCloseWorseGeneric, { prefix }),
      )
    case 'breakeven':
      return tense === 'understood'
        ? interpolate(cw.signalBreakevenUnderstood, { on })
        : interpolate(cw.signalBreakevenCompleted, { on })
    case 'partial_profit': {
      const frac = Number(parsed.partial_close_fraction)
      const pct = pctSuffix(frac)
      return interpolate(cw.signalPartialProfit, { prefix, on, pct })
    }
    case 'partial_breakeven':
      return interpolate(cw.signalPartialBreakeven, { prefix, on })
    case 'modify':
      return interpolate(cw.signalModify, { prefix, on })
    case 'ignore':
      return interpolate(cw.signalIgnore, { prefix })
    default:
      return interpolate(cw.signalDefault, { prefix, for: forInstr })
  }
}

function mgmtSuccessPhrase(
  action: string,
  instr: string | null,
  parsed: Record<string, unknown>,
  cw: ChannelWorkerTranslations,
): string {
  const on = onInstrument(instr, cw)
  switch (action) {
    case 'close':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtCloseSuccessNamed, { symbol: s }),
        () => cw.mgmtCloseSuccessGeneric,
      )
    case 'close_worse_entries':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtCloseWorseSuccessNamed, { symbol: s }),
        () => cw.mgmtCloseWorseSuccessGeneric,
      )
    case 'breakeven':
      return interpolate(cw.mgmtBreakevenSuccess, { on })
    case 'partial_profit': {
      const frac = Number(parsed.partial_close_fraction)
      const pct = pctSuffix(frac)
      return interpolate(cw.mgmtPartialProfit, { on, pct })
    }
    case 'partial_breakeven':
      return interpolate(cw.mgmtPartialBreakeven, { on })
    case 'modify':
      return interpolate(cw.mgmtModifySuccess, { on })
    default:
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtAppliedNamed, { symbol: s }),
        () => cw.mgmtAppliedGeneric,
      )
  }
}

function mgmtFailurePhrase(action: string, instr: string | null, cw: ChannelWorkerTranslations): string {
  switch (action) {
    case 'close':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtCloseFailNamed, { symbol: s }),
        () => cw.mgmtCloseFailGeneric,
      )
    case 'close_worse_entries':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtCloseWorseFailNamed, { symbol: s }),
        () => cw.mgmtCloseWorseFailGeneric,
      )
    case 'breakeven':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtBreakevenFailNamed, { symbol: s }),
        () => cw.mgmtBreakevenFailGeneric,
      )
    case 'partial_profit':
      return interpolate(cw.mgmtPartialProfitFail, { on: onInstrument(instr, cw) })
    case 'partial_breakeven':
      return interpolate(cw.mgmtPartialBreakevenFail, { on: onInstrument(instr, cw) })
    case 'modify':
      return interpolate(cw.mgmtModifyFail, { on: onInstrument(instr, cw) })
    default:
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtApplyFailNamed, { symbol: s }),
        () => cw.mgmtApplyFailGeneric,
      )
  }
}

function mgmtSkippedPhrase(action: string, instr: string | null, cw: ChannelWorkerTranslations): string {
  switch (action) {
    case 'close':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtCloseSkippedNamed, { symbol: s }),
        () => cw.mgmtCloseSkippedGeneric,
      )
    case 'close_worse_entries':
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtCloseWorseSkippedNamed, { symbol: s }),
        () => cw.mgmtCloseWorseSkippedGeneric,
      )
    default:
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtSkippedNamed, { symbol: s }),
        () => cw.mgmtSkippedGeneric,
      )
  }
}
