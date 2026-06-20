export type CopierStartBlockedReason = 'subscription' | 'setup'

export function resolveCopierStartBlocked(args: {
  hasActiveSubscription: boolean
  hasConnectedBroker: boolean
  hasTelegramSession: boolean
  hasChannels: boolean
}): { blocked: boolean; reason: CopierStartBlockedReason | null } {
  if (!args.hasActiveSubscription) {
    return { blocked: true, reason: 'subscription' }
  }
  if (!args.hasConnectedBroker || !args.hasTelegramSession || !args.hasChannels) {
    return { blocked: true, reason: 'setup' }
  }
  return { blocked: false, reason: null }
}
