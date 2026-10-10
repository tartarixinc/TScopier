/** VIEW_CHANNEL (1024) + READ_MESSAGE_HISTORY (65536). */
export const DISCORD_BOT_PERMISSIONS = 66560

export function discordShadowChannelId(guildId: string, discordChannelId: string): string {
  return `dc:${guildId}:${discordChannelId}`
}

export function discordInviteUrl(clientId: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId.trim(),
    permissions: String(DISCORD_BOT_PERMISSIONS),
    scope: 'bot',
    response_type: 'code',
    redirect_uri: redirectUri,
  })
  return `https://discord.com/oauth2/authorize?${params.toString()}`
}

export function discordClientId(): string {
  return String(import.meta.env.VITE_DISCORD_CLIENT_ID ?? '').trim()
}

export function discordRedirectUri(): string {
  if (typeof window === 'undefined') return ''
  return `${window.location.origin}/channels`
}
