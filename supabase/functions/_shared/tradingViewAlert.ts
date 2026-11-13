export const TRADINGVIEW_ALERT_TEMPLATE = `{
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "id": "{{timenow}}"
}`

/**
 * Indicator buy alert. Use a real symbol (edit XAUUSD to match your chart).
 * Avoid relying on {{ticker}} — Pine alert()-only webhooks leave placeholders unexpanded.
 */
export const TRADINGVIEW_ALERT_TEMPLATE_BUY = `{
  "action": "buy",
  "symbol": "XAUUSD",
  "id": "{{timenow}}"
}`

/**
 * Indicator sell alert. Use a real symbol (edit XAUUSD to match your chart).
 * Avoid relying on {{ticker}} — Pine alert()-only webhooks leave placeholders unexpanded.
 */
export const TRADINGVIEW_ALERT_TEMPLATE_SELL = `{
  "action": "sell",
  "symbol": "XAUUSD",
  "id": "{{timenow}}"
}`

export type TradingViewTradeAction = 'buy' | 'sell' | 'close'

export type TradingViewEntryOrderType = 'market' | 'limit'

export type TradingViewParsedAlert = {
  action: TradingViewTradeAction
  symbol: string
  sl: number | null
  tp: number[] | null
  idempotencyId: string | null
  parsed: {
    action: TradingViewTradeAction
    symbol: string
    entry_price: number | null
    entry_zone_low: null
    entry_zone_high: null
    entry_order_type: TradingViewEntryOrderType
    sl: number | null
    tp: number[] | null
    lot_size: null
  }
}

export type TradingViewAlertParse =
  | { ok: true; alert: TradingViewParsedAlert }
  | { ok: false; reason: string }

const MAX_BODY_CHARS = 8_000
const TP_INDEX_MAX = 5

export function stripTradingViewSymbol(raw: string): string {
  const trimmed = raw.trim()
  const afterExchange = trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : trimmed
  return afterExchange.replace(/\s+/g, '').toUpperCase()
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    // Unexpanded placeholders are not levels.
    if (/\{\{|\}\}/.test(value)) return null
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

/** Collect tp1…tp5 (any case) into a level array when `tp` is absent. */
function takeSplitTpLevels(record: Record<string, unknown>): number[] | null {
  const levels: number[] = []
  for (let i = 1; i <= TP_INDEX_MAX; i++) {
    const key = `tp${i}`
    const upper = `TP${i}`
    const value = record[key] ?? record[upper]
    if (value === undefined) continue
    const n = finiteNumber(value)
    if (n != null) levels.push(n)
  }
  return levels.length ? levels : null
}

function normalizeAction(value: unknown): TradingViewTradeAction | null {
  const action = String(value ?? '').trim().toLowerCase()
  if (action === 'buy' || action === 'long' || action === 'entry_long') return 'buy'
  if (action === 'sell' || action === 'short' || action === 'entry_short') return 'sell'
  if (
    action === 'close'
    || action === 'exit'
    || action === 'flat'
    || action === 'close_all'
    || action === 'exit_long'
    || action === 'exit_short'
  ) {
    return 'close'
  }
  return null
}

function normalizeSide(value: unknown): TradingViewTradeAction | null {
  const side = String(value ?? '').trim().toLowerCase()
  if (side === 'buy' || side === 'long') return 'buy'
  if (side === 'sell' || side === 'short') return 'sell'
  return null
}

/**
 * Resolve trade direction from action, then side, then event+side
 * (plot-based templates often use event/side instead of action).
 */
export function resolveTradingViewAction(record: Record<string, unknown>): {
  action: TradingViewTradeAction | null
  reason?: string
} {
  const actionRaw = String(record.action ?? '').trim()
  if (actionRaw && /\{\{|\}\}/.test(actionRaw)) {
    return { action: null, reason: 'unresolved_action_placeholder' }
  }
  const fromAction = normalizeAction(record.action)
  if (fromAction) return { action: fromAction }

  const sideRaw = String(record.side ?? '').trim()
  if (sideRaw && /\{\{|\}\}/.test(sideRaw)) {
    return { action: null, reason: 'unresolved_action_placeholder' }
  }
  const fromSide = normalizeSide(record.side)

  const event = String(record.event ?? '').trim().toLowerCase()
  if (
    event === 'close'
    || event === 'exit'
    || event === 'flat'
    || event === 'close_all'
  ) {
    return { action: 'close' }
  }
  if (event === 'entry' || event === 'open' || event === '') {
    if (fromSide) return { action: fromSide }
  }

  if (fromSide) return { action: fromSide }
  if (record.action != null && String(record.action).trim() !== '') {
    return { action: null, reason: 'unknown_action' }
  }
  if (record.side != null && String(record.side).trim() !== '') {
    return { action: null, reason: 'unknown_action' }
  }
  return { action: null, reason: 'unknown_action' }
}

function resolveEntryOrderType(record: Record<string, unknown>): TradingViewEntryOrderType {
  const order = String(record.order ?? '').trim().toLowerCase()
  if (order === 'limit' || order === 'stop_limit') return 'limit'
  return 'market'
}

/**
 * TradingView alert messages are often almost-JSON but not strict:
 * unquoted `{{close}}` when a placeholder is left unresolved, smart quotes,
 * or a JSON object wrapped in surrounding alert text.
 */
export function coerceTradingViewAlertJson(raw: string): string {
  let body = raw.trim().replace(/^\uFEFF/, '')
  if (!body) return body

  // Prefer the first JSON object if TV prepends text.
  if (!body.startsWith('{')) {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) body = body.slice(start, end + 1)
  }

  body = body
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")

  // Quote bare TradingView placeholders so unresolved {{close}} / {{plot("SL")}} is valid JSON.
  body = body.replace(
    /(:\s*)\{\{([^{}]+)\}\}(\s*[,}\]])/g,
    (_match, prefix: string, inner: string, suffix: string) => {
      const escaped = inner.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return `${prefix}"{{${escaped}}}"${suffix}`
    },
  )

  // Trailing commas before } or ] are common after hand-edited templates.
  body = body.replace(/,\s*([}\]])/g, '$1')
  return body
}

export function parseTradingViewAlert(raw: string): TradingViewAlertParse {
  const original = raw.trim()
  if (!original) return { ok: false, reason: 'empty_body' }
  if (original.length > MAX_BODY_CHARS) return { ok: false, reason: 'body_too_large' }

  const body = coerceTradingViewAlertJson(original)
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

  const resolved = resolveTradingViewAction(record)
  if (!resolved.action) {
    return { ok: false, reason: resolved.reason ?? 'unknown_action' }
  }
  const action = resolved.action

  const symbolRaw = String(record.symbol ?? '')
  if (/\{\{|\}\}/.test(symbolRaw)) {
    return { ok: false, reason: 'unresolved_symbol_placeholder' }
  }
  const symbol = stripTradingViewSymbol(symbolRaw)
  if (!symbol) {
    return { ok: false, reason: 'symbol_required' }
  }

  const sl = finiteNumber(record.sl)
  const tp = takeLevels(record.tp) ?? takeSplitTpLevels(record)
  const entryPrice = finiteNumber(record.entry)
  // Limit only when an expanded numeric entry is present; otherwise stay market.
  const useLimit = resolveEntryOrderType(record) === 'limit' && entryPrice != null

  const idRaw = record.id
  let idempotencyId = idRaw == null || idRaw === ''
    ? null
    : String(idRaw).trim().slice(0, 200) || null
  // Unexpanded {{timenow}} would otherwise collapse every fire onto one idempotency key.
  if (idempotencyId && /\{\{|\}\}/.test(idempotencyId)) {
    idempotencyId = null
  }

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
        entry_price: useLimit ? entryPrice : null,
        entry_zone_low: null,
        entry_zone_high: null,
        entry_order_type: useLimit ? 'limit' : 'market',
        sl,
        tp,
        lot_size: null,
      },
    },
  }
}
