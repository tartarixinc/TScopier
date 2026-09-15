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

export type TradeFailureDisplay = {
  reasonCode: string
  title: string
  explanation: string
  recommendedAction?: string
  retryable: boolean
  userActionRequired: boolean
  safeContext: Record<string, unknown>
}

function cleanSymbol(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : ''
  return s || undefined
}

function displayInstrument(symbol?: string): string {
  if (!symbol) return 'the requested instrument'
  if (symbol === 'XAUUSD' || symbol === 'XAU' || symbol === 'GOLD') return 'GOLD/XAUUSD'
  return symbol
}

function sanitizeContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of ['missingField', 'withheldByProvider', 'requestedSymbol', 'brokerSymbol', 'displayInstrument', 'operation']) {
    const v = src[key]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[key] = v
    }
  }
  return out
}

function displayFromCode(reasonCode: string, context: Record<string, unknown>): TradeFailureDisplay | null {
  const code = reasonCode.toUpperCase()
  const requestedSymbol = cleanSymbol(context.requestedSymbol ?? context.brokerSymbol)
  const instrument = displayInstrument(requestedSymbol)
  if (code === 'SIGNAL_MISSING_REQUIRED_SL' || code === 'ENTRY_TP_WITHOUT_SL') {
    const withheld = context.withheldByProvider === true
    const tpWithoutSl = code === 'ENTRY_TP_WITHOUT_SL'
    return {
      reasonCode: code,
      title: 'SL not given — set predefined SL pips in broker configuration',
      explanation: tpWithoutSl
        ? 'This signal listed take-profit level(s) but no stop loss. Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can place the trade.'
        : withheld
          ? 'The signal did not include a usable Stop Loss (often reserved for premium/VIP subscribers). Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can still place the trade.'
          : 'The signal did not include a usable Stop Loss. Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can still place the trade.',
      recommendedAction: 'Open Account Configuration for this broker, turn on Override signal SL, and set Stop loss (pips from entry).',
      retryable: false,
      userActionRequired: true,
      safeContext: context,
    }
  }
  if (code === 'BROKER_SYMBOL_NOT_FOUND' || code === 'SYMBOL_UNSUPPORTED') {
    return {
      reasonCode: 'BROKER_SYMBOL_NOT_FOUND',
      title: 'Trade not copied - Instrument not available',
      explanation: `Your broker does not offer ${instrument}. This instrument is not available on your broker account. Signals for this symbol will be skipped.`,
      recommendedAction: 'Check the available instruments in your broker terminal. If you believe this is an error, contact support.',
      retryable: false,
      userActionRequired: true,
      safeContext: context,
    }
  }
  if (code === 'INSUFFICIENT_MARGIN') {
    return {
      reasonCode: code,
      title: 'Trade not copied - Not enough margin',
      explanation: 'Your broker rejected the order because the account did not have enough free margin for the requested lot size.',
      recommendedAction: 'Lower the lot size or add funds before copying this signal again.',
      retryable: false,
      userActionRequired: true,
      safeContext: context,
    }
  }
  if (code === 'MARKET_CLOSED') {
    return {
      reasonCode: code,
      title: 'Trade not copied - Market closed',
      explanation: 'The broker reported that this market was closed or unavailable when the copier tried to place the order.',
      recommendedAction: 'Wait until the market is open for this instrument.',
      retryable: true,
      userActionRequired: false,
      safeContext: context,
    }
  }
  if (code === 'INVALID_LOT') {
    return {
      reasonCode: code,
      title: 'Trade not copied - Invalid lot size',
      explanation: 'The broker rejected the configured lot size for this instrument.',
      recommendedAction: 'Check the account lot size settings and the broker minimum/step size for this symbol.',
      retryable: false,
      userActionRequired: true,
      safeContext: context,
    }
  }
  if (code === 'BROKER_ACCOUNT_UNAVAILABLE') {
    return {
      reasonCode: code,
      title: 'Trade not copied - Broker not connected',
      explanation: 'The broker account was not connected or authorized when the copier tried to place the trade.',
      recommendedAction: 'Open Account Configuration and reconnect the broker account.',
      retryable: true,
      userActionRequired: true,
      safeContext: context,
    }
  }
  if (code === 'BROKER_TIMEOUT') {
    return {
      reasonCode: code,
      title: 'Broker response timed out',
      explanation: 'The broker did not confirm the order result in time. The copier must reconcile the account before treating this as safe to retry.',
      recommendedAction: 'Check the trade status before retrying. Do not retry automatically if the broker outcome is unclear.',
      retryable: false,
      userActionRequired: true,
      safeContext: context,
    }
  }
  return null
}

export function resolveTradeFailureDisplay(args: {
  reason?: TradeFailureReason | null
  reasonCode?: unknown
  payload?: Record<string, unknown> | null
  safeContext?: Record<string, unknown> | null
  legacyMessage?: string | null
}): TradeFailureDisplay | null {
  const payload = args.payload ?? {}
  const suppliedContext = sanitizeContext(args.safeContext)
  const embedded = args.reason ?? (
    payload.trade_failure && typeof payload.trade_failure === 'object'
      ? payload.trade_failure as TradeFailureReason
      : null
  )
  if (embedded?.reasonCode) {
    const context = sanitizeContext({
      ...(embedded.safeContext ?? {}),
      ...suppliedContext,
      requestedSymbol: embedded.safeContext?.requestedSymbol ?? suppliedContext.requestedSymbol ?? payload.requestedSymbol ?? payload.signal_symbol ?? payload.trade_symbol ?? payload.symbol,
      brokerSymbol: embedded.safeContext?.brokerSymbol ?? suppliedContext.brokerSymbol ?? payload.brokerSymbol ?? payload.symbol ?? payload.trade_symbol,
    })
    const fromCode = displayFromCode(String(embedded.reasonCode), context)
    if (fromCode) return fromCode
    return {
      reasonCode: embedded.reasonCode,
      title: embedded.title,
      explanation: embedded.explanation,
      recommendedAction: embedded.recommendedAction,
      retryable: embedded.retryable,
      userActionRequired: embedded.userActionRequired,
      safeContext: context,
    }
  }

  const code = String(args.reasonCode ?? payload.reason_code ?? payload.skip_reason ?? '').trim()
  if (code) {
    const fromCode = displayFromCode(code, sanitizeContext({
      ...suppliedContext,
      requestedSymbol: suppliedContext.requestedSymbol ?? payload.requestedSymbol ?? payload.signal_symbol ?? payload.trade_symbol ?? payload.symbol,
      brokerSymbol: suppliedContext.brokerSymbol ?? payload.brokerSymbol ?? payload.symbol ?? payload.trade_symbol,
    }))
    if (fromCode) return fromCode
  }

  const legacy = String(args.legacyMessage ?? '').trim()
  const sym = legacy.match(/symbol not found:\s*([A-Z0-9._#+]+)/i)
  if (sym) {
    return displayFromCode('BROKER_SYMBOL_NOT_FOUND', sanitizeContext({ requestedSymbol: sym[1] }))
  }
  if (/symbolselect\s*failed|symbol not found on this broker/i.test(legacy)) {
    return displayFromCode('BROKER_SYMBOL_NOT_FOUND', sanitizeContext({
      ...suppliedContext,
      requestedSymbol: suppliedContext.requestedSymbol ?? payload.signal_symbol ?? payload.trade_symbol ?? payload.symbol,
    }))
  }
  return null
}

export function buildTradeFailureAssistantPrompt(failure: TradeFailureDisplay): string {
  const context = sanitizeContext(failure.safeContext)
  return [
    'Please explain this trade copy issue using the structured reason below.',
    `Reason code: ${failure.reasonCode}`,
    `Title: ${failure.title}`,
    `Explanation: ${failure.explanation}`,
    failure.recommendedAction ? `Recommended action: ${failure.recommendedAction}` : '',
    `Retryable: ${failure.retryable ? 'yes' : 'no'}`,
    `User action required: ${failure.userActionRequired ? 'yes' : 'no'}`,
    `Safe context: ${JSON.stringify(context)}`,
    '',
    'Do not invent missing SL/TP prices. Do not override the reason code. Do not suggest retrying if retryable is false.',
  ].filter(Boolean).join('\n')
}
