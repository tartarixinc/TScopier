export type CopierStartBlockedReason = 'subscription' | 'setup'

export function resolveCopierStartBlocked(args: {
  hasActiveSubscription: boolean
  hasConnectedBroker: boolean
  hasTelegramSession: boolean
  hasChannels: boolean
  hasTradingViewWebhook: boolean
  hasDiscordChannel: boolean
  hasWhatsAppSource: boolean
}): { blocked: boolean; reason: CopierStartBlockedReason | null } {
  if (!args.hasActiveSubscription) {
    return { blocked: true, reason: 'subscription' }
  }
  const hasTelegramSource = args.hasTelegramSession && args.hasChannels
  const hasSignalSource = hasTelegramSource || args.hasTradingViewWebhook || args.hasDiscordChannel || args.hasWhatsAppSource
  if (!args.hasConnectedBroker || !hasSignalSource) {
    return { blocked: true, reason: 'setup' }
  }
  return { blocked: false, reason: null }
}
