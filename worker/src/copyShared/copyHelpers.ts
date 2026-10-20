/**
 * Pure helpers shared by the copy engines.
 *
 * These were extracted verbatim from socialCopyMonitor.ts so that a second
 * engine (mirror copy) can reuse one copy of the risk-critical primitives
 * without duplicating them. Behaviour must not change: socialCopyMonitor.ts
 * re-exports the previously-public members so existing imports keep working.
 */
import type { BrokerSymbolParams } from '../brokerProvider'
import { inferProvider } from '../providerResolver'
import { resolveMtLots } from '../mtTradeFields'
import {
  isLikelyMarketPositionRow,
  rawOrderOperation,
  rawOrderTicket,
  readBrokerOrderStopLoss,
  readBrokerOrderTakeProfit,
} from '../signalEntryPendingHelpers'

type Json = Record<string, unknown>

/** Minimal broker row shape needed to resolve a session id or demo/live mode. */
export type CopyBrokerSessionRow = {
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  ctrader_account_id?: string | null
  linked_account_type?: string | null
}

export type NormalizedSourcePosition = {
  ticket: string
  symbol: string
  side: 'buy' | 'sell'
  volume: number
  stopLoss: number | null
  takeProfit: number | null
}

export function normalizeSourcePosition(raw: unknown): NormalizedSourcePosition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Json
  if (!isLikelyMarketPositionRow(row)) return null
  const ticket = rawOrderTicket(row)
  const symbol = String(row.symbol ?? row.Symbol ?? row.symbolName ?? '').trim()
  const operation = rawOrderOperation(row).replace(/\s+/g, '')
  const sideText = `${operation} ${String(row.orderType ?? row.OrderType ?? row.dealType ?? row.type ?? '')}`.toLowerCase()
  const side = sideText.includes('buy') ? 'buy' : sideText.includes('sell') ? 'sell' : null
  const volume = resolveMtLots(row, 'trades')
  if (!(ticket > 0) || !symbol || !side || !(volume > 0)) return null
  return {
    ticket: String(ticket), symbol, side, volume,
    stopLoss: readBrokerOrderStopLoss(row),
    takeProfit: readBrokerOrderTakeProfit(row),
  }
}

export function sessionId(row: CopyBrokerSessionRow): string {
  const provider = inferProvider(row)
  if (provider === 'mtapi') return String(row.mtapi_session_id ?? '').trim()
  if (provider === 'ctrader') return String(row.ctrader_account_id ?? '').trim()
  return String(row.fxsocket_account_id ?? row.metaapi_account_id ?? '').trim()
}

export function isDemo(row: CopyBrokerSessionRow): boolean {
  return ['demo', 'practice'].includes(String(row.linked_account_type ?? '').trim().toLowerCase())
}

export function finite(value: unknown): number | null {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

export function symbolLimits(params: BrokerSymbolParams): { min: number; max: number; step: number } | null {
  const group = params.groupParams ?? {}
  const min = finite(group.minLot ?? params.minLot)
  const max = finite(group.maxLot ?? params.maxLot)
  const step = finite(group.lotStep ?? params.lotStep)
  if (min == null || max == null || step == null || min <= 0 || max < min || step <= 0) return null
  return { min, max, step }
}

export function constrainedCopyVolume(
  requested: number,
  limits: { min: number; max: number; step: number },
  configuredMax: number,
): number | null {
  const ceiling = Math.min(limits.max, configuredMax)
  if (!Number.isFinite(requested) || requested < limits.min || ceiling < limits.min) return null
  const steps = Math.floor((Math.min(requested, ceiling) - limits.min + 1e-10) / limits.step)
  const volume = limits.min + Math.max(0, steps) * limits.step
  const precision = Math.min(8, Math.max(0, String(limits.step).split('.')[1]?.length ?? 0))
  return Number(Math.min(volume, ceiling).toFixed(precision))
}

export function commentsMatch(raw: unknown, comment: string): boolean {
  if (!raw || typeof raw !== 'object') return false
  const row = raw as Json
  return String(row.comment ?? row.Comment ?? row.clientOrderId ?? '').trim() === comment
}

export function brokerErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('BROKER_WRITE')) return 'WRITE_AUTHORITY_REJECTED'
  if (message.includes('SOCIAL_ACCESS_REVOKED')) return 'SOCIAL_ACCESS_REVOKED'
  if (message.includes('UNSUPPORTED_PROVIDER')) return 'UNSUPPORTED_PROVIDER'
  if (message.includes('DUPLICATE_OPEN_CLAIM')) return 'DUPLICATE_OPEN_CLAIM'
  if (message.includes('EQUITY_UNAVAILABLE')) return 'EQUITY_UNAVAILABLE'
  if (message.includes('DUPLICATE_CLOSE_CLAIM')) return 'DUPLICATE_CLOSE_CLAIM'
  if (message.includes('VOLUME_BELOW_MINIMUM')) return 'VOLUME_BELOW_MINIMUM'
  if (message.includes('SOURCE_VOLUME_INCREASE_UNSUPPORTED')) return 'SOURCE_VOLUME_INCREASE_UNSUPPORTED'
  if (message.includes('PARTIAL_CLOSE_BELOW_MINIMUM')) return 'PARTIAL_CLOSE_BELOW_MINIMUM'
  if (message.includes('DUPLICATE_MODIFY_CLAIM')) return 'DUPLICATE_MODIFY_CLAIM'
  if (message.includes('SYMBOL_LIMITS_UNAVAILABLE')) return 'UNSUPPORTED_SYMBOL'
  if (message.toLowerCase().includes('symbol')) return 'UNSUPPORTED_SYMBOL'
  if (message.toLowerCase().includes('connect')) return 'BROKER_DISCONNECTED'
  return 'BROKER_OPERATION_FAILED'
}

/** rawOrderTicket is re-exported for engines that compare broker tickets directly. */
export { rawOrderTicket }
