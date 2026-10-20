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
