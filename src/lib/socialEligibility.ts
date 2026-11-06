export type SocialEligibilityStatus = 'passed' | 'blocked' | 'pending' | 'warning'
export type SocialEligibilitySeverity = 'success' | 'error' | 'info' | 'warning'
export type SocialEligibilityDiagnostic = {
  code: string
  status: SocialEligibilityStatus
  severity: SocialEligibilitySeverity
  explanation: string
  nextAction: string | null
  blocking: boolean
  order: number
}
type Copy = Omit<SocialEligibilityDiagnostic, 'code' | 'order'>
export const SOCIAL_ELIGIBILITY_REASON_ORDER = [
  'source_missing', 'source_not_published', 'synthetic_preview_disabled', 'source_unsupported',
  'account_mode_unknown', 'source_inactive', 'sync_failed', 'source_disconnected', 'sync_pending',
  'history_stale', 'history_incomplete', 'minimum_trades_not_met', 'minimum_period_not_met', 'eligible',
] as const
export type SocialEligibilityReason = typeof SOCIAL_ELIGIBILITY_REASON_ORDER[number]

const item = (status: SocialEligibilityStatus, severity: SocialEligibilitySeverity, explanation: string, nextAction: string | null): Copy => ({
  status, severity, explanation, nextAction, blocking: status !== 'passed' && status !== 'warning',
})

const COPY: Record<SocialEligibilityReason, Copy> = {
  source_missing: item('blocked', 'error', 'The selected source account no longer exists or is not owned by this trader.', 'Choose another owned source account or publish a new one.'),
  source_not_published: item('blocked', 'warning', 'This source account has not been published for Social Trading.', 'The trader must explicitly publish this account from their Social Trading settings.'),
  synthetic_preview_disabled: item('blocked', 'warning', 'This synthetic demo source is available only in an isolated preview environment.', 'Use Migration Preview with synthetic participation enabled, or select a genuine connected account.'),
  source_unsupported: item('blocked', 'error', 'This broker provider or platform is not supported for verified Social Trading performance.', 'Connect a supported FxSocket or MTAPI MT4/MT5 account.'),
  account_mode_unknown: item('pending', 'info', 'The account demo/live mode has not been verified yet.', 'Reconnect or synchronize the account so its mode can be verified.'),
  source_inactive: item('blocked', 'error', 'The source account is inactive.', 'Activate the broker connection before using it as a source.'),
  sync_failed: item('blocked', 'error', 'The latest broker synchronization failed.', 'Repair or reconnect the broker account, then synchronize it again.'),
  source_disconnected: item('blocked', 'error', 'The source account is disconnected from its broker.', 'Reconnect the source account and confirm that its connection is healthy.'),
  sync_pending: item('pending', 'info', 'The first successful source synchronization has not completed.', 'Keep the account connected and wait for synchronization to finish.'),
  history_stale: item('blocked', 'error', 'The source history is older than the 15-minute freshness limit.', 'Restore synchronization and wait for a fresh broker snapshot.'),
  history_incomplete: item('blocked', 'error', 'One or more closed trades are missing a verified broker ticket or realized result.', 'Synchronize the complete closed-trade history before publishing it for copying.'),
  minimum_trades_not_met: item('pending', 'info', 'Fewer than 10 complete closed trades are available.', 'Accumulate at least 10 complete closed trades and synchronize them.'),
  minimum_period_not_met: item('pending', 'info', 'The verified closed-trade history spans less than 7 days.', 'Keep the account synchronized until its closed-trade history spans at least 7 days.'),
  eligible: item('passed', 'success', 'The source currently passes every server-side copy eligibility check.', null),
}

export function eligibilityDiagnosticForReason(reason: string): SocialEligibilityDiagnostic {
  const known = SOCIAL_ELIGIBILITY_REASON_ORDER.includes(reason as SocialEligibilityReason)
    ? reason as SocialEligibilityReason : 'source_missing'
  return { code: known, order: SOCIAL_ELIGIBILITY_REASON_ORDER.indexOf(known), ...COPY[known] }
}

export function normalizeEligibilityDiagnostics(value: unknown, fallbackReason: string): SocialEligibilityDiagnostic[] {
  if (!Array.isArray(value) || value.length === 0) return [eligibilityDiagnosticForReason(fallbackReason)]
  return value.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const fallback = eligibilityDiagnosticForReason(String(row.code ?? fallbackReason))
    return {
      code: String(row.code ?? fallback.code),
      status: ['passed', 'blocked', 'pending', 'warning'].includes(String(row.status)) ? String(row.status) as SocialEligibilityStatus : fallback.status,
      severity: ['success', 'error', 'info', 'warning'].includes(String(row.severity)) ? String(row.severity) as SocialEligibilitySeverity : fallback.severity,
      explanation: typeof row.explanation === 'string' ? row.explanation : fallback.explanation,
      nextAction: typeof row.next_action === 'string' ? row.next_action : typeof row.nextAction === 'string' ? row.nextAction : fallback.nextAction,
      blocking: typeof row.blocking === 'boolean' ? row.blocking : fallback.blocking,
      order: Number.isFinite(Number(row.order)) ? Number(row.order) : index,
    }
  }).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
}

export function primaryEligibilityDiagnostic(diagnostics: SocialEligibilityDiagnostic[]): SocialEligibilityDiagnostic {
  return diagnostics.find(item => item.blocking && item.status === 'blocked')
    ?? diagnostics.find(item => item.blocking && item.status === 'pending')
    ?? diagnostics.find(item => item.status === 'warning')
    ?? diagnostics[0]
    ?? eligibilityDiagnosticForReason('source_missing')
}

function passed(order: number, code: string, explanation: string): SocialEligibilityDiagnostic {
  return { order, code, explanation, status: 'passed', severity: 'success', blocking: false, nextAction: null }
}

export function publishingEligibilityDiagnostics(account: BrokerAccount, published?: SocialEligibilityDiagnostic[]): SocialEligibilityDiagnostic[] {
  if (published?.length) return published
  const mode = resolveSocialAccountMode(account)
  const connection = brokerConnectionLabel(account)
  return [
    isSocialCopyProviderSupported(account) ? passed(1, 'source_supported', 'The provider and platform are supported for Social Trading.') : { ...eligibilityDiagnosticForReason('source_unsupported'), order: 1 },
    mode === 'demo' || mode === 'live' ? passed(2, 'account_mode_verified', `The broker verified this as a ${mode} account.`) : { ...eligibilityDiagnosticForReason('account_mode_unknown'), order: 2 },
    account.is_active ? passed(3, 'source_active', 'The broker account is active.') : { ...eligibilityDiagnosticForReason('source_inactive'), order: 3 },
    connection === 'Connected' ? passed(4, 'source_connected', 'The broker connection is healthy.') : { ...eligibilityDiagnosticForReason(connection === 'Connection error' ? 'sync_failed' : 'source_disconnected'), order: 4 },
  ]
}
import type { BrokerAccount } from '../types/database'
import { brokerConnectionLabel, isSocialCopyProviderSupported, resolveSocialAccountMode } from './socialAccount'
