import { SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { NewMessage } from 'telegram/events'
import type { NewMessageEvent } from 'telegram/events/NewMessage'
import { Api } from 'telegram/tl'
import { buildClient, tgInvoke } from './telegramClient'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const PARSE_SIGNAL_URL = process.env.PARSE_SIGNAL_URL ?? (
  SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/parse-signal` : ''
)
const RAW_PARSE_SIGNAL_KEY = process.env.PARSE_SIGNAL_KEY ?? ''
const isJwt = (v: string) => v.split('.').length === 3
const PARSE_SIGNAL_AUTH_KEY = isJwt(RAW_PARSE_SIGNAL_KEY)
  ? RAW_PARSE_SIGNAL_KEY
  : SUPABASE_SERVICE_ROLE_KEY
const PARSE_SIGNAL_API_KEY = SUPABASE_SERVICE_ROLE_KEY

/** Min seconds between client.connect() and first getDialogs on a fresh session. */
const COLD_FANOUT_DELAY_MS = 8000
const DIALOG_CACHE_TTL_MS = 60_000
const WATCHDOG_INTERVAL_MS = 30_000
const WATCHDOG_FAILURE_THRESHOLD = 2
const SAFETY_POLL_INTERVAL_MS = 60_000
const SESSION_PERSIST_INTERVAL_MS = 30 * 60_000
const CATCHUP_BACKPRESSURE_MS = 250
const CATCHUP_PER_CHANNEL_CAP = 200
const BACKFILL_PER_CHANNEL_CAP = 1000
const REPLY_CHAIN_SWEEP_MS = 60_000

/** Telegram returns this when the same auth key is online twice (deploy overlap, double connect). */
function isAuthKeyDuplicated(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return m.includes('AUTH_KEY_DUPLICATED')
}

function reconnectCooldownMs(): number {
  return Math.max(500, Math.min(120_000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)))
}

function startConnectJitterMaxMs(): number {
  return Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_START_JITTER_MAX_MS ?? 2000)))
}

export interface ChannelInfo {
  id: string
  title: string
  username: string
  members_count: number
}

export interface ListenerStatus {
  user_id: string
  connected: boolean
  last_event_at: number
  last_reconnect_at: number
  monitored_channels: number
  consecutive_probe_failures: number
}

export interface StartOptions {
  alreadyConnected?: boolean
}

interface ChannelRow {
  id: string
  channel_id: string
  channel_username: string
  last_seen_message_id: number | string | null
}

type Handler = (event: NewMessageEvent) => void

interface MessageLike {
  id: number | bigint
  text?: string | null
  message?: string | null
  replyTo?: unknown
}

interface ChatIdentity {
  chatId: string
  chatIdVariants: string[]
  chatUsername: string
}

/** Telegram / gramjs: extract numeric reply target message id when present. */
function extractReplyToMsgId(replyTo: unknown): string | null {
  if (replyTo == null || typeof replyTo !== 'object') return null
  const r = replyTo as { replyToMsgId?: unknown; reply_to_msg_id?: unknown }
  const v = r.replyToMsgId ?? r.reply_to_msg_id
  if (v == null) return null
  const s = String(v).trim()
  return s ? s : null
}

function looksLikeTradingSignal(text: string, isReply: boolean): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return false

  // Common instrument patterns: EURUSD, XAUUSD, BTCUSDT, US30, etc.
  const hasInstrument =
    /\b[a-z]{6,7}\b/.test(normalized) ||
    /\b(xauusd|xagusd|us30|nas100|spx500|ger40|uk100|btcusdt|ethusdt)\b/.test(normalized)

  const hasDirectionOrAction =
    /\b(buy|sell|long|short|close|tp|take profit|sl|stop loss|breakeven|be)\b/.test(normalized)

  const hasPriceContext =
    /\b\d{1,5}(?:\.\d{1,5})\b/.test(normalized) ||
    /\b(entry|zone|between|above|below|now)\b/.test(normalized)

  const hasTradeStructure =
    /\b(tp\s*\d*|sl|entry|signal|setup)\b/.test(normalized)

  // Reply updates like "move SL to ..." are often signal modifications.
  if (isReply && /\b(move|set|update|adjust|tp|sl|breakeven|be|close)\b/.test(normalized)) {
    return true
  }

  // Require stronger evidence than a single keyword to reduce false positives.
  const score = Number(hasDirectionOrAction) + Number(hasInstrument) + Number(hasPriceContext) + Number(hasTradeStructure)
  return score >= 2
}

function toChannelIdVariants(raw: string): string[] {
  const value = (raw ?? '').trim()
  if (!value) return []

  const out = new Set<string>([value])
  const n = Number(value)
  if (!Number.isFinite(n)) return [...out]

  const abs = String(Math.abs(Math.trunc(n)))
  out.add(abs)

  if (value.startsWith('-100')) {
    out.add(value.slice(4))
  } else if (!value.startsWith('-')) {
    // Telegram often represents channel peers as -100<id> in updates,
    // while dialogs/list results can expose plain positive ids.
    out.add(`-100${value}`)
  } else {
    out.add(`-100${abs}`)
  }

  return [...out]
}

export class UserListener {
  private client: TelegramClient
  private userId: string
  private supabase: SupabaseClient
  private monitoredChannels = new Set<string>()
  private currentHandler: Handler | null = null
  private currentEventBuilder: NewMessage | null = null
  private startedAt = 0
  private dialogsCache: ChannelInfo[] | null = null
  private dialogsCacheAt = 0
  private safetyPollTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private sessionPersistTimer: NodeJS.Timeout | null = null
  private replyChainSweepTimer: NodeJS.Timeout | null = null
  private catchUpInFlight = false
  private isConnected = false
  private lastEventAt = 0
  private lastReconnectAt = 0
  private consecutiveProbeFailures = 0
  private lastSavedSession: string

  constructor(
    userId: string,
    sessionString: string,
    supabase: SupabaseClient,
    adoptedClient?: TelegramClient,
  ) {
    this.userId = userId
    this.supabase = supabase
    this.client = adoptedClient ?? buildClient(sessionString)
    this.lastSavedSession = sessionString
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async start(opts: StartOptions = {}) {
    if (!opts.alreadyConnected) {
      const jm = startConnectJitterMaxMs()
      if (jm > 0) {
        const jitter = Math.floor(Math.random() * (jm + 1))
        if (jitter > 0) await new Promise(r => setTimeout(r, jitter))
      }
      await this.client.connect()
    }
    this.isConnected = true
    this.startedAt = Date.now()
    this.lastEventAt = Date.now()

    await this.refreshChannelSubscription()
    await this.runCatchUp()

    this.startWatchdog()
    this.startSafetyPoll()
    this.startSessionPersist()
    this.startReplyChainSweep()
  }

  async stop() {
    try {
      this.stopTimer('watchdogTimer')
      this.stopTimer('safetyPollTimer')
      this.stopTimer('sessionPersistTimer')
      this.stopTimer('replyChainSweepTimer')
      this.removeCurrentHandler()
      await this.persistSessionIfChanged()
      await this.client.disconnect()
    } catch {
      // ignore disconnect errors
    } finally {
      this.isConnected = false
    }
  }

  private stopTimer(field: 'watchdogTimer' | 'safetyPollTimer' | 'sessionPersistTimer' | 'replyChainSweepTimer') {
    const t = this[field]
    if (t) {
      clearInterval(t)
      this[field] = null
    }
  }

  /** True while MTProto is up after connect/reconnect (false during disconnect/reconnect). */
  isTelegramConnected(): boolean {
    return this.isConnected
  }

  getStatus(): ListenerStatus {
    return {
      user_id: this.userId,
      connected: this.isConnected,
      last_event_at: this.lastEventAt,
      last_reconnect_at: this.lastReconnectAt,
      monitored_channels: this.monitoredChannels.size,
      consecutive_probe_failures: this.consecutiveProbeFailures,
    }
  }

  // ── channel subscription ──────────────────────────────────────────────

  /**
   * Public hook for the session manager's Realtime subscription. Called
   * whenever telegram_channels changes for this user. Refreshes the
   * NewMessage filter and runs catch-up for any newly added channels.
   */
  async onChannelsChanged() {
    const previous = new Set(this.monitoredChannels)
    await this.refreshChannelSubscription()

    const added = [...this.monitoredChannels].filter(c => !previous.has(c))
    if (added.length === 0) return

    // Catch up only the newly added channels — full catchUp would re-scan
    // every channel and is wasteful when the user just toggled one on.
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('is_active', true)
    const lookup = new Map<string, ChannelRow>()
    for (const row of (rows ?? []) as ChannelRow[]) {
      if (row.channel_id) {
        for (const v of toChannelIdVariants(row.channel_id)) {
          lookup.set(v, row)
        }
      }
      if (row.channel_username) lookup.set(row.channel_username.toLowerCase(), row)
    }
    for (const key of added) {
      const row = lookup.get(key)
      if (row) await this.catchUpChannel(row).catch(err =>
        console.error(`[userListener] catchUp (added) failed for ${row.id}:`, err)
      )
    }
  }

  /**
   * Read the active channel set for this user and (re)subscribe the
   * NewMessage handler scoped to those chats only. Listening globally
   * (NewMessage({})) and filtering in JS is one of the userbot
   * fingerprints Telegram flags on cold accounts.
   */
  private async refreshChannelSubscription() {
    const next = await this.loadChannels()

    if (this.currentHandler && this.setsEqual(next, this.monitoredChannels)) {
      return
    }

    this.removeCurrentHandler()
    this.monitoredChannels = next

    if (next.size === 0) return

    const handler: Handler = (event: NewMessageEvent) => {
      this.handleMessage(event).catch(err => {
        console.error(`[userListener] handleMessage error for ${this.userId}:`, err)
      })
    }
    // NOTE:
    // Passing `chats:` here depends on Telegram/gramjs resolving each chat
    // identifier exactly as expected. In practice, channel ids can vary in
    // representation (e.g. -100 prefix / raw ids), and a mismatch can result
    // in silently missing all updates. We subscribe to all incoming messages
    // and apply strict user/channel filtering in handleMessage() instead.
    // Important: do not use `incoming: true` here — channel posts are not
    // always classified as "incoming", which can cause silent drops.
    const builder = new NewMessage({})
    this.client.addEventHandler(handler, builder)
    this.currentHandler = handler
    this.currentEventBuilder = builder
  }

  private removeCurrentHandler() {
    if (this.currentHandler && this.currentEventBuilder) {
      try {
        this.client.removeEventHandler(this.currentHandler, this.currentEventBuilder)
      } catch {
        // ignore
      }
    }
    this.currentHandler = null
    this.currentEventBuilder = null
  }

  private setsEqual(a: Set<string>, b: Set<string>) {
    if (a.size !== b.size) return false
    for (const v of a) if (!b.has(v)) return false
    return true
  }

  private async loadChannels(): Promise<Set<string>> {
    const { data } = await this.supabase
      .from('telegram_channels')
      .select('channel_id, channel_username')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    const next = new Set<string>()
    for (const ch of data ?? []) {
      if (ch.channel_id) {
        for (const v of toChannelIdVariants(ch.channel_id)) next.add(v)
      }
      if (ch.channel_username) next.add(ch.channel_username.toLowerCase())
    }
    return next
  }

  // ── public dialog listing for onboarding UI ───────────────────────────

  /**
   * Return user's channels/groups. Delays the first call after start to
   * avoid cold-session fan-out, pages with a small limit, and caches the
   * result briefly so onboarding UI re-renders don't re-hit Telegram.
   */
  async listChannels(): Promise<ChannelInfo[]> {
    const elapsed = Date.now() - this.startedAt
    if (elapsed >= 0 && elapsed < COLD_FANOUT_DELAY_MS) {
      await new Promise(r => setTimeout(r, COLD_FANOUT_DELAY_MS - elapsed))
    }

    if (this.dialogsCache && (Date.now() - this.dialogsCacheAt) < DIALOG_CACHE_TTL_MS) {
      return this.dialogsCache
    }

    const dialogs = await this.client.getDialogs({ limit: 20 })
    const channels: ChannelInfo[] = dialogs
      .filter(d => d.isChannel || d.isGroup)
      .map(d => {
        const entity = (d.entity ?? {}) as { username?: string; participantsCount?: number }
        return {
          id: String(d.id ?? ''),
          title: d.title ?? 'Unknown',
          username: entity.username ?? '',
          members_count: entity.participantsCount ?? 0,
        }
      })
      .filter(c => !!c.id)

    this.dialogsCache = channels
    this.dialogsCacheAt = Date.now()
    return channels
  }

  /**
   * Explicit historical import used by channel insights profiling.
   * Fetches and stores matching messages for the last N days even when
   * last_seen_message_id is still empty (seed-only mode).
   */
  async backfillChannelHistory(channelRowId: string, days: number): Promise<{ imported: number; messages: string[] }> {
    const lookbackDays = Math.max(1, Math.min(90, Number(days || 30)))
    const { data: row, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('id', channelRowId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) throw new Error('Channel not found')

    const messages = await this.backfillChannelFromDate(row as ChannelRow, lookbackDays)
    return { imported: messages.length, messages }
  }

  /**
   * Fetch Telegram messages in [fromIso, toIso] for backtest only.
   * Does not write to `signals` or trigger copier parse/trade execution.
   */
  async importBacktestChannelHistory(
    channelRowId: string,
    fromIso: string,
    toIso: string,
  ): Promise<{ messages: Array<{ telegram_message_id: string; raw_message: string; signal_at: string }>; messages_scanned: number }> {
    const fromMs = new Date(fromIso).getTime()
    const toMs = new Date(toIso.includes('T') ? toIso : `${toIso}T23:59:59.999Z`).getTime()
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new Error('Invalid backtest date range')
    }

    const { data: row, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('id', channelRowId)
      .eq('is_active', true)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!row) throw new Error('Channel not found')

    const collected = await this.fetchMessagesBetween(row as ChannelRow, fromMs, toMs)
    const messages: Array<{ telegram_message_id: string; raw_message: string; signal_at: string }> = []

    for (const m of collected) {
      const raw = String(m.text ?? m.message ?? '').trim()
      if (!raw) continue
      const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
      const signalAt = epoch > 0
        ? new Date(epoch * 1000).toISOString()
        : new Date().toISOString()
      messages.push({
        telegram_message_id: String(m.id),
        raw_message: raw,
        signal_at: signalAt,
      })
    }

    return { messages, messages_scanned: collected.length }
  }

  // ── live message handling ─────────────────────────────────────────────

  private async handleMessage(event: NewMessageEvent) {
    this.lastEventAt = Date.now()

    const message = event.message
    if (!message) return

    const { chatId, chatIdVariants, chatUsername } = await this.resolveChatIdentity(event)
    if (!chatId && !chatUsername) return

    // We subscribe broadly and filter by our own monitored set.
    const isMonitored =
      chatIdVariants.some(v => this.monitoredChannels.has(v)) ||
      (!!chatUsername && this.monitoredChannels.has(chatUsername))
    if (!isMonitored) return

    console.log(
      `[userListener] message candidate user=${this.userId} chatId=${chatId} variants=${chatIdVariants.join(',')} username=${chatUsername || '-'} msgId=${String(message.id)}`,
    )

    // Prefer channel_id matching across normalized variants, fallback to username.
    let channelRow: ChannelRow | null = null
    if (chatIdVariants.length > 0) {
      const idRes = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id')
        .eq('user_id', this.userId)
        .eq('is_active', true)
        .in('channel_id', chatIdVariants)
        .limit(1)
        .maybeSingle()
      channelRow = (idRes.data as ChannelRow | null) ?? null
    }

    if (!channelRow && chatUsername) {
      const usernameRes = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id')
        .eq('user_id', this.userId)
        .eq('is_active', true)
        .eq('channel_username', chatUsername)
        .limit(1)
        .maybeSingle()
      channelRow = (usernameRes.data as ChannelRow | null) ?? null
    }

    if (!channelRow) {
      console.warn(
        `[userListener] monitored message could not map to telegram_channels row user=${this.userId} chatId=${chatId} username=${chatUsername || '-'} variants=${chatIdVariants.join(',')}`,
      )
      return
    }

    await this.logSignal(channelRow, {
      id: message.id,
      text: message.text ?? message.message,
      replyTo: message.replyTo,
    })
  }

  /**
   * Resolve chat identity for an update without depending solely on
   * getChat(), which can fail transiently when gramjs entity cache is cold.
   */
  private async resolveChatIdentity(event: NewMessageEvent): Promise<ChatIdentity> {
    const fallbackId = event.chatId != null ? String(event.chatId) : ''
    let chatId = fallbackId
    let chatUsername = ''

    try {
      const chat = await event.message?.getChat()
      if (chat) {
        const chatRaw = chat as unknown as { id?: unknown; username?: string }
        if (chatRaw.id != null) chatId = String(chatRaw.id)
        chatUsername = (chatRaw.username ?? '').toLowerCase()
      }
    } catch {
      // Fallback to event.chatId if entity lookup fails.
    }

    return {
      chatId,
      chatIdVariants: toChannelIdVariants(chatId),
      chatUsername,
    }
  }

  /**
   * Single insert path used by both live events (handleMessage) and
   * catch-up (catchUpChannel). Idempotent via the unique partial index
   * on signals(user_id, telegram_message_id) — a row that already exists
   * is left untouched and parse-signal is not re-fired.
   */
  private async logSignal(channelRow: ChannelRow, message: MessageLike): Promise<boolean> {
    const messageId = String(message.id)
    const rawMessage = (message.text ?? message.message ?? '') as string
    const isReply = !!message.replyTo
    const replyToMessageId = extractReplyToMsgId(message.replyTo)
    let parentSignalId: string | null = null
    if (replyToMessageId) {
      parentSignalId = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId)
    }

    if (!looksLikeTradingSignal(rawMessage, isReply)) {
      console.log(
        `[userListener] skipped non-signal user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`,
      )
      return false
    }

    const { data: signalRow, error: insertErr } = await this.supabase
      .from('signals')
      .upsert(
        {
          user_id: this.userId,
          channel_id: channelRow.id,
          raw_message: rawMessage,
          raw_image_url: null,
          status: 'pending',
          telegram_message_id: messageId,
          is_modification: isReply,
          parent_signal_id: parentSignalId,
          reply_to_message_id: replyToMessageId,
        },
        { onConflict: 'user_id,telegram_message_id', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle()

    if (insertErr) {
      console.error(`[userListener] logSignal upsert failed for ${this.userId}:`, insertErr.message)
      return false
    }

    if (!signalRow) {
      console.log(
        `[userListener] duplicate message ignored user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`,
      )
      return false // duplicate — skip parse-signal
    }

    await this.bumpLastSeen(channelRow.id, messageId)

    if (replyToMessageId && !parentSignalId) {
      const lateParent = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId)
      if (lateParent) {
        await this.supabase
          .from('signals')
          .update({ parent_signal_id: lateParent })
          .eq('id', signalRow.id)
      }
    }
    await this.relinkReplyOrphansAfterParentInsert(channelRow.id, messageId, signalRow.id)

    console.log(
      `[userListener] signal inserted user=${this.userId} signalId=${signalRow.id} channelRow=${channelRow.id} messageId=${messageId}`,
    )
    // #region agent log
    fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H1',location:'worker/src/userListener.ts:422',message:'signal inserted before parse trigger',data:{userId:this.userId,signalId:signalRow.id,channelRowId:channelRow.id,messageId},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (PARSE_SIGNAL_URL) {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: this.userId,
        signal_id: signalRow.id,
        action: 'pipeline_parse_dispatch',
        status: 'attempt',
        request_payload: {
          parse_signal_url: PARSE_SIGNAL_URL,
          has_parse_auth_key: !!PARSE_SIGNAL_AUTH_KEY,
          parse_auth_source: isJwt(RAW_PARSE_SIGNAL_KEY) ? 'PARSE_SIGNAL_KEY(jwt)' : 'SUPABASE_SERVICE_ROLE_KEY(fallback)',
          signal_id: signalRow.id,
        },
      })
      // #region agent log
      fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H2',location:'worker/src/userListener.ts:426',message:'parse trigger dispatch',data:{signalId:signalRow.id,hasParseUrl:!!PARSE_SIGNAL_URL,hasParseAuthKey:!!PARSE_SIGNAL_AUTH_KEY},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort('parse-timeout'), 10000)
      try {
        const res = await fetch(PARSE_SIGNAL_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
            'apikey': PARSE_SIGNAL_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signal_id: signalRow.id }),
          signal: controller.signal,
        })
        await this.supabase.from('trade_execution_logs').insert({
          user_id: this.userId,
          signal_id: signalRow.id,
          action: 'pipeline_parse_dispatch',
          status: res.ok ? 'success' : 'failed',
          response_payload: { status: res.status, ok: res.ok },
          error_message: res.ok ? null : `parse-signal returned ${res.status}`,
        })
        // #region agent log
        fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H2',location:'worker/src/userListener.ts:434',message:'parse trigger response',data:{signalId:signalRow.id,status:res.status,ok:res.ok},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[userListener] parse-signal call failed for signal ${signalRow.id}:`, errMsg)
        await this.supabase.from('trade_execution_logs').insert({
          user_id: this.userId,
          signal_id: signalRow.id,
          action: 'pipeline_parse_dispatch',
          status: 'failed',
          error_message: errMsg,
        })
        // #region agent log
        fetch('http://127.0.0.1:7911/ingest/9eb853c4-6a95-4829-9e4e-863df98c5251',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7e177e'},body:JSON.stringify({sessionId:'7e177e',runId:'run1',hypothesisId:'H2',location:'worker/src/userListener.ts:438',message:'parse trigger failed',data:{signalId:signalRow.id,error:errMsg},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      } finally {
        clearTimeout(timeout)
      }
    }

    return true
  }

  /** Resolve `signals.id` of the parent message in this channel (telegram_channels row id). */
  private async resolveParentSignalIdForReply(
    channelRowId: string,
    replyToMessageId: string,
  ): Promise<string | null> {
    const { data } = await this.supabase
      .from('signals')
      .select('id')
      .eq('user_id', this.userId)
      .eq('channel_id', channelRowId)
      .eq('telegram_message_id', replyToMessageId)
      .maybeSingle()
    return (data as { id?: string } | null)?.id ?? null
  }

  /** Link orphan replies that pointed at this Telegram message id before the parent row existed. */
  private async relinkReplyOrphansAfterParentInsert(
    channelRowId: string,
    parentTelegramMessageId: string,
    parentSignalUuid: string,
  ): Promise<void> {
    await this.supabase
      .from('signals')
      .update({ parent_signal_id: parentSignalUuid })
      .eq('user_id', this.userId)
      .eq('channel_id', channelRowId)
      .eq('reply_to_message_id', parentTelegramMessageId)
      .is('parent_signal_id', null)
  }

  private startReplyChainSweep() {
    if (this.replyChainSweepTimer) return
    this.replyChainSweepTimer = setInterval(() => {
      this.runReplyChainSweep().catch(err =>
        console.error(`[userListener] reply-chain sweep error for ${this.userId}:`, err),
      )
    }, REPLY_CHAIN_SWEEP_MS)
    this.replyChainSweepTimer.unref?.()
  }

  /** Re-resolve `parent_signal_id` for recent replies (parent may have arrived later). */
  private async runReplyChainSweep() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: orphans, error } = await this.supabase
      .from('signals')
      .select('id, channel_id, reply_to_message_id')
      .eq('user_id', this.userId)
      .not('reply_to_message_id', 'is', null)
      .is('parent_signal_id', null)
      .gte('created_at', since)
      .limit(80)
    if (error || !orphans?.length) return

    for (const row of orphans as { id: string; channel_id: string; reply_to_message_id: string }[]) {
      const rid = row.reply_to_message_id?.trim()
      if (!rid || !row.channel_id) continue
      const parentId = await this.resolveParentSignalIdForReply(row.channel_id, rid)
      if (parentId) {
        await this.supabase
          .from('signals')
          .update({ parent_signal_id: parentId })
          .eq('id', row.id)
      }
    }
  }

  private async bumpLastSeen(channelRowId: string, messageId: string) {
    const num = Number(messageId)
    if (!Number.isFinite(num)) return

    // Only advance the high-water mark forwards.
    await this.supabase
      .from('telegram_channels')
      .update({
        last_seen_message_id: num,
        last_seen_at: new Date().toISOString(),
      })
      .eq('id', channelRowId)
      .or(`last_seen_message_id.is.null,last_seen_message_id.lt.${num}`)
  }

  // ── catch-up after connect/reconnect ──────────────────────────────────

  private async runCatchUp() {
    if (this.catchUpInFlight) return
    this.catchUpInFlight = true
    try {
      const { data: rows } = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id')
        .eq('user_id', this.userId)
        .eq('is_active', true)

      for (const row of (rows ?? []) as ChannelRow[]) {
        await this.catchUpChannel(row).catch(err =>
          console.error(`[userListener] catchUp failed for channel ${row.id}:`, err)
        )
      }
    } finally {
      this.catchUpInFlight = false
    }
  }

  private async catchUpChannel(row: ChannelRow): Promise<void> {
    let peer: unknown
    try {
      peer = await this.client.getInputEntity(row.channel_username || row.channel_id)
    } catch (err) {
      // Entity cache miss (common right after fresh connect for channels
      // we've never seen via dialogs). The next live message will
      // populate the cache; subsequent reconnects can catch up then.
      console.warn(`[userListener] getInputEntity miss for channel ${row.id}; skipping catch-up this round`)
      return
    }

    const minIdRaw = row.last_seen_message_id
    const minId = minIdRaw == null ? 0 : Number(minIdRaw)
    if (!Number.isFinite(minId) || minId < 0) {
      console.warn(`[userListener] invalid last_seen for channel ${row.id}; skipping catch-up`)
      return
    }

    if (minId === 0) {
      // Seed-only on first-ever listen — do not backfill historical messages.
      // Without this, a user picking a 5-year-old signal channel would
      // import its entire history.
      try {
        const latest = await this.client.getMessages(peer as never, { limit: 1 })
        if (latest[0]) await this.bumpLastSeen(row.id, String(latest[0].id))
      } catch (err) {
        console.warn(`[userListener] seed last_seen failed for channel ${row.id}:`, err)
      }
      return
    }

    const collected: MessageLike[] = []
    let offsetId = 0
    const batchSize = 50

    while (collected.length < CATCHUP_PER_CHANNEL_CAP) {
      let batch: Array<MessageLike & { id: number | bigint }>
      try {
        batch = (await this.client.getMessages(peer as never, {
          limit: batchSize,
          offsetId,
          minId,
        })) as unknown as Array<MessageLike & { id: number | bigint }>
      } catch (err) {
        console.error(`[userListener] getMessages failed for channel ${row.id}:`, err)
        break
      }

      if (!batch.length) break
      for (const m of batch) collected.push(m)
      offsetId = Number(batch[batch.length - 1].id)
      if (batch.length < batchSize) break
      await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS))
    }

    // gramjs returns newest-first; insert oldest-first so last_seen
    // monotonically advances and parse-signal sees signals in order.
    collected.sort((a, b) => Number(a.id) - Number(b.id))
    for (const m of collected) {
      const mid = Number(m.id)
      if (!Number.isFinite(mid)) continue
      // Never re-queue messages at or below the persisted high-water mark
      // (belt-and-suspenders on top of gramjs minId filtering).
      if (mid <= minId) continue
      await this.logSignal(row, m)
    }
  }

  private messageEpochSec(m: MessageLike & { date?: number | Date | string }): number {
    const dateRaw = m.date
    if (typeof dateRaw === 'number') return dateRaw
    if (dateRaw instanceof Date) return Math.floor(dateRaw.getTime() / 1000)
    if (typeof dateRaw === 'string') {
      const t = Date.parse(dateRaw)
      return Number.isFinite(t) ? Math.floor(t / 1000) : 0
    }
    return 0
  }

  private async fetchMessagesBetween(
    row: ChannelRow,
    fromMs: number,
    toMs: number,
  ): Promise<MessageLike[]> {
    const fromSec = Math.floor(fromMs / 1000)
    const toSec = Math.floor(toMs / 1000)

    let peer: unknown
    try {
      peer = await this.client.getInputEntity(row.channel_username || row.channel_id)
    } catch {
      throw new Error('Failed to resolve Telegram channel entity')
    }

    const collected: MessageLike[] = []
    let offsetId = 0
    const batchSize = 100

    while (collected.length < BACKFILL_PER_CHANNEL_CAP) {
      let batch: Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      try {
        batch = (await this.client.getMessages(peer as never, {
          limit: batchSize,
          offsetId,
        })) as unknown as Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      } catch {
        break
      }
      if (!batch.length) break

      let reachedOlderThanRange = false
      for (const m of batch) {
        const msgEpochSec = this.messageEpochSec(m)
        if (msgEpochSec && msgEpochSec < fromSec) {
          reachedOlderThanRange = true
          continue
        }
        if (msgEpochSec && msgEpochSec > toSec) {
          continue
        }
        const raw = String(m.text ?? m.message ?? '').trim()
        if (!raw) continue
        const isReply = !!m.replyTo
        if (!looksLikeTradingSignal(raw, isReply)) continue
        collected.push(m)
      }

      offsetId = Number(batch[batch.length - 1].id)
      if (batch.length < batchSize || reachedOlderThanRange) break
      await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS))
    }

    collected.sort((a, b) => Number(a.id) - Number(b.id))
    return collected
  }

  private async backfillChannelFromDate(row: ChannelRow, days: number): Promise<string[]> {
    let peer: unknown
    try {
      peer = await this.client.getInputEntity(row.channel_username || row.channel_id)
    } catch {
      throw new Error('Failed to resolve Telegram channel entity')
    }

    const sinceEpochSec = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000)
    const collected: MessageLike[] = []
    let offsetId = 0
    const batchSize = 100

    while (collected.length < BACKFILL_PER_CHANNEL_CAP) {
      let batch: Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      try {
        batch = (await this.client.getMessages(peer as never, {
          limit: batchSize,
          offsetId,
        })) as unknown as Array<MessageLike & { id: number | bigint; date?: number | Date | string }>
      } catch {
        break
      }
      if (!batch.length) break

      for (const m of batch) {
        const dateRaw = m.date
        const msgEpochSec = (() => {
          if (typeof dateRaw === 'number') return dateRaw
          if (dateRaw instanceof Date) return Math.floor(dateRaw.getTime() / 1000)
          if (typeof dateRaw === 'string') {
            const t = Date.parse(dateRaw)
            return Number.isFinite(t) ? Math.floor(t / 1000) : 0
          }
          return 0
        })()
        if (msgEpochSec && msgEpochSec < sinceEpochSec) {
          // We've reached older-than-lookback history.
          offsetId = Number(batch[batch.length - 1].id)
          break
        }
        collected.push(m)
      }

      offsetId = Number(batch[batch.length - 1].id)
      if (batch.length < batchSize) break
      const oldest = batch[batch.length - 1]
      const oldestEpochSec = (() => {
        const dateRaw = oldest?.date
        if (typeof dateRaw === 'number') return dateRaw
        if (dateRaw instanceof Date) return Math.floor(dateRaw.getTime() / 1000)
        if (typeof dateRaw === 'string') {
          const t = Date.parse(dateRaw)
          return Number.isFinite(t) ? Math.floor(t / 1000) : 0
        }
        return 0
      })()
      if (oldestEpochSec && oldestEpochSec < sinceEpochSec) break
      await new Promise(r => setTimeout(r, CATCHUP_BACKPRESSURE_MS))
    }

    collected.sort((a, b) => Number(a.id) - Number(b.id))
    const out: string[] = []
    for (const m of collected) {
      const raw = String(m.text ?? m.message ?? '').trim()
      if (!raw) continue
      const isReply = !!m.replyTo
      if (!looksLikeTradingSignal(raw, isReply)) continue
      out.push(raw)
      if (out.length >= 300) break
    }
    return out
  }

  // ── watchdog ──────────────────────────────────────────────────────────

  private startWatchdog() {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => {
      this.runWatchdog().catch(err =>
        console.error(`[userListener] watchdog tick error for ${this.userId}:`, err)
      )
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref?.()
  }

  /**
   * Probe MTProto with a cheap authenticated call. With library autoReconnect
   * disabled (see `buildClient`), TCP drops and zombie sockets are handled here:
   * the probe forces a round-trip; consecutive failures trigger an explicit
   * disconnect + cooldown + reconnect in `forceReconnect`.
   */
  private async runWatchdog() {
    try {
      await tgInvoke(this.client, new Api.updates.GetState())
      this.consecutiveProbeFailures = 0
      this.lastEventAt = this.lastEventAt || Date.now()
    } catch (err) {
      this.consecutiveProbeFailures++
      console.warn(
        `[watchdog] probe failed (${this.consecutiveProbeFailures}/${WATCHDOG_FAILURE_THRESHOLD}) for ${this.userId}:`,
        err instanceof Error ? err.message : String(err),
      )
      if (this.consecutiveProbeFailures >= WATCHDOG_FAILURE_THRESHOLD) {
        await this.forceReconnect()
      }
    }
  }

  private async forceReconnect() {
    console.log(`[userListener] force reconnect for ${this.userId}`)
    this.lastReconnectAt = Date.now()
    this.consecutiveProbeFailures = 0
    this.isConnected = false
    const cooldown = reconnectCooldownMs()
    try { await this.client.disconnect() } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, cooldown))
    try {
      await this.client.connect()
      this.isConnected = true
    } catch (err) {
      console.error(`[userListener] reconnect failed for ${this.userId}:`, err)
      if (!isAuthKeyDuplicated(err)) return
      console.warn(
        `[userListener] AUTH_KEY_DUPLICATED for ${this.userId} — waiting 15s then one retry`
        + ' (overlapping worker instance or session still closing on Telegram)',
      )
      try { await this.client.disconnect() } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 15_000))
      try {
        await this.client.connect()
        this.isConnected = true
      } catch (err2) {
        console.error(`[userListener] reconnect retry failed for ${this.userId}:`, err2)
        return
      }
    }
    // Rebind handler — the previous one was attached to the disconnected
    // session and may not survive the reconnect cleanly.
    this.removeCurrentHandler()
    this.monitoredChannels.clear()
    await this.refreshChannelSubscription()
    // Do NOT run history catch-up here: `runCatchUp` walks Telegram history and
    // calls `logSignal` for each candidate, which can re-dispatch parse/trade
    // for messages the worker already processed (duplicate handling + last_seen
    // edge cases). Mid-session reconnects should rely on live `NewMessage`
    // updates + Telegram's own gap recovery. Full catch-up only runs from
    // `start()` after a cold boot.
    await this.runReplyChainSweep()
  }

  // ── safety poll (Realtime drop fallback) ──────────────────────────────

  private startSafetyPoll() {
    if (this.safetyPollTimer) return
    this.safetyPollTimer = setInterval(() => {
      this.refreshChannelSubscription().catch(err =>
        console.error(`[userListener] safety poll error for ${this.userId}:`, err)
      )
    }, SAFETY_POLL_INTERVAL_MS)
    this.safetyPollTimer.unref?.()
  }

  // ── session string rotation ───────────────────────────────────────────

  private startSessionPersist() {
    if (this.sessionPersistTimer) return
    this.sessionPersistTimer = setInterval(() => {
      this.persistSessionIfChanged().catch(err =>
        console.error(`[userListener] session persist error for ${this.userId}:`, err)
      )
    }, SESSION_PERSIST_INTERVAL_MS)
    this.sessionPersistTimer.unref?.()
  }

  /**
   * gramjs occasionally rotates auth_key state inside the session. If we
   * crash without persisting the new state, the next start re-handshakes
   * from a stale snapshot which can look suspicious to Telegram. Persist
   * on a 30-min cadence and on graceful shutdown.
   */
  private async persistSessionIfChanged() {
    let current: string
    try {
      current = (this.client.session.save() as unknown) as string
    } catch {
      return
    }
    if (!current || current === this.lastSavedSession) return

    const { error } = await this.supabase
      .from('telegram_sessions')
      .update({ session_string: current })
      .eq('user_id', this.userId)

    if (error) {
      console.error(`[userListener] session_string update failed for ${this.userId}:`, error.message)
      return
    }
    this.lastSavedSession = current
  }
}
