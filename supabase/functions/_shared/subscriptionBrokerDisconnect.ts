export type SubscriptionDisconnectCandidate = { status: string | null; trial_ends_at: string | null; current_period_end: string | null }

export function subscriptionExpiredAt(row: SubscriptionDisconnectCandidate): string | null {
  if (row.status === 'active') return null
  if (row.status === 'trialing') return row.trial_ends_at
  return row.current_period_end ?? row.trial_ends_at
}

export function isSubscriptionActiveNow(row: SubscriptionDisconnectCandidate, now = new Date()): boolean {
  if (row.status === 'active') return true
  if (row.status !== 'trialing') return false
  const end = row.trial_ends_at ? Date.parse(row.trial_ends_at) : Number.NaN
  return !Number.isFinite(end) || end >= now.getTime()
}

export function hasSubscriptionGraceElapsed(row: SubscriptionDisconnectCandidate, now = new Date(), graceDays = 30): boolean {
  if (isSubscriptionActiveNow(row, now)) return false
  const expiredAt = subscriptionExpiredAt(row)
  const expiredMs = expiredAt ? Date.parse(expiredAt) : Number.NaN
  return Number.isFinite(expiredMs) && expiredMs <= now.getTime() - graceDays * 86_400_000
}

export function brokerIsAlreadyDisconnected(row: { fxsocket_status?: string | null; connection_status?: string | null }): boolean {
  return row.fxsocket_status === 'disconnected' || row.connection_status === 'disconnected'
}
