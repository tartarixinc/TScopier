import { interpolate } from '../i18n/interpolate'
import type { ManagementTranslations } from '../i18n/locales/types'

const RETRY_REASON_LABELS: Partial<Record<string, keyof ManagementTranslations>> = {
  activity_not_found: 'retryReasonNotFound',
  activity_not_failed: 'retryReasonNotFailed',
  not_retry_eligible: 'retryReasonNotEligible',
  missing_signal_id: 'retryReasonNoSignal',
  signal_not_found: 'retryReasonNoSignal',
  signal_not_retryable: 'retryReasonNotRetryable',
  dispatch_not_accepted: 'retryReasonDispatchRejected',
  wrong_shard: 'retryReasonWorkerUnavailable',
}

export function formatRetryFailureReason(
  reason: string | undefined,
  mgmt: ManagementTranslations,
): string {
  if (!reason?.trim()) return mgmt.retryFailedGeneric
  const key = RETRY_REASON_LABELS[reason.trim()]
  if (key && mgmt[key]) return String(mgmt[key])
  return interpolate(mgmt.retryFailedDetail, { reason: reason.trim() })
}
