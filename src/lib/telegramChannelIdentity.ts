/** Returns true when `channel_id` looks like a Telegram numeric chat id. */
export function isNumericTelegramChatId(raw: string | null | undefined): boolean {
  const value = (raw ?? '').trim()
  if (!value) return false
  return /^-?\d+$/.test(value)
}

/** True when the row has enough identity for the worker listener to map live messages. */
export function hasValidTelegramChannelIdentity(channel: {
  channel_id?: string | null
  channel_username?: string | null
}): boolean {
  const username = (channel.channel_username ?? '').trim().replace(/^@/, '')
  if (username.length > 0) return true
  return isNumericTelegramChatId(channel.channel_id)
}

export function validateManualChannelInput(input: {
  channel_id: string
  channel_username: string
  display_name: string
}): { ok: true } | { ok: false; errorKey: 'nameRequired' | 'identityRequired' | 'invalidChannelId' } {
  if (!input.display_name.trim()) return { ok: false, errorKey: 'nameRequired' }
  const username = input.channel_username.trim().replace(/^@/, '')
  const chatId = input.channel_id.trim()
  if (!username && !chatId) return { ok: false, errorKey: 'identityRequired' }
  if (chatId && !isNumericTelegramChatId(chatId)) {
    return { ok: false, errorKey: 'invalidChannelId' }
  }
  return { ok: true }
}
