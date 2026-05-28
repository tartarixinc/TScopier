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
  const ticket = message.match(/Ticket\s+(\d+)\s+not found/i)
  if (ticket) return interpolate(cw.errorTicketNotFound, { ticket: ticket[1] })
  const sym = message.match(/symbol not found:\s*([A-Z0-9._#+]+)/i)
  if (sym) return interpolate(cw.errorSymbolNotFound, { symbol: sym[1]!.toUpperCase() })
  if (/not connected/i.test(message) || /broker session is not connected/i.test(message)) {
    return cw.errorBrokerNotConnected
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

/** Localized line for the dashboard Channel Worker feed. */
export function channelWorkerLogMessage(
  row: ChannelWorkerLogRow,
  cw: ChannelWorkerTranslations,
  channelDisplayNames?: Record<string, string>,
): string {
  const logAction = row.action.toLowerCase()
  const message = buildChannelWorkerLogMessage(row, cw)
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
    if (signalMarkedIgnored(row) && status === 'success') {
      return interpolate(cw.mgmtSkippedReason, {
        phrase: mgmtSkippedPhrase(mgmt, instr, cw),
        reason: ignoredChannelWorkerReason(row, cw),
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
    default:
      return namedOrGeneric(
        instr,
        s => interpolate(cw.mgmtSkippedNamed, { symbol: s }),
        () => cw.mgmtSkippedGeneric,
      )
  }
}
