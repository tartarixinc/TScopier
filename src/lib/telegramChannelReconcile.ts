import type { SupabaseClient } from '@supabase/supabase-js'
import type { TelegramChannel } from '../types/database'
import type { TgChannelListItem } from './telegramChannelsCache'
import { hasValidTelegramChannelIdentity, normalizeTelegramUsername } from './telegramChannelIdentity'

function titleKey(title: string): string {
  return title.trim().toLowerCase()
}

function findTelegramListMatch(
  channel: TelegramChannel,
  tgList: TgChannelListItem[],
): TgChannelListItem | undefined {
  const byTitle = titleKey(channel.display_name)
  const byUsername = normalizeTelegramUsername(channel.channel_username)

  return tgList.find(t => {
    if (titleKey(t.title) === byTitle) return true
    const tgUser = normalizeTelegramUsername(t.username)
    return Boolean(byUsername && tgUser && tgUser === byUsername)
  })
}

/** Patch invalid DB rows using the live Telegram channel list (by title or @username). */
export async function reconcileChannelIdentitiesFromTelegram(
  supabase: SupabaseClient,
  userId: string,
  dbChannels: TelegramChannel[],
  tgList: TgChannelListItem[],
): Promise<TelegramChannel[]> {
  if (!tgList.length) return dbChannels

  let next = [...dbChannels]
  for (const ch of dbChannels) {
    if (ch.source_kind === 'tradingview' || ch.source_kind === 'discord') continue
    if (hasValidTelegramChannelIdentity(ch)) continue
    const match = findTelegramListMatch(ch, tgList)
    if (!match) continue

    const { data, error } = await supabase
      .from('telegram_channels')
      .update({
        channel_id: match.id,
        channel_username: normalizeTelegramUsername(match.username),
        display_name: match.title,
      })
      .eq('id', ch.id)
      .eq('user_id', userId)
      .select('*')
      .single()

    if (!error && data) {
      next = next.map(row => (row.id === ch.id ? (data as TelegramChannel) : row))
    }
  }
  return next
}

/** Remove legacy rows that share a title but have invalid identity after a picker add. */
export async function removeStaleDuplicateChannels(
  supabase: SupabaseClient,
  userId: string,
  tgChannel: { id: string; title: string },
): Promise<void> {
  const { data: stale } = await supabase
    .from('telegram_channels')
    .select('id, channel_id, channel_username, display_name, source_kind')
    .eq('user_id', userId)
    .ilike('display_name', tgChannel.title.trim())
    .neq('channel_id', tgChannel.id)

  for (const row of (stale ?? []) as TelegramChannel[]) {
    if (row.source_kind === 'tradingview') continue
    if (hasValidTelegramChannelIdentity(row)) continue
    await supabase.from('telegram_channels').delete().eq('id', row.id).eq('user_id', userId)
  }
}
