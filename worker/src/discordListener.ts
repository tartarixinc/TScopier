/**
 * One Discord gateway connection for the shared UniCopier bot.
 * Do not run a second process with the same DISCORD_BOT_TOKEN.
 *
 * Intents: guilds, guild messages, and the privileged Message Content intent.
 * Discord must approve Message Content before the bot is in 100 or more servers.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  ChannelType,
  Client,
  Events,
  GatewayCloseCodes,
  GatewayIntentBits,
  type Guild,
  type GuildBasedChannel,
  type Message,
  type TextChannel,
} from 'discord.js'
import WebSocket from 'ws'
import { flattenDiscordMessage } from './discordMessage'
import { discordReadyWatchdogAction } from './discordReadyWatchdog'
import { installRelayFetch } from './relayFetch'
import { parseRawChannelMessage } from './parseSignal'
import { pushParsedSignalToTradeWorker } from './tradeSignalPush'

// Node.js 20 has no native WebSocket; supabase-js realtime refuses to construct
// without one. Same polyfill as index.ts / whatsappListener (noop on Node 22+).
if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
}

type Subscriber = {
  user_id: string
  channel_id: string
  source_display_name: string
}

export type DiscordListenerHandle = {
  client: Client
  stop: () => Promise<void>
}

const DISCORD_READY_CHECK_MS = 60_000
const DISCORD_READY_TIMEOUT_MS = 5 * 60_000
const DISCORD_STOP_TIMEOUT_MS = 5_000

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
    .select('user_id, channel_id, is_active, telegram_channels!inner(is_active, source_kind, display_name, channel_username)')
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
    telegram_channels: {
      is_active?: boolean
      source_kind?: string
      display_name?: string | null
      channel_username?: string | null
    } | Array<{
      is_active?: boolean
      source_kind?: string
      display_name?: string | null
      channel_username?: string | null
    }>
  }>
  return rows.flatMap(row => {
    const shadow = Array.isArray(row.telegram_channels) ? row.telegram_channels[0] : row.telegram_channels
    if (!row.is_active || !shadow?.is_active || shadow.source_kind !== 'discord') return []
    const name = shadow.display_name?.trim()
      || (shadow.channel_username?.trim() ? `@${shadow.channel_username.trim().replace(/^@/, '')}` : '')
      || 'Discord'
    return [{ user_id: row.user_id, channel_id: row.channel_id, source_display_name: name }]
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
  if (!text.trim()) {
    console.log(
      `[discord] skip empty message guild=${message.guild.id} channel=${message.channel.id}`
      + ` embeds=${message.embeds.length} (enable Message Content Intent if body should be readable)`,
    )
    return
  }

  const subscribers = await loadSubscribers(supabase, message.guild.id, message.channel.id)
  if (subscribers.length === 0) {
    console.log(
      `[discord] no active UniCopier links for guild=${message.guild.id} channel=${message.channel.id}`
      + ` — check discord_channels on this SUPABASE_URL`,
    )
    return
  }
  for (const subscriber of subscribers) {
    try {
      const parsed = await parseRawChannelMessage(supabase, subscriber.channel_id, text)
      if (parsed.status !== 'parsed' || parsed.parsed.action === 'ignore') {
        console.log(
          `[discord] parse skipped user=${subscriber.user_id} status=${parsed.status}`
          + ` action=${parsed.status === 'parsed' ? parsed.parsed.action : 'n/a'}`
          + ` text=${JSON.stringify(text.slice(0, 120))}`,
        )
        continue
      }
      const signalId = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const { error } = await supabase.from('signals').insert({
        id: signalId,
        user_id: subscriber.user_id,
        channel_id: subscriber.channel_id,
        source_kind: 'discord',
        source_display_name: subscriber.source_display_name,
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

export async function startDiscordListener(): Promise<DiscordListenerHandle> {
  const token = requireEnv('DISCORD_BOT_TOKEN')
  const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'))
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  })

  // A gateway that never recovers (auth/intent close codes do not auto-reconnect)
  // must exit non-zero so Railway's ON_FAILURE restart policy brings it back.
  let lastReadyAt = Date.now()
  let stopping = false
  const readyWatchdog = setInterval(() => {
    const action = discordReadyWatchdogAction({
      isReady: client.isReady(),
      lastReadyAt,
      now: Date.now(),
      timeoutMs: DISCORD_READY_TIMEOUT_MS,
    })
    if (action === 'reset') {
      lastReadyAt = Date.now()
      return
    }
    if (action === 'wait') return
    const downForMs = Date.now() - lastReadyAt
    console.error(`[discord] gateway not ready for ${Math.round(downForMs / 1000)}s — exiting for restart`)
    clearInterval(readyWatchdog)
    process.exit(1)
  }, DISCORD_READY_CHECK_MS)

  client.once(Events.ClientReady, () => {
    lastReadyAt = Date.now()
    console.log(`[discord] gateway ready as ${client.user?.tag ?? 'bot'} guilds=${client.guilds.cache.size}`)
    for (const guild of client.guilds.cache.values()) {
      void syncGuild(supabase, guild)
    }
  })
  client.on(Events.Error, err => {
    console.warn(`[discord] client error: ${err.message}`)
  })
  client.on(Events.ShardError, (err, shardId) => {
    console.warn(`[discord] shard ${shardId} error: ${err.message}`)
  })
  client.on(Events.ShardDisconnect, (event, shardId) => {
    if (stopping) return
    // discord.js only emits this for unrecoverable close codes; it will not retry.
    const codeName = GatewayCloseCodes[event.code] ?? 'unknown'
    console.error(`[discord] shard ${shardId} disconnected code=${event.code} (${codeName}) — exiting for restart`)
    clearInterval(readyWatchdog)
    process.exit(1)
  })
  client.on(Events.ShardReady, () => {
    lastReadyAt = Date.now()
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

  try {
    await client.login(token)
  } catch (err) {
    clearInterval(readyWatchdog)
    throw err
  }

  return {
    client,
    stop: async () => {
      stopping = true
      clearInterval(readyWatchdog)
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        client.destroy(),
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, DISCORD_STOP_TIMEOUT_MS)
          timer.unref()
        }),
      ])
      if (timer) clearTimeout(timer)
    },
  }
}

if (require.main === module) {
  installRelayFetch()
  startDiscordListener().catch(err => {
    console.error('[discord] listener stopped', err)
    process.exit(1)
  })
}
