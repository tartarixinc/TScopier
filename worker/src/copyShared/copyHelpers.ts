/**
 * Pure helpers shared by the copy engines.
 *
 * These were extracted verbatim from socialCopyMonitor.ts so that a second
 * engine (mirror copy) can reuse one copy of the risk-critical primitives
 * without duplicating them. Behaviour must not change: socialCopyMonitor.ts
 * re-exports the previously-public members so existing imports keep working.
 */
import type { BrokerSymbolParams } from '../brokerProvider'
import { brokerSessionId, missingProviderIdColumn } from '../mtApiByAccount'
import { resolveMtLots } from '../mtTradeFields'
import {
  isLikelyMarketPositionRow,
  rawOrderOperation,
  rawOrderTicket,
  readBrokerOrderStopLoss,
  readBrokerOrderTakeProfit,
} from '../signalEntryPendingHelpers'

type Json = Record<string, unknown>

/**
 * Minimal broker row shape needed to resolve a session id or demo/live mode.
 * Every provider column the session resolver reads has to be selected by the
 * caller: a column that is not in the SELECT resolves to an empty session.
 */
export type CopyBrokerSessionRow = {
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  ctrader_account_id?: string | null
  binance_account_id?: string | null
  bybit_account_id?: string | null
  kucoin_account_id?: string | null
  dxtrade_account_id?: string | null
  tradelocker_account_id?: string | null
  matchtrader_account_id?: string | null
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

/**
 * Broker columns every copy engine selects: row identity, connection state,
 * every provider's session id column and the write-fence fields. Shared so the
 * mirror and social monitors can never drift apart — a session id column that
 * is missing from a SELECT resolves to an empty session for that provider.
 */
// Written as one literal (not a concatenation) so the typed Supabase client can
// still parse the column list; splitting it turns the select into a `string` and
// the row type degrades to GenericStringError.
export const COPY_BROKER_COLUMNS = 'id,user_id,provider,platform,is_active,connection_status,linked_account_type,mtapi_session_id,fxsocket_account_id,metaapi_account_id,ctrader_account_id,binance_account_id,bybit_account_id,kucoin_account_id,dxtrade_account_id,tradelocker_account_id,matchtrader_account_id,writer_epoch,provider_transition_state'

/**
 * What to select when the database has not received the later provider
 * migrations yet: the pre-provider-fan-out set. The engines then keep copying
 * for the providers those columns do cover (fxsocket/mtapi/ctrader) instead of
 * failing the whole read — the same degradation `loadPlatformByFxsocketId`
 * already has in `mtApiByAccount.ts`. Providers whose column is missing resolve
 * to an empty session and fail closed for that account only.
 */
export const LEGACY_COPY_BROKER_COLUMNS = 'id,user_id,provider,platform,is_active,connection_status,linked_account_type,mtapi_session_id,fxsocket_account_id,metaapi_account_id,ctrader_account_id,writer_epoch,provider_transition_state'

/**
 * Re-exported so both copy engines can read it from here; the definition lives
 * with the other provider-column readers in `mtApiByAccount.ts` (this module
 * already imports that one, so it cannot be defined here).
 */
export { missingProviderIdColumn }

/**
 * Provider-specific broker session id, shared with the trade executor so the
 * two paths can never disagree: every provider is resolved from its own
 * `*_account_id` column (unknown providers resolve to '' and fail closed).
 */
export function sessionId(row: CopyBrokerSessionRow): string {
  return brokerSessionId(row)
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
