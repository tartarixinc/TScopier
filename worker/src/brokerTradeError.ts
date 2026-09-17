/**
 * Turn raw FxSocket / HTTP trade failures into messages users (and logs) can act on.
 * Prefer stable prefixes like `Symbol not found: XAUUSD` so the dashboard i18n can match them.
 */

export type TradeFailureCategory = 'signal' | 'broker' | 'account' | 'risk' | 'system'

export type TradeFailureReason = {
  reasonCode: string
  category: TradeFailureCategory
  title: string
  explanation: string
  recommendedAction?: string
  retryable: boolean
  userActionRequired: boolean
  safeContext?: Record<string, unknown>
}

export const SIGNAL_MISSING_REQUIRED_SL = 'SIGNAL_MISSING_REQUIRED_SL'
export const ENTRY_TP_WITHOUT_SL = 'entry_tp_without_sl'
export const BROKER_SYMBOL_NOT_FOUND = 'BROKER_SYMBOL_NOT_FOUND'

function cleanSymbol(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : ''
  return s ? s.replace(/\s+/g, '') : undefined
}

function displayInstrument(symbol?: string): string {
  const s = cleanSymbol(symbol)
  if (!s) return 'the requested instrument'
  if (s === 'XAUUSD' || s === 'XAU' || s === 'GOLD') return 'GOLD/XAUUSD'
  return s
}

function tradeFailureCopy(
  reasonCode: string,
  safeContext?: Record<string, unknown>,
): Omit<TradeFailureReason, 'reasonCode' | 'safeContext'> | null {
  const requestedSymbol = cleanSymbol(safeContext?.requestedSymbol)
  const instrument = displayInstrument(requestedSymbol)
  switch (reasonCode) {
    case SIGNAL_MISSING_REQUIRED_SL: {
      const withheld = safeContext?.withheldByProvider === true
      return {
        category: 'signal',
        title: 'SL not given — set predefined SL pips in broker configuration',
        explanation: withheld
          ? 'The signal did not include a usable Stop Loss (often reserved for premium/VIP subscribers). Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can still place the trade.'
          : 'The signal did not include a usable Stop Loss. Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can still place the trade.',
        recommendedAction: 'Open Account Configuration for this broker, turn on Override signal SL, and set Stop loss (pips from entry).',
        retryable: false,
        userActionRequired: true,
      }
    }
    case ENTRY_TP_WITHOUT_SL:
    case 'ENTRY_TP_WITHOUT_SL':
    case 'entry_tp_without_sl': {
      return {
        category: 'signal',
        title: 'SL not given — set predefined SL pips in broker configuration',
        explanation:
          'This signal listed take-profit level(s) but no stop loss. Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can place the trade.',
        recommendedAction: 'Open Account Configuration for this broker, turn on Override signal SL, and set Stop loss (pips from entry).',
        retryable: false,
        userActionRequired: true,
      }
    }
    case BROKER_SYMBOL_NOT_FOUND:
    case 'SYMBOL_UNSUPPORTED':
      return {
        category: 'broker',
        title: 'Trade not copied - Broker symbol not found',
        explanation: `We could not find ${instrument} or a supported equivalent on your broker account. Your broker may use a custom symbol name.`,
        recommendedAction: 'Check the instrument name in your broker terminal, then add a symbol mapping or contact support.',
        retryable: false,
        userActionRequired: true,
      }
    case 'INSUFFICIENT_MARGIN':
      return {
        category: 'account',
        title: 'Trade not copied - Not enough margin',
        explanation: 'Your broker rejected the order because the account did not have enough free margin for the requested lot size.',
        recommendedAction: 'Lower the lot size or add funds before copying this signal again.',
        retryable: false,
        userActionRequired: true,
      }
    case 'MARKET_CLOSED':
      return {
        category: 'broker',
        title: 'Trade not copied - Market closed',
        explanation: 'The broker reported that this market was closed or unavailable when the copier tried to place the order.',
        recommendedAction: 'Wait until the market is open for this instrument.',
        retryable: true,
        userActionRequired: false,
      }
    case 'INVALID_LOT':
      return {
        category: 'risk',
        title: 'Trade not copied - Invalid lot size',
        explanation: 'The broker rejected the configured lot size for this instrument.',
        recommendedAction: 'Check the account lot size settings and the broker minimum/step size for this symbol.',
        retryable: false,
        userActionRequired: true,
      }
    case 'BROKER_ACCOUNT_UNAVAILABLE':
      return {
        category: 'account',
        title: 'Trade not copied - Broker not connected',
        explanation: 'The broker account was not connected or authorized when the copier tried to place the trade.',
        recommendedAction: 'Open Account Configuration and reconnect the broker account.',
        retryable: true,
        userActionRequired: true,
      }
    case 'BROKER_TIMEOUT':
      return {
        category: 'system',
        title: 'Broker response timed out',
        explanation: 'The broker did not confirm the order result in time. The copier must reconcile the account before treating this as safe to retry.',
        recommendedAction: 'Check the trade status before retrying. Do not retry automatically if the broker outcome is unclear.',
        retryable: false,
        userActionRequired: true,
      }
    case 'BROKER_RATE_LIMITED':
      return {
        category: 'broker',
        title: 'Trade delayed - Broker rate limited',
        explanation: 'The broker temporarily rejected requests because too many requests were sent in a short period.',
        recommendedAction: 'Wait a moment before retrying.',
        retryable: true,
        userActionRequired: false,
      }
    case 'BROKER_ORDER_REJECTED':
      return {
        category: 'broker',
        title: 'Trade not copied - Broker rejected order',
        explanation: 'The broker rejected this order. The exact broker reason was not recognized as a more specific condition.',
        recommendedAction: 'Review the broker account, symbol, lot size, and stop levels before retrying.',
        retryable: false,
        userActionRequired: true,
      }
    case 'INVALID_REQUEST':
      return {
        category: 'broker',
        title: 'Trade not copied - Invalid request',
        explanation: 'The broker rejected the order as invalid. This typically means the symbol is not available on this account, the order parameters are incompatible with the current market state, or the position was already closed.',
        recommendedAction: 'Check that the symbol is enabled on your broker account and that the lot size and stop levels are valid. If this persists, verify the symbol mapping in Account Configuration.',
        retryable: false,
        userActionRequired: true,
      }
    default:
      return null
  }
}

export function tradeFailureReasonFromCode(
  reasonCode: string,
  safeContext?: Record<string, unknown>,
): TradeFailureReason | null {
  const code = String(reasonCode ?? '').trim().toUpperCase()
  if (!code) return null
  const copy = tradeFailureCopy(code, safeContext)
  if (!copy) return null
  return {
    reasonCode: code === 'SYMBOL_UNSUPPORTED' ? BROKER_SYMBOL_NOT_FOUND : code,
    ...copy,
    ...(safeContext ? { safeContext } : {}),
  }
}

export function tradeFailureReasonFromBrokerMessage(
  message: string,
  safeContext?: Record<string, unknown>,
): TradeFailureReason | null {
  const lower = String(message ?? '').toLowerCase()
  if (
    /symbolselect/.test(lower)
    || (/symbol|instrument/.test(lower) && /not found|unknown|disabled|unsupported|invalid|select\s*failed/.test(lower))
  ) {
    return tradeFailureReasonFromCode(BROKER_SYMBOL_NOT_FOUND, safeContext)
  }
  if (/margin|not enough money|insufficient funds/.test(lower)) {
    return tradeFailureReasonFromCode('INSUFFICIENT_MARGIN', safeContext)
  }
  if (/market.*closed|off quotes|trade disabled/.test(lower)) {
    return tradeFailureReasonFromCode('MARKET_CLOSED', safeContext)
  }
  if (/invalid volume|lot|minimum volume|min lot/.test(lower)) {
    return tradeFailureReasonFromCode('INVALID_LOT', safeContext)
  }
  if (/timeout|timed out|operation timeout/.test(lower)) {
    return tradeFailureReasonFromCode('BROKER_TIMEOUT', safeContext)
  }
  if (/not connected|disconnected|session|auth|unauthorized|forbidden|invalid api/.test(lower)) {
    return tradeFailureReasonFromCode('BROKER_ACCOUNT_UNAVAILABLE', safeContext)
  }
  if (/rate limit|too many requests/.test(lower)) {
    return tradeFailureReasonFromCode('BROKER_RATE_LIMITED', safeContext)
  }
  if (/invalid\s+request/.test(lower)) {
    return tradeFailureReasonFromCode('INVALID_REQUEST', safeContext)
  }
  return null
}

export function isStopLossWithheldByProvider(message: string | null | undefined): boolean {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return false
  return /\b(?:sl|s\/l|stop\s*loss|stoploss|risk)\b.{0,40}\b(?:premium|vip|subscriber|subscribe|members?|paid|private)\b/i.test(text)
    || /\b(?:premium|vip|subscriber|subscribe|members?|paid|private)\b.{0,40}\b(?:sl|s\/l|stop\s*loss|stoploss|risk)\b/i.test(text)
}

export function parseFxErrorEnvelope(body: unknown): { message: string; code?: string } {
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>
    if (typeof o.detail === 'string' && o.detail.trim()) {
      return {
        message: o.detail.trim(),
        code: o.error != null ? String(o.error) : undefined,
      }
    }
    if (Array.isArray(o.detail) && o.detail.length > 0) {
      return { message: o.detail.map(String).join('; ') }
    }
    const message = String(o.message ?? o.Message ?? o.error ?? '').trim()
    const code = o.error != null && o.error !== o.message
      ? String(o.error)
      : o.code != null
        ? String(o.code)
        : undefined
    if (message && message !== 'null' && message !== 'undefined') {
      return { message, code }
    }
  }
  if (typeof body === 'string' && body.trim()) return { message: body.trim() }
  return { message: '' }
}

function symbolFromRequest(requestBody: unknown, url?: string): string | undefined {
  if (requestBody && typeof requestBody === 'object') {
    const o = requestBody as Record<string, unknown>
    const raw = o.symbol ?? o.Symbol ?? o.trade_symbol
    if (typeof raw === 'string' && raw.trim()) return raw.trim().toUpperCase()
  }
  if (url) {
    try {
      const u = new URL(url)
      const q = u.searchParams.get('symbol') ?? u.searchParams.get('Symbol')
      if (q?.trim()) return q.trim().toUpperCase()
    } catch {
      const m = /[?&]symbol=([^&]+)/i.exec(url)
      if (m?.[1]) {
        try {
          return decodeURIComponent(m[1]).trim().toUpperCase()
        } catch {
          return m[1].trim().toUpperCase()
        }
      }
    }
  }
  return undefined
}

function isSymbolSelectFailure(message: string, code?: string): boolean {
  const m = message.toLowerCase()
  const c = String(code ?? '').toLowerCase()
  return /symbolselect\s*failed/i.test(m)
    || /symbol\s+(?:not\s+found|select\s+failed|unavailable|unknown|disabled)/i.test(m)
    || (c === 'mrpc' && /symbol/i.test(m))
}

/**
 * Format an FxSocket HTTP failure for operators + UI (never bare "HTTP 500" when body has detail).
 */
export function formatFxHttpFailureMessage(opts: {
  status: number
  body: unknown
  requestBody?: unknown
  url?: string
}): string {
  const envelope = parseFxErrorEnvelope(opts.body)
  const symbol = symbolFromRequest(opts.requestBody, opts.url)
  if (isSymbolSelectFailure(envelope.message, envelope.code)) {
    return symbol
      ? `Symbol not found: ${symbol}`
      : 'Symbol not found on this broker account'
  }
  if (envelope.message) {
    // Avoid showing opaque transport codes alone (e.g. "MRPC").
    if (/^mrpc$/i.test(envelope.message) && symbol) {
      return `Symbol not found: ${symbol}`
    }
    if (!/^HTTP\s*\d{3}$/i.test(envelope.message)) return envelope.message
  }
  if (opts.status >= 500) {
    return symbol
      ? `Broker rejected the order for ${symbol}. Check symbol mapping and try again.`
      : 'Broker rejected this order. Check symbol mapping and connection, then try again.'
  }
  return `HTTP ${opts.status}`
}

/** Normalize catch-path OrderSend errors (v1 + v2) before persisting skip_reason / logs. */
export function humanizeOrderSendError(message: string, symbol?: string | null): string {
  const m = String(message ?? '').trim()
  if (!m) return 'Broker rejected this order'
  const sym = typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : undefined
  if (isSymbolSelectFailure(m) || /^symbol\s+not\s+found(\s+on\s+this\s+broker\s+account)?$/i.test(m)) {
    return sym ? `Symbol not found: ${sym}` : (m.startsWith('Symbol not found') ? m : 'Symbol not found on this broker account')
  }
  const already = m.match(/^symbol not found:\s*([A-Z0-9._#+]+)/i)
  if (already) return `Symbol not found: ${already[1]!.toUpperCase()}`
  if (/^HTTP\s*5\d\d$/i.test(m)) {
    return sym
      ? `Broker rejected the order for ${sym}. Check symbol mapping and try again.`
      : 'Broker rejected this order. Check symbol mapping and connection, then try again.'
  }
  if (/^invalid\s+request$/i.test(m)) {
    return 'Broker rejected order: invalid request. Check symbol availability and order parameters.'
  }
  return m
}
