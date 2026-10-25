import type { SocialTrader } from './socialTradingFixture'

const ELIGIBILITY_REASONS: Record<string, string> = {
  source_missing: 'This trader has no published source account.',
  source_not_published: 'The trader source is not published.',
  source_unsupported: 'Only supported MT4/MT5 source accounts can be copied.',
  account_mode_unknown: 'The source account type could not be verified.',
  demo_only: 'Copying currently requires an eligible demo source account.',
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

export function canOpenCopyTrader(trader: SocialTrader): boolean {
  if (!trader.sourceId) return false
  return trader.syntheticDemo === true || trader.copyEligible === true
}

export function copyTraderUnavailableReason(trader: SocialTrader): string | null {
  if (canOpenCopyTrader(trader)) return null
  if (!trader.sourceId) return trader.performanceError ?? ELIGIBILITY_REASONS.source_missing
  if (trader.syntheticDemo) return ELIGIBILITY_REASONS.synthetic_demo
  return ELIGIBILITY_REASONS[trader.copyEligibilityReason ?? ''] ?? 'This trader is not currently eligible for copying.'
}
