import type { SocialTrader } from './socialTradingFixture'

export const PROVIDER_CANNOT_COPY_REASON = 'Approved providers cannot copy other providers. Close your provider profile to copy again.'

const ELIGIBILITY_REASONS: Record<string, string> = {
  source_missing: 'This trader has no published source account.',
  source_not_published: 'The trader source is not published.',
  source_unsupported: 'Only supported MT4/MT5 source accounts can be copied.',
  account_mode_unknown: 'The source account type could not be verified.',
  demo_only: 'The source account does not meet the server-side copy eligibility requirements.',
  source_inactive: 'The trader source account is inactive.',
  source_disconnected: 'The trader source account is disconnected.',
  sync_failed: 'The trader source failed to synchronize.',
  sync_pending: 'The trader source is still synchronizing.',
  history_stale: 'The trader history is stale. Copying will be available after a fresh sync.',
  history_incomplete: 'The trader history is incomplete.',
  minimum_trades_not_met: 'At least 10 complete closed trades are required before copying.',
  minimum_period_not_met: 'At least 7 days of complete history are required before copying.',
  synthetic_demo: 'This synthetic trader is available only through the simulated flow.',
}

export function canOpenCopyTrader(trader: SocialTrader, options?: { viewerIsApprovedProvider?: boolean }): boolean {
  if (options?.viewerIsApprovedProvider) return false
  return trader.sources?.some(source => source.isCopyEligible) ?? Boolean(trader.sourceId && trader.copyEligible)
}

export function copyTraderUnavailableReason(
  trader: SocialTrader,
  options?: { viewerIsApprovedProvider?: boolean },
): string | null {
  if (options?.viewerIsApprovedProvider) return PROVIDER_CANNOT_COPY_REASON
  if (canOpenCopyTrader(trader, options)) return null
  // Preview traders start with empty sources before hydration — do not flash source_missing.
  if (trader.performanceStatusReason === 'not_loaded') return null
  if (!trader.sourceId && !trader.sources?.length) return trader.performanceError ?? ELIGIBILITY_REASONS.source_missing
  if (trader.syntheticDemo) return trader.sources?.[0]?.eligibilityReason === 'synthetic_preview_disabled'
    ? 'Synthetic participation is disabled for this environment.'
    : ELIGIBILITY_REASONS.synthetic_demo
  const reason = trader.copyEligibilityReason
    ?? trader.sources?.find(source => !source.isCopyEligible)?.eligibilityReason
  return ELIGIBILITY_REASONS[reason ?? ''] ?? 'This trader is not currently eligible for copying.'
}
