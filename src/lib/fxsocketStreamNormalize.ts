import type { FxsocketStreamMessage } from './fxsocketStreamTypes'
import {
  isFxsocketMarketPositionRow,
  unwrapFxsocketPositionsPayload,
} from './fxsocketStreamParse'

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

function isEnvelopeType(type: string): boolean {
  return ENVELOPE_TYPES.has(type.toLowerCase())
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

/**
 * FxSocket WS often streams bare position rows (`kind: position`, `type: Buy`)
 * instead of `{ type: "trade", data: … }`. Normalize to the envelope our app expects.
 */
export function normalizeFxsocketStreamMessage(raw: unknown): FxsocketStreamMessage | null {
  if (raw == null) return null

  if (Array.isArray(raw)) {
    return { type: 'positions', data: raw }
  }

  const o = readRecord(raw)
  if (!o) return null

  const typeField = String(o.type ?? '')
  const typeLower = typeField.toLowerCase()

  if (isFxsocketMarketPositionRow(o)) {
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
      return {
        type: 'tick',
        symbol: o.symbol,
        data: readRecord(o.data) ?? o,
      }
    }
    if (typeLower === 'bar' && typeof o.symbol === 'string' && typeof o.timeframe === 'string') {
      return {
        type: 'bar',
        symbol: o.symbol,
        timeframe: o.timeframe,
        data: readRecord(o.data) ?? o,
      }
    }
    return o as FxsocketStreamMessage
  }

  if (isAccountSummaryRow(o)) {
    return { type: 'account', data: o }
  }

  const rows = unwrapFxsocketPositionsPayload(o)
  if (rows.length > 0) {
    if (rows.length === 1) {
      const row = readRecord(rows[0])
      if (row) return { type: 'trade', data: row }
    }
    return { type: 'positions', data: rows }
  }

  return null
}
