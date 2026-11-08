import type { SupabaseClient } from '@supabase/supabase-js'
import { disconnectChannelFromBroker } from './brokerChannelLink'
import { discordShadowChannelId } from './discordInvite'
import type { BrokerAccount } from '../types/database'

export { DISCORD_BOT_PERMISSIONS, discordClientId, discordInviteUrl, discordRedirectUri, discordShadowChannelId } from './discordInvite'

const DISCORD_CHANGED = 'discord-sources-changed'

function notifyDiscordSourcesChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(DISCORD_CHANGED))
}

export function subscribeDiscordSourcesChanged(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(DISCORD_CHANGED, onChange)
  return () => window.removeEventListener(DISCORD_CHANGED, onChange)
}

export async function saveDiscordInstallation(
  supabase: SupabaseClient,
  userId: string,
  guildId: string,
  guildName = '',
): Promise<{ error: string | null }> {
  const id = guildId.trim()
  if (!/^\d{5,30}$/.test(id)) return { error: 'invalid_guild' }
  const { error } = await supabase.from('discord_installations').upsert({
    user_id: userId,
    guild_id: id,
    guild_name: guildName.trim(),
  }, { onConflict: 'user_id,guild_id' })
  if (error) return { error: error.message }
  notifyDiscordSourcesChanged()
  return { error: null }
}

export async function syncDiscordGuild(
  supabase: SupabaseClient,
  guildId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase.functions.invoke('discord-sync', {
    body: { guild_id: guildId },
  })
  if (error) return { error: error.message }
  return { error: null }
}

export async function addDiscordChannel(
  supabase: SupabaseClient,
  userId: string,
  input: {
    installationId: string
    guildId: string
    discordChannelId: string
    name: string
  },
): Promise<{ error: string | null; channelId: string | null }> {
  const label = input.name.trim().slice(0, 80) || 'Discord'
  const channelKey = discordShadowChannelId(input.guildId, input.discordChannelId)
  const { data: channel, error: channelError } = await supabase
    .from('telegram_channels')
    .insert({
      user_id: userId,
      channel_id: channelKey,
      channel_username: '',
      display_name: label,
      is_active: true,
      source_kind: 'discord',
    })
    .select('id')
    .single()
  if (channelError || !channel) return { error: channelError?.message ?? 'create_failed', channelId: null }

  const { error: linkError } = await supabase.from('discord_channels').insert({
    user_id: userId,
    installation_id: input.installationId,
    guild_id: input.guildId,
    discord_channel_id: input.discordChannelId,
    name: label,
    channel_id: channel.id,
    is_active: true,
  })
  if (linkError) {
    await supabase.from('telegram_channels').delete().eq('id', channel.id).eq('user_id', userId)
    return { error: linkError.message, channelId: null }
  }
  notifyDiscordSourcesChanged()
  return { error: null, channelId: channel.id }
}

export async function setDiscordChannelActive(
  supabase: SupabaseClient,
  userId: string,
  discordRowId: string,
  shadowChannelId: string,
  isActive: boolean,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('telegram_channels')
    .update({ is_active: isActive })
    .eq('id', shadowChannelId)
    .eq('user_id', userId)
    .eq('source_kind', 'discord')
  if (error) return { error: error.message }
  const { error: rowError } = await supabase
    .from('discord_channels')
    .update({ is_active: isActive })
    .eq('id', discordRowId)
    .eq('user_id', userId)
  if (rowError) return { error: rowError.message }
  notifyDiscordSourcesChanged()
  return { error: null }
}

export async function removeDiscordChannel(
  supabase: SupabaseClient,
  userId: string,
  shadowChannelId: string,
  brokers: BrokerAccount[],
): Promise<{ error: string | null; brokers: BrokerAccount[] }> {
  const updated: BrokerAccount[] = []
  for (const broker of brokers) {
    const removed = await disconnectChannelFromBroker(supabase, userId, broker, shadowChannelId)
    if (removed.error) return { error: removed.error, brokers: updated }
    if (removed.broker && removed.broker !== broker) updated.push(removed.broker)
  }
  const { error } = await supabase
    .from('telegram_channels')
    .delete()
    .eq('id', shadowChannelId)
    .eq('user_id', userId)
    .eq('source_kind', 'discord')
  if (error) return { error: error.message, brokers: updated }
  notifyDiscordSourcesChanged()
  return { error: null, brokers: updated }
}
