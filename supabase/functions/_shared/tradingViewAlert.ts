export const TRADINGVIEW_ALERT_TEMPLATE = `{
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "price": {{close}},
  "id": "{{timenow}}"
}`

export type TradingViewTradeAction = 'buy' | 'sell' | 'close'

export type TradingViewParsedAlert = {
  action: TradingViewTradeAction
  symbol: string
  sl: number | null
  tp: number[] | null
  idempotencyId: string | null
  parsed: {
    action: TradingViewTradeAction
    symbol: string
    entry_price: null
    entry_zone_low: null
    entry_zone_high: null
    entry_order_type: 'market'
    sl: number | null
    tp: number[] | null
    lot_size: null
  }
}

export type TradingViewAlertParse =
  | { ok: true; alert: TradingViewParsedAlert }
  | { ok: false; reason: string }

const MAX_BODY_CHARS = 8_000

export function stripTradingViewSymbol(raw: string): string {
  const trimmed = raw.trim()
  const afterExchange = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : trimmed
  return afterExchange.replace(/\s+/g, '').toUpperCase()
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function takeLevels(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const levels = value.map(finiteNumber).filter((n): n is number => n != null)
    return levels.length ? levels : null
  }
  const one = finiteNumber(value)
  return one == null ? null : [one]
}

function normalizeAction(value: unknown): TradingViewTradeAction | null {
  const action = String(value ?? '').trim().toLowerCase()
  if (action === 'buy' || action === 'sell' || action === 'close') return action
  return null
}

export function parseTradingViewAlert(raw: string): TradingViewAlertParse {
  const body = raw.trim()
  if (!body) return { ok: false, reason: 'empty_body' }
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: 'body_too_large' }

  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_json' }
  }
  const record = payload as Record<string, unknown>

  const action = normalizeAction(record.action)
  if (!action) return { ok: false, reason: 'unknown_action' }

  const symbol = stripTradingViewSymbol(String(record.symbol ?? ''))
  if (!symbol || symbol.includes('{') || symbol.includes('}')) {
    return { ok: false, reason: 'symbol_required' }
  }

  const sl = finiteNumber(record.sl)
  const tp = takeLevels(record.tp)
  const idRaw = record.id
  const idempotencyId = idRaw == null || idRaw === ''
    ? null
    : String(idRaw).trim().slice(0, 200) || null

  return {
    ok: true,
    alert: {
      action,
      symbol,
      sl,
      tp,
      idempotencyId,
      parsed: {
        action,
        symbol,
        entry_price: null,
        entry_zone_low: null,
        entry_zone_high: null,
        entry_order_type: 'market',
        sl,
        tp,
        lot_size: null,
      },
    },
  }
}
