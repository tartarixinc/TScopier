/**
 * One Discord gateway connection for the shared UniCopier bot.
 * Do not run a second process with the same DISCORD_BOT_TOKEN.
 *
 * Intents: guilds, guild messages, and the privileged Message Content intent.
 * Discord must approve Message Content before the bot is in 100 or more servers.
 */
import 'dotenv/config'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type TextChannel,
} from 'discord.js'
import { flattenDiscordMessage } from './discordMessage'
import { parseRawChannelMessage } from './parseSignal'
import { pushParsedSignalToTradeWorker } from './tradeSignalPush'

type Subscriber = {
  user_id: string
  channel_id: string
}

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function syncGuild(supabase: SupabaseClient, guild: Guild): Promise<void> {
  const textChannels = [...guild.channels.cache.values()].filter(
    (channel): channel is TextChannel => channel.type === ChannelType.GuildText,
  )
  const now = new Date().toISOString()
  if (textChannels.length > 0) {
    const { error } = await supabase.from('discord_guild_channels').upsert(
      textChannels.map(channel => ({
        guild_id: guild.id,
        discord_channel_id: channel.id,
        name: channel.name,
        updated_at: now,
      })),
      { onConflict: 'guild_id,discord_channel_id' },
    )
    if (error) console.warn(`[discord] channel cache upsert failed guild=${guild.id}: ${error.message}`)
  }
  const keep = new Set(textChannels.map(channel => channel.id))
  const { data: cached } = await supabase
    .from('discord_guild_channels')
    .select('discord_channel_id')
    .eq('guild_id', guild.id)
  const stale = (cached ?? [])
    .map(row => String((row as { discord_channel_id?: string }).discord_channel_id ?? ''))
    .filter(id => id && !keep.has(id))
  if (stale.length > 0) {
    await supabase
      .from('discord_guild_channels')
      .delete()
      .eq('guild_id', guild.id)
      .in('discord_channel_id', stale)
  }
  await supabase
    .from('discord_installations')
    .update({ guild_name: guild.name })
    .eq('guild_id', guild.id)
}

async function cacheTextChannel(supabase: SupabaseClient, channel: GuildBasedChannel): Promise<void> {
  if (channel.type !== ChannelType.GuildText || !channel.guildId) return
  const { error } = await supabase.from('discord_guild_channels').upsert({
    guild_id: channel.guildId,
    discord_channel_id: channel.id,
    name: channel.name ?? 'channel',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'guild_id,discord_channel_id' })
  if (error) console.warn(`[discord] channel cache failed channel=${channel.id}: ${error.message}`)
}

async function loadSubscribers(
  supabase: SupabaseClient,
  guildId: string,
  discordChannelId: string,
): Promise<Subscriber[]> {
  const { data, error } = await supabase
    .from('discord_channels')
    .select('user_id, channel_id, is_active, telegram_channels!inner(is_active, source_kind)')
    .eq('guild_id', guildId)
    .eq('discord_channel_id', discordChannelId)
  if (error) {
    console.warn(`[discord] subscriber lookup failed channel=${discordChannelId}: ${error.message}`)
    return []
  }
  const rows = (data ?? []) as Array<{
    user_id: string
    channel_id: string
    is_active: boolean
    telegram_channels: { is_active?: boolean; source_kind?: string } | { is_active?: boolean; source_kind?: string }[]
  }>
  return rows.flatMap(row => {
    const shadow = Array.isArray(row.telegram_channels) ? row.telegram_channels[0] : row.telegram_channels
    if (!row.is_active || !shadow?.is_active || shadow.source_kind !== 'discord') return []
    return [{ user_id: row.user_id, channel_id: row.channel_id }]
  })
}

async function copyMessage(supabase: SupabaseClient, message: Message): Promise<void> {
  if (!message.guild || message.author.id === message.client.user?.id) return
  if (message.channel.type !== ChannelType.GuildText) return
  const text = flattenDiscordMessage(message.content ?? '', message.embeds.map(embed => ({
    title: embed.title,
    description: embed.description,
    fields: embed.fields,
  })))
  if (!text.trim()) return

  const subscribers = await loadSubscribers(supabase, message.guild.id, message.channel.id)
  for (const subscriber of subscribers) {
    try {
      const parsed = await parseRawChannelMessage(supabase, subscriber.channel_id, text)
      if (parsed.status !== 'parsed' || parsed.parsed.action === 'ignore') continue
      const signalId = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const { error } = await supabase.from('signals').insert({
        id: signalId,
        user_id: subscriber.user_id,
        channel_id: subscriber.channel_id,
        raw_message: text,
        parsed_data: parsed.parsed,
        status: 'parsed',
        skip_reason: null,
        telegram_message_id: message.id,
        is_modification: false,
        created_at: createdAt,
      })
      if (error) {
        if (error.code === '23505') continue
        console.warn(`[discord] signal insert failed user=${subscriber.user_id}: ${error.message}`)
        continue
      }
      pushParsedSignalToTradeWorker({
        id: signalId,
        user_id: subscriber.user_id,
        channel_id: subscriber.channel_id,
        parsed_data: parsed.parsed,
        status: 'parsed',
        telegram_message_id: message.id,
        is_modification: false,
        created_at: createdAt,
        dispatch_source: 'discord',
      }, { source: 'discord' })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[discord] copy failed user=${subscriber.user_id}: ${detail}`)
    }
  }
}

async function main(): Promise<void> {
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  client.once(Events.ClientReady, () => {
    console.log(`[discord] gateway ready as ${client.user?.tag ?? 'bot'} guilds=${client.guilds.cache.size}`)
    for (const guild of client.guilds.cache.values()) {
      void syncGuild(supabase, guild)
    }
  })
  client.on(Events.GuildCreate, guild => {
    void syncGuild(supabase, guild)
  })
  client.on(Events.ChannelCreate, channel => {
    if (!('guild' in channel)) return
    void cacheTextChannel(supabase, channel)
  })
  client.on(Events.ChannelUpdate, (_previous, channel) => {
    if (!('guild' in channel)) return
    void cacheTextChannel(supabase, channel)
  })
  client.on(Events.ChannelDelete, channel => {
    if (!('guildId' in channel) || !channel.guildId) return
    void supabase
      .from('discord_guild_channels')
      .delete()
      .eq('guild_id', channel.guildId)
      .eq('discord_channel_id', channel.id)
  })
  client.on(Events.MessageCreate, message => {
    void copyMessage(supabase, message)
  })

  await client.login(token)
}

main().catch(err => {
  console.error('[discord] listener stopped', err)
  process.exit(1)
})
