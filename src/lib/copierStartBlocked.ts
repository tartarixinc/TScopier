export type CopierStartBlockedReason = 'subscription' | 'setup'

export function resolveCopierStartBlocked(args: {
  hasActiveSubscription: boolean
  hasConnectedBroker: boolean
}): { blocked: boolean; reason: CopierStartBlockedReason | null } {
  if (!args.hasActiveSubscription) {
    return { blocked: true, reason: 'subscription' }
  }
  if (!args.hasConnectedBroker) {
    return { blocked: true, reason: 'setup' }
  }
  return { blocked: false, reason: null }
}
