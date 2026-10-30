/**
 * Terminal reason written to `trades.close_reason` whenever the worker marks a
 * trade row closed. Broker-side closes the worker never sees (stop loss, take
 * profit) leave the column NULL; the frontend infers those from prices.
 *
 * Keep the value list in sync with `src/lib/tradeCloseReason.ts`.
 */
export const TRADE_CLOSE_REASON = {
  /** Flattened by the news trading monitor before a scheduled high-impact event. */
  NEWS_PRE_CLOSE: 'news_pre_close',
  /** Channel instructed a close (management "close" action, broker-side fallback). */
  SIGNAL_CLOSE: 'signal_close',
  /** A signal revision changed direction, closing the old trade. */
  SIGNAL_REVISION: 'signal_revision',
  /** A trade in the opposite direction replaced this one. */
  OPPOSITE_SIGNAL: 'opposite_signal',
  /** Management partial profit / partial breakeven closed the last lots. */
  PARTIAL_TP: 'partial_tp',
  /** Auto management (auto breakeven half close) closed the last lots. */
  AUTO_MANAGEMENT: 'auto_management',
  /** Close-worse-entries action closed this losing entry. */
  CLOSE_WORSE_ENTRIES: 'close_worse_entries',
  /** Copy-limit flatten closed the trade. */
  COPY_LIMIT_FLATTEN: 'copy_limit_flatten',
  /** The user force-closed it from the UI. */
  USER_FORCE_CLOSE: 'user_force_close',
  /** The broker no longer shows the position — reason unknown, closed elsewhere. */
  POSITION_GONE: 'position_gone',
} as const

export type TradeCloseReason = (typeof TRADE_CLOSE_REASON)[keyof typeof TRADE_CLOSE_REASON]
