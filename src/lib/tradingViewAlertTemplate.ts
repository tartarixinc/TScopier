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
  includeSl: false,
  includeTp: false,
  tpCount: 1,
  symbol: 'XAUUSD',
}

export const TRADINGVIEW_TP_COUNT_MIN = 1
export const TRADINGVIEW_TP_COUNT_MAX = 5

/** Default Pine plot titles — must match the script’s plot() titles. */
export const TRADINGVIEW_PLOT_TITLES = {
  entry: 'Entry',
  sl: 'SL',
  tp: (n: number) => `TP${n}`,
} as const

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

function plotPlaceholder(title: string): string {
  return `{{plot("${title}")}}`
}

function applyPlotLevels(
  payload: Record<string, unknown>,
  config: TradingViewAlertConfig,
): Record<string, unknown> {
  const levelsOn = config.includeSl || config.includeTp
  if (levelsOn) {
    payload.entry = plotPlaceholder(TRADINGVIEW_PLOT_TITLES.entry)
  }
  if (config.includeSl) {
    payload.sl = plotPlaceholder(TRADINGVIEW_PLOT_TITLES.sl)
  }
  if (config.includeTp) {
    const n = Math.min(
      TRADINGVIEW_TP_COUNT_MAX,
      Math.max(TRADINGVIEW_TP_COUNT_MIN, Math.round(config.tpCount)),
    )
    for (let i = 1; i <= n; i++) {
      payload[`tp${i}`] = plotPlaceholder(TRADINGVIEW_PLOT_TITLES.tp(i))
    }
  }
  return payload
}

/** Pretty-printed JSON for pasting into a TradingView alert Message field. */
export function buildTradingViewAlertJson(
  config: TradingViewAlertConfig,
  side: 'buy' | 'sell' | 'strategy' = config.kind === 'strategy' ? 'strategy' : 'buy',
): string {
  const normalized = normalizeTradingViewAlertConfig(config)
  if (side === 'strategy' || normalized.kind === 'strategy') {
    const payload = applyPlotLevels(
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
  const payload = applyPlotLevels(
    {
      event: 'entry',
      side: side === 'sell' ? 'SELL' : 'BUY',
      order: 'MARKET',
      symbol,
      price: '{{close}}',
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
