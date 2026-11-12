export type TradingViewAlertKind = 'indicator' | 'strategy'

export type TradingViewAlertConfig = {
  kind: TradingViewAlertKind
  includeSl: boolean
  includeTp: boolean
  /** 1–5 when includeTp; ignored when includeTp is false */
  tpCount: number
  /** Literal symbol for indicator templates; strategy always uses {{ticker}} */
  symbol?: string
}

export const DEFAULT_TRADINGVIEW_ALERT_CONFIG: TradingViewAlertConfig = {
  kind: 'indicator',
  includeSl: true,
  includeTp: true,
  tpCount: 1,
  symbol: 'XAUUSD',
}

export const TRADINGVIEW_TP_COUNT_MIN = 1
export const TRADINGVIEW_TP_COUNT_MAX = 5

export function normalizeTradingViewAlertConfig(raw: unknown): TradingViewAlertConfig {
  const base = { ...DEFAULT_TRADINGVIEW_ALERT_CONFIG }
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Record<string, unknown>
  const kind = value.kind === 'strategy' ? 'strategy' : 'indicator'
  const includeSl = value.includeSl === true
  const includeTp = value.includeTp === true
  const tpRaw = typeof value.tpCount === 'number' ? value.tpCount : Number(value.tpCount)
  const tpCount = Number.isFinite(tpRaw)
    ? Math.min(TRADINGVIEW_TP_COUNT_MAX, Math.max(TRADINGVIEW_TP_COUNT_MIN, Math.round(tpRaw)))
    : DEFAULT_TRADINGVIEW_ALERT_CONFIG.tpCount
  const symbolRaw = typeof value.symbol === 'string' ? value.symbol.trim().toUpperCase() : ''
  const symbol = symbolRaw || DEFAULT_TRADINGVIEW_ALERT_CONFIG.symbol
  return { kind, includeSl, includeTp, tpCount, symbol }
}

function tpPlaceholders(count: number): number[] {
  const n = Math.min(TRADINGVIEW_TP_COUNT_MAX, Math.max(TRADINGVIEW_TP_COUNT_MIN, Math.round(count)))
  return Array.from({ length: n }, () => 0)
}

function applySlTp(
  payload: Record<string, unknown>,
  config: TradingViewAlertConfig,
): Record<string, unknown> {
  if (config.includeSl) payload.sl = 0
  if (config.includeTp) payload.tp = tpPlaceholders(config.tpCount)
  return payload
}

/** Pretty-printed JSON for pasting into a TradingView alert Message field. */
export function buildTradingViewAlertJson(
  config: TradingViewAlertConfig,
  side: 'buy' | 'sell' | 'strategy' = config.kind === 'strategy' ? 'strategy' : 'buy',
): string {
  const normalized = normalizeTradingViewAlertConfig(config)
  if (side === 'strategy' || normalized.kind === 'strategy') {
    const payload = applySlTp(
      {
        action: '{{strategy.order.action}}',
        symbol: '{{ticker}}',
        price: '{{close}}',
        id: '{{timenow}}',
      },
      normalized,
    )
    return `${JSON.stringify(payload, null, 2)}\n`
  }

  const symbol = (normalized.symbol ?? 'XAUUSD').trim().toUpperCase() || 'XAUUSD'
  const payload = applySlTp(
    {
      action: side,
      symbol,
      id: '{{timenow}}',
    },
    normalized,
  )
  return `${JSON.stringify(payload, null, 2)}\n`
}

export function buildTradingViewAlertTemplates(config: TradingViewAlertConfig): {
  strategy?: string
  buy?: string
  sell?: string
} {
  const normalized = normalizeTradingViewAlertConfig(config)
  if (normalized.kind === 'strategy') {
    return { strategy: buildTradingViewAlertJson(normalized, 'strategy') }
  }
  return {
    buy: buildTradingViewAlertJson(normalized, 'buy'),
    sell: buildTradingViewAlertJson(normalized, 'sell'),
  }
}
