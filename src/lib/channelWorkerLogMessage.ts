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
    parsed_data?: Record<string, unknown> | null
    raw_message?: string | null
  } | null
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

function errSuffix(row: ChannelWorkerLogRow): string {
  return row.error_message ? `: ${row.error_message}` : ''
}

const SYMBOL_EXEMPTED_SKIP_REASONS = new Set([
  'symbol_exempted_from_trading',
  'symbol_not_in_whitelist',
  'symbol_excluded',
])

const SYMBOL_EXEMPTED_MESSAGE = 'Symbol exempted from trading'

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

/** User-facing reason for order_send skipped/failed (symbol filters, broker "not found", etc.). */
export function orderSendOutcomeSuffix(row: ChannelWorkerLogRow, instr: string | null): string {
  const payload = row.request_payload ?? {}
  const skipReason = String(payload.skip_reason ?? '')
  if (SYMBOL_EXEMPTED_SKIP_REASONS.has(skipReason)) {
    return `: ${SYMBOL_EXEMPTED_MESSAGE}`
  }

  const allowed = allowedSymbolsFromPayload(payload)
  const signalSym = String(
    payload.signal_symbol ?? getSignalParsedFromLog(row).symbol ?? '',
  ).toUpperCase()
  if (allowed.length > 0 && signalSym && !allowed.includes(signalSym)) {
    return `: ${SYMBOL_EXEMPTED_MESSAGE}`
  }

  const err = (row.error_message ?? '').trim()
  if (!err) return ''

  const errSym = symbolFromNotFoundError(err)
  const sentSym = String(payload.symbol ?? payload.trade_symbol ?? '').toUpperCase()
  const displaySym = instr?.toUpperCase() ?? ''

  if (/symbol not found/i.test(err)) {
    if (allowed.length > 0 && signalSym && !allowed.includes(signalSym)) {
      return `: ${SYMBOL_EXEMPTED_MESSAGE}`
    }
    if (errSym && displaySym && errSym !== displaySym) {
      return `: ${SYMBOL_EXEMPTED_MESSAGE}`
    }
    if (errSym && sentSym && displaySym && errSym === sentSym && displaySym !== sentSym) {
      return `: ${SYMBOL_EXEMPTED_MESSAGE}`
    }
  }

  return `: ${err}`
}

/** "for XAUUSD" or "" */
function forInstrument(instr: string | null): string {
  return instr ? ` for ${instr}` : ''
}

/** "on XAUUSD" or "on your open trade" */
function onInstrument(instr: string | null): string {
  return instr ? `on ${instr}` : 'on your open trade'
}

function namedOrGeneric(instr: string | null, named: (symbol: string) => string, generic: () => string): string {
  return instr ? named(instr) : generic()
}

/** Plain-English line for the dashboard Channel Worker feed. */
export function channelWorkerLogMessage(row: ChannelWorkerLogRow): string {
  const instr = resolveInstrumentSymbol(row)
  const logAction = row.action.toLowerCase()
  const status = row.status.toLowerCase()
  const signalAction = signalActionFromLog(row)
  const payload = row.request_payload ?? {}
  const parsed = getSignalParsedFromLog(row)

  if (logAction === 'pipeline_parse_dispatch') {
    if (status === 'attempt') {
      return `Reading the channel message${forInstrument(instr)}…`
    }
    if (status === 'success') {
      return `Understood the channel message${forInstrument(instr)}.`
    }
    return `Could not read the channel message${forInstrument(instr)}${errSuffix(row)}`
  }

  if (logAction === 'keyword_parse') {
    if (status === 'failed') {
      return `Could not understand the message${forInstrument(instr)}${errSuffix(row)}`
    }
    return messageForSignalAction(signalAction, instr, parsed, 'understood')
  }

  if (logAction === 'plan_fallback') {
    return namedOrGeneric(
      instr,
      s => `Adjusted the order plan for ${s} (using one order instead of several).`,
      () => 'Adjusted the order plan (using one order instead of several).',
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
    const on = onInstrument(orderInstr)

    if (status === 'skipped') {
      const exempted = orderSendOutcomeSuffix(row, orderInstr)
      if (exempted.includes(SYMBOL_EXEMPTED_MESSAGE)) {
        return orderInstr
          ? `Did not place an order on ${onInstrument(orderInstr)}${exempted}`
          : `Did not place an order${exempted}`
      }
      const reason = String(payload.skip_reason ?? row.error_message ?? 'not placed')
      return `Did not place an order ${on} (${reason.replace(/_/g, ' ')}).`
    }
    if (status === 'failed') {
      const verb = side === 'sell' ? 'sell' : side === 'buy' ? 'buy' : 'trade'
      const outcome = orderSendOutcomeSuffix(row, orderInstr)
      return orderInstr
        ? `Could not ${verb} ${orderInstr}${outcome}`
        : `Could not place the order${outcome}`
    }
    if (isPending && Number.isFinite(price) && price > 0) {
      const lotStr = Number.isFinite(lot) && lot > 0 ? `${formatLot(lot)} ` : ''
      return `Placed a pending ${side} order ${on} at ${price}${lotStr ? ` (${lotStr.trim()} lots)` : ''}.`
    }
    if (side === 'buy' || side === 'sell') {
      const lotStr = Number.isFinite(lot) && lot > 0 ? `${formatLot(lot)} ` : ''
      const priceBit = Number.isFinite(price) && price > 0 ? ` at ${price}` : ''
      return `Opened a ${lotStr}${side} ${on}${priceBit}.`
    }
    return `Sent an order to the broker ${on}.`
  }

  if (logAction.startsWith('mgmt_') || MANAGEMENT_COPIER_ACTIONS.has(signalAction)) {
    const mgmt = logAction.startsWith('mgmt_') ? logAction.slice(5) : signalAction
    if (status === 'failed') {
      return `${mgmtFailurePhrase(mgmt, instr)}${errSuffix(row)}`
    }
    if (status === 'skipped') {
      const reason = String(payload.skip_reason ?? row.error_message ?? 'no matching open trade')
      return `${mgmtSkippedPhrase(mgmt, instr)} (${reason.replace(/_/g, ' ')}).`
    }
    return mgmtSuccessPhrase(mgmt, instr, parsed)
  }

  if (logAction === 'virtual_pending_inserted') {
    const rows = Number(payload.rows)
    const count = Number.isFinite(rows) && rows > 0 ? rows : 'several'
    return namedOrGeneric(
      instr,
      s => `Set up ${count} layered entry orders for ${s}.`,
      () => `Set up ${count} layered entry orders on your open trade.`,
    )
  }
  if (logAction === 'virtual_pending_fired') {
    return `Layered entry order triggered ${onInstrument(instr)}.`
  }
  if (logAction === 'virtual_pending_cancelled') {
    return `Cancelled a pending layered order ${onInstrument(instr)}.`
  }
  if (logAction === 'virtual_pending_expired') {
    return `A pending layered order ${onInstrument(instr)} expired.`
  }
  if (logAction === 'virtual_pending_failed') {
    return namedOrGeneric(
      instr,
      s => `Could not place layered entry orders for ${s}${errSuffix(row)}`,
      () => `Could not place layered entry orders${errSuffix(row)}`,
    )
  }

  if (logAction === 'signal_entry_pending_placed') {
    return `Placed a waiting entry order ${onInstrument(instr)}.`
  }
  if (logAction === 'signal_entry_pending_filled') {
    return `Entry order filled ${onInstrument(instr)}.`
  }
  if (logAction === 'signal_entry_pending_cancelled') {
    return `Cancelled the waiting entry order ${onInstrument(instr)}.`
  }
  if (logAction === 'signal_entry_pending_failed') {
    return `Entry order failed ${onInstrument(instr)}${errSuffix(row)}`
  }

  if (logAction === 'signal_merge_into_open_trade') {
    return namedOrGeneric(
      instr,
      s => `Added to the existing ${s} position.`,
      () => 'Added to your open trade.',
    )
  }
  if (logAction === 'opposite_signal_close') {
    return namedOrGeneric(
      instr,
      s => `Closed the opposite ${s} position before opening a new one.`,
      () => 'Closed the opposite position before opening a new one.',
    )
  }
  if (logAction === 'partial_tp_fired') {
    return `Take-profit level hit ${onInstrument(instr)} — closed part of the position.`
  }
  if (logAction === 'trailing_stop') {
    if (status === 'success') {
      const newSl = payload.new_sl
      return `Moved trailing stop loss ${onInstrument(instr)}${newSl != null ? ` to ${newSl}` : ''}.`
    }
    return `Could not update trailing stop ${onInstrument(instr)}${errSuffix(row)}`
  }
  if (logAction === 'cwe_close') {
    return namedOrGeneric(
      instr,
      s => `Closed ${s} (channel close rule).`,
      () => 'Closed your open trade (channel close rule).',
    )
  }

  if (status === 'failed') {
    return namedOrGeneric(
      instr,
      s => `Something went wrong while handling ${s}${errSuffix(row)}`,
      () => `Something went wrong${errSuffix(row)}`,
    )
  }

  return messageForSignalAction(signalAction, instr, parsed, 'completed')
}

function messageForSignalAction(
  action: string,
  instr: string | null,
  parsed: Record<string, unknown>,
  tense: 'understood' | 'completed',
): string {
  const prefix = tense === 'understood' ? 'Understood' : 'Completed'
  const on = onInstrument(instr)
  switch (action) {
    case 'buy':
      return instr ? `${prefix}: buy ${instr}.` : `${prefix}: buy signal.`
    case 'sell':
      return instr ? `${prefix}: sell ${instr}.` : `${prefix}: sell signal.`
    case 'close':
      return namedOrGeneric(
        instr,
        s => `${prefix}: close ${s}.`,
        () => `${prefix}: close your open trade.`,
      )
    case 'breakeven':
      return tense === 'understood'
        ? `Understood: move stop loss to break-even ${on}.`
        : `Moved stop loss to break-even ${on}.`
    case 'partial_profit': {
      const frac = Number(parsed.partial_close_fraction)
      const pct =
        Number.isFinite(frac) && frac > 0 && frac <= 1 ? ` (${Math.round(frac * 100)}%)` : ''
      return `${prefix}: take partial profit ${on}${pct}.`
    }
    case 'partial_breakeven':
      return `${prefix}: take partial profit and move to break-even ${on}.`
    case 'modify':
      return `${prefix}: update stop loss or take profit ${on}.`
    case 'ignore':
      return `${prefix}: this message is not a trade signal.`
    default:
      return `${prefix} the channel update${forInstrument(instr)}.`
  }
}

function mgmtSuccessPhrase(action: string, instr: string | null, parsed: Record<string, unknown>): string {
  const on = onInstrument(instr)
  switch (action) {
    case 'close':
      return namedOrGeneric(
        instr,
        s => `Closed the ${s} position.`,
        () => 'Closed your open trade.',
      )
    case 'breakeven':
      return `Moved stop loss to break-even ${on}.`
    case 'partial_profit': {
      const frac = Number(parsed.partial_close_fraction)
      const pct =
        Number.isFinite(frac) && frac > 0 && frac <= 1 ? ` (${Math.round(frac * 100)}%)` : ''
      return `Took partial profit ${on}${pct}.`
    }
    case 'partial_breakeven':
      return `Took partial profit and moved stop loss to break-even ${on}.`
    case 'modify':
      return `Updated stop loss or take profit ${on}.`
    default:
      return namedOrGeneric(
        instr,
        s => `Applied the update to ${s}.`,
        () => 'Applied the update to your open trade.',
      )
  }
}

function mgmtFailurePhrase(action: string, instr: string | null): string {
  switch (action) {
    case 'close':
      return namedOrGeneric(instr, s => `Could not close ${s}`, () => 'Could not close your open trade')
    case 'breakeven':
      return namedOrGeneric(
        instr,
        s => `Could not move ${s} to break-even`,
        () => 'Could not move your open trade to break-even',
      )
    case 'partial_profit':
      return `Could not take partial profit ${onInstrument(instr)}`
    case 'partial_breakeven':
      return `Could not take partial profit or move to break-even ${onInstrument(instr)}`
    case 'modify':
      return `Could not update stop loss or take profit ${onInstrument(instr)}`
    default:
      return namedOrGeneric(
        instr,
        s => `Could not apply the update to ${s}`,
        () => 'Could not apply the update to your open trade',
      )
  }
}

function mgmtSkippedPhrase(action: string, instr: string | null): string {
  switch (action) {
    case 'close':
      return namedOrGeneric(instr, s => `Did not close ${s}`, () => 'Did not close your open trade')
    default:
      return namedOrGeneric(
        instr,
        s => `Skipped the ${s} update`,
        () => 'Skipped the update to your open trade',
      )
  }
}
