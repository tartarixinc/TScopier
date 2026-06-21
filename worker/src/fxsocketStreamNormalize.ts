import type { FxsocketWsServerMessage } from './fxsocketWsClient'

const ENVELOPE_TYPES = new Set([
  'account',
  'positions',
  'trade',
  'terminal',
  'tick',
  'bar',
  'subscribed',
  'unsubscribed',
  'error',
  'warning',
])

function readRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function readNum(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function isPendingOrderRow(o: Record<string, unknown>): boolean {
  const kind = String(o.kind ?? o.Kind ?? '').toLowerCase()
  if (kind === 'pending' || kind === 'order') return true
  if (kind === 'position' || kind === 'deal') return false
  const op = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '').toLowerCase()
  if (op.includes('limit') || op.includes('stop')) return true
  return false
}

function isMarketPositionRow(o: Record<string, unknown>): boolean {
  if (isPendingOrderRow(o)) return false
  const kind = String(o.kind ?? o.Kind ?? '').toLowerCase()
  if (kind === 'position' || kind === 'deal') return true
  const op = String(o.operation ?? o.Operation ?? '').toLowerCase().replace(/\s+/g, '')
  if (op === 'buy' || op === 'sell') return true
  const type = String(o.type ?? o.Type ?? '').toLowerCase().replace(/\s+/g, '')
  if ((type === 'buy' || type === 'sell') && (kind === 'position' || kind === 'deal' || o.lots != null || o.Lots != null)) {
    return true
  }
  const symbol = String(o.symbol ?? o.Symbol ?? '').trim()
  const lots = readNum(o.lots ?? o.Lots ?? o.volume ?? o.Volume)
  if (symbol && lots != null && lots > 0 && (o.profit != null || o.Profit != null)) return true
  return false
}

function isAccountSummaryRow(o: Record<string, unknown>): boolean {
  return (
    o.balance != null
    || o.Balance != null
    || o.equity != null
    || o.Equity != null
    || o.profit != null
    || o.Profit != null
    || o.margin != null
    || o.Margin != null
  )
}

function isEnvelopeType(type: string): boolean {
  return ENVELOPE_TYPES.has(type.toLowerCase())
}

/** Mirror of src/lib/fxsocketStreamNormalize.ts for worker upstream parsing. */
export function normalizeFxsocketWsMessage(raw: unknown): FxsocketWsServerMessage | null {
  if (raw == null) return null

  if (Array.isArray(raw)) {
    return { type: 'positions', data: raw }
  }

  const o = readRecord(raw)
  if (!o) return null

  const typeLower = String(o.type ?? '').toLowerCase()

  if (isMarketPositionRow(o)) {
    return { type: 'trade', data: o }
  }

  if (isEnvelopeType(typeLower)) {
    if (typeLower === 'account') {
      const data = readRecord(o.data) ?? o
      return { type: 'account', data }
    }
    if (typeLower === 'positions') {
      const payload = o.data ?? o.positions ?? o.Positions
      if (payload != null) {
        return {
          type: 'positions',
          data: Array.isArray(payload) ? payload : [payload],
        }
      }
    }
    if (typeLower === 'trade') {
      const data = readRecord(o.data) ?? o
      return { type: 'trade', data }
    }
    if (typeLower === 'terminal') {
      const data = readRecord(o.data) ?? o
      return { type: 'terminal', data }
    }
    if (typeLower === 'tick' && typeof o.symbol === 'string') {
      return { type: 'tick', symbol: o.symbol, data: readRecord(o.data) ?? o }
    }
    if (typeLower === 'bar' && typeof o.symbol === 'string' && typeof o.timeframe === 'string') {
      return {
        type: 'bar',
        symbol: o.symbol,
        timeframe: o.timeframe,
        data: readRecord(o.data) ?? o,
      }
    }
    return o as FxsocketWsServerMessage
  }

  if (isAccountSummaryRow(o)) {
    return { type: 'account', data: o }
  }

  return null
}
