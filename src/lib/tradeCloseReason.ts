import type { SupabaseClient } from '@supabase/supabase-js'
import { interpolate } from '../i18n/interpolate'

/**
 * Why a trade ended up closed.
 *
 * The worker writes these into `trades.close_reason` when it marks the row
 * closed (see `worker/src/tradeCloseReasons.ts`). When the broker closes the
 * position on its own (stop loss / take profit) no worker code runs, so the
 * column stays NULL and we infer the reason from the close price instead.
 */
export type TradeCloseReasonCode =
  | 'news_pre_close'
  | 'signal_close'
  | 'signal_revision'
  | 'opposite_signal'
  | 'partial_tp'
  | 'auto_management'
  | 'close_worse_entries'
  | 'copy_limit_flatten'
  | 'user_force_close'
  | 'position_gone'
  | 'stop_loss'
  | 'take_profit'
  | 'unknown'

const KNOWN_REASONS: ReadonlySet<string> = new Set<TradeCloseReasonCode>([
  'news_pre_close',
  'signal_close',
  'signal_revision',
  'opposite_signal',
  'partial_tp',
  'auto_management',
  'close_worse_entries',
  'copy_limit_flatten',
  'user_force_close',
  'position_gone',
  'stop_loss',
  'take_profit',
])

export interface CloseReasonPriceFields {
  sl: number | null
  tp: number | null
  close_price: number | null
}

/**
 * Prices are compared with a tight relative tolerance: broker rounding of the
 * close price (5 decimal places on gold) still counts as a hit, while any real
 * gap — slippage, a pip of movement — returns null and the reason stays
 * `unknown` rather than being guessed.
 */
function priceMatches(actual: number, level: number): boolean {
  return Math.abs(actual - level) <= Math.max(1e-6, Math.abs(level) * 1e-6)
}

/** SL / TP hit detected from the recorded close price. */
export function inferCloseReasonFromPrices(trade: CloseReasonPriceFields): 'stop_loss' | 'take_profit' | null {
  const close = trade.close_price
  if (close == null || !Number.isFinite(close)) return null
  if (trade.sl != null && Number.isFinite(trade.sl) && priceMatches(close, trade.sl)) return 'stop_loss'
  if (trade.tp != null && Number.isFinite(trade.tp) && priceMatches(close, trade.tp)) return 'take_profit'
  return null
}

/**
 * Stored reason wins. `position_gone` and NULL only mean "the worker did not
 * close it", so the close price gets the last word (SL/TP) before we give up.
 */
export function resolveTradeCloseReason(
  stored: string | null | undefined,
  trade: CloseReasonPriceFields,
): TradeCloseReasonCode {
  const reason = typeof stored === 'string' ? stored.trim() : ''
  if (reason && KNOWN_REASONS.has(reason) && reason !== 'position_gone') {
    return reason as TradeCloseReasonCode
  }
  const inferred = inferCloseReasonFromPrices(trade)
  if (inferred) return inferred
  if (reason === 'position_gone') return 'position_gone'
  return 'unknown'
}

/** Stored reason for one trade, keyed the same way the copier links trades to signals. */
export async function fetchTradeCloseReason(
  supabase: SupabaseClient,
  params: { userId: string; brokerAccountId: string; ticket: number },
): Promise<string | null> {
  const { data, error } = await supabase
    .from('trades')
    .select('close_reason')
    .eq('user_id', params.userId)
    .eq('broker_account_id', params.brokerAccountId)
    .eq('metaapi_order_id', String(params.ticket))
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || !Array.isArray(data) || data.length === 0) return null
  const row = data[0] as { close_reason?: string | null } | undefined
  return typeof row?.close_reason === 'string' && row.close_reason.trim()
    ? row.close_reason.trim()
    : null
}

export interface TradeCloseReasonLabels {
  reasonNewsPreClose: string
  reasonSignalClose: string
  reasonSignalRevision: string
  reasonOppositeSignal: string
  reasonPartialTp: string
  reasonAutoManagement: string
  reasonCloseWorseEntries: string
  reasonCopyLimitFlatten: string
  reasonUserForceClose: string
  reasonPositionGone: string
  reasonStopLoss: string
  reasonTakeProfit: string
  reasonUnknown: string
}

/** i18n key for each reason code. Single source for the label switch below. */
export const CLOSE_REASON_LABEL_KEYS: Record<TradeCloseReasonCode, keyof TradeCloseReasonLabels> = {
  news_pre_close: 'reasonNewsPreClose',
  signal_close: 'reasonSignalClose',
  signal_revision: 'reasonSignalRevision',
  opposite_signal: 'reasonOppositeSignal',
  partial_tp: 'reasonPartialTp',
  auto_management: 'reasonAutoManagement',
  close_worse_entries: 'reasonCloseWorseEntries',
  copy_limit_flatten: 'reasonCopyLimitFlatten',
  user_force_close: 'reasonUserForceClose',
  position_gone: 'reasonPositionGone',
  stop_loss: 'reasonStopLoss',
  take_profit: 'reasonTakeProfit',
  unknown: 'reasonUnknown',
}

/**
 * Full sentence for the trade modal. `price` is the formatted stop loss /
 * take profit level for the two broker-side reasons.
 */
export function tradeCloseReasonLabel(
  code: TradeCloseReasonCode,
  labels: TradeCloseReasonLabels,
  values: { price?: string } = {},
): string {
  const key = CLOSE_REASON_LABEL_KEYS[code] ?? 'reasonUnknown'
  return interpolate(labels[key], { price: values.price ?? '' })
}
