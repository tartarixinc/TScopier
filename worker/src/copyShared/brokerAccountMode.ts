/**
 * Broker account execution mode (hedging vs netting).
 *
 * A neutral provider helper, not a mirror-copy concept: both the session manager and
 * the mirror gate need it. The detection mirrors the edge helper in
 * supabase/functions/_shared/providerTransition.ts (mtapiAccountModeFromSummary), which
 * reads the MT platform account summary's `method` field.
 *
 * MT4 has no hedging/netting concept and is always hedging; only MT5 reports a mode.
 */

export type BrokerAccountMode = 'hedging' | 'netting' | 'unknown'

/** Derive the mode from a raw MT account summary. Unknown when the field is absent. */
export function accountModeFromSummary(summary: Record<string, unknown> | null | undefined): BrokerAccountMode {
  if (!summary || typeof summary !== 'object') return 'unknown'
  const raw = String(summary.method ?? summary.Method ?? '').trim().toLowerCase()
  if (raw.includes('hedg')) return 'hedging'
  if (raw.includes('net') || raw.includes('exchange')) return 'netting'
  return 'unknown'
}

/**
 * The mode to store for an account. MT4 is always hedging; for MT5 (and anything else)
 * fall back to the summary. Returns 'unknown' when it cannot be determined.
 */
export function brokerAccountModeForPlatform(
  platform: string | null | undefined,
  summary: Record<string, unknown> | null | undefined,
): BrokerAccountMode {
  if (String(platform ?? '').trim().toUpperCase() === 'MT4') return 'hedging'
  return accountModeFromSummary(summary)
}

/**
 * Platforms that keep every position independent by construction: a position
 * is identified by its own id and keeps its own stop loss / take profit, and
 * there is no netting mode to switch to. The worker cannot read a mode field
 * from these venues at all (cTrader, TradeLocker and MatchTrader expose none),
 * and their accounts are what mirror copy needs — so the platform itself is
 * the answer here rather than an "unknown" that blocks every link.
 *
 * DXtrade is deliberately NOT in this set: its accounts are position-based or
 * net-based per account (the provider refuses to open a net-based one), so the
 * caller has to answer from the stored `dxtrade_is_position_based` flag.
 */
const HEDGING_ONLY_PROVIDERS = new Set(['ctrader', 'tradelocker', 'matchtrader'])

/**
 * Best known mode for a `broker_accounts` row, without asking the broker:
 * stored value → MT4 platform → platform/provider knowledge → unknown.
 * Anything that still reads `unknown` must keep failing closed.
 */
export function accountModeFromBrokerRow(row: {
  provider?: string | null
  platform?: string | null
  margin_mode?: string | null
  dxtrade_is_position_based?: boolean | null
}): BrokerAccountMode {
  const stored = String(row.margin_mode ?? '').trim().toLowerCase()
  if (stored === 'hedging' || stored === 'netting') return stored
  if (String(row.platform ?? '').trim().toUpperCase() === 'MT4') return 'hedging'
  const provider = String(row.provider ?? 'fxsocket').trim().toLowerCase() || 'fxsocket'
  if (HEDGING_ONLY_PROVIDERS.has(provider)) return 'hedging'
  if (provider === 'dxtrade') {
    if (row.dxtrade_is_position_based === true) return 'hedging'
    if (row.dxtrade_is_position_based === false) return 'netting'
    return 'unknown'
  }
  return 'unknown'
}
