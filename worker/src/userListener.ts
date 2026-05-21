import { randomUUID } from 'node:crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { NewMessage } from 'telegram/events'
import type { NewMessageEvent } from 'telegram/events/NewMessage'
import { Api } from 'telegram/tl'
import { buildClient, isAuthKeyUnregistered, rethrowIfSessionInvalid, TelegramSessionInvalidError, tgInvoke } from './telegramClient'
import { tradeableFromParsed } from './backtestSignal'
import { hasTradableInstrumentInText } from './tradableSymbol'
import type { SignalRow } from './tradeExecutor'
import { pushParsedSignalToTradeWorker } from './tradeSignalPush'
import { getChannelParseContext, invalidateChannelParseCache } from './channelKeywordsCache'
import { parseChannelMessageSync, parseRawChannelMessage } from './parseSignal'
import type { PipelineTimestamps } from './pipelineTimestamps'
import { incMetric } from './workerMetrics'
import { workerConfig } from './workerConfig'

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

function listenerInlineParseEnabled(): boolean {
  const v = String(process.env.LISTENER_INLINE_PARSE ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** Min seconds between client.connect() and first getDialogs on a fresh session. */
const COLD_FANOUT_DELAY_MS = 8000
const DIALOG_CACHE_TTL_MS = 60_000
const DIALOG_MAX_SCAN = 500
const WATCHDOG_INTERVAL_MS = 30_000
const WATCHDOG_FAILURE_THRESHOLD = 2
const SAFETY_POLL_INTERVAL_MS = 60_000
const SESSION_PERSIST_INTERVAL_MS = 30 * 60_000
const CATCHUP_BACKPRESSURE_MS = 250
const CATCHUP_PER_CHANNEL_CAP = 200
const BACKFILL_PER_CHANNEL_CAP = 1000
const REPLY_CHAIN_SWEEP_MS = 60_000

function catchUpOnStartEnabled(): boolean {
  const v = String(process.env.TELEGRAM_CATCHUP_ON_START ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** Skip catch-up parse/trade for Telegram posts older than this (avoids stale fills after deploy). */
function catchUpMaxAgeMs(): number {
  const minutes = Math.max(1, Math.min(24 * 60, Number(process.env.TELEGRAM_CATCHUP_MAX_AGE_MINUTES ?? 20)))
  return minutes * 60_000
}

function catchUpParseConcurrency(): number {
  return Math.max(1, Math.min(4, Number(process.env.TELEGRAM_CATCHUP_PARSE_CONCURRENCY ?? 2)))
}

function livePriorityPauseMs(): number {
  return Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_LIVE_PRIORITY_PAUSE_MS ?? 3000)))
}

/** Telegram returns this when the same auth key is online twice (deploy overlap, double connect). */
function isAuthKeyDuplicated(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return m.includes('AUTH_KEY_DUPLICATED')
}

function reconnectCooldownMs(): number {
  return Math.max(500, Math.min(120_000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)))
}

const AUTH_KEY_DUP_RECONNECT_DELAY_MS = Math.max(
  2_000, Math.min(30_000, Number(process.env.TELEGRAM_AUTH_DUP_RECONNECT_DELAY_MS ?? 10_000)),
)

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

  const hasInstrument = hasTradableInstrumentInText(text)

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
  /** Set when start() reuses the auth-time client (no second connect). */
  private startedWithLiveClient = false
  private dialogsCache: ChannelInfo[] | null = null
  private dialogsCacheAt = 0
  private safetyPollTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private sessionPersistTimer: NodeJS.Timeout | null = null
  private replyChainSweepTimer: NodeJS.Timeout | null = null
  private catchUpInFlight = false
  private catchUpParseActive = 0
  private lastLiveMessageAt = 0
  private isConnected = false
  private lastEventAt = 0
  private lastReconnectAt = 0
  private consecutiveProbeFailures = 0
  private lastSavedSession: string
  private onSignalParsed: ((row: SignalRow) => boolean) | null = null

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

  /** Immediate trade dispatch after parse (avoids waiting on Supabase Realtime). */
  setOnSignalParsed(handler: ((row: SignalRow) => boolean) | null): void {
    this.onSignalParsed = handler
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async start(opts: StartOptions = {}) {
    if (!opts.alreadyConnected) {
      const jm = startConnectJitterMaxMs()
      if (jm > 0) {
        const jitter = Math.floor(Math.random() * (jm + 1))
        if (jitter > 0) await new Promise(r => setTimeout(r, jitter))
      }
      try {
        await this.client.connect()
      } catch (err) {
        if (isAuthKeyUnregistered(err)) throw new TelegramSessionInvalidError()
        if (isAuthKeyDuplicated(err)) {
          console.warn(
            `[userListener] AUTH_KEY_DUPLICATED on initial connect for ${this.userId}`
            + ` — old session still releasing; waiting ${AUTH_KEY_DUP_RECONNECT_DELAY_MS}ms then retrying`,
          )
          incMetric('auth_key_duplicated')
          try { await this.client.disconnect() } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, AUTH_KEY_DUP_RECONNECT_DELAY_MS))
          await this.client.connect()
        } else {
          throw err
        }
      }
    }
    this.isConnected = true
    this.startedAt = Date.now()
    this.lastEventAt = Date.now()

    await this.refreshChannelSubscription()
    this.scheduleCatchUpOnStart()

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
      this.clearDialogsCache()
    }
  }

  private clearDialogsCache() {
    this.dialogsCache = null
    this.dialogsCacheAt = 0
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
    const { data: activeChannelRows } = await this.supabase
      .from('telegram_channels')
      .select('id')
      .eq('user_id', this.userId)
      .eq('is_active', true)
    for (const row of activeChannelRows ?? []) {
      const id = (row as { id?: string }).id
      if (id) invalidateChannelParseCache(id)
    }
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
  async listChannels(opts?: { skipColdDelay?: boolean }): Promise<ChannelInfo[]> {
    if (!opts?.skipColdDelay && !this.startedWithLiveClient) {
      const elapsed = Date.now() - this.startedAt
      if (elapsed >= 0 && elapsed < COLD_FANOUT_DELAY_MS) {
        await new Promise(r => setTimeout(r, COLD_FANOUT_DELAY_MS - elapsed))
      }
    }

    if (this.dialogsCache && (Date.now() - this.dialogsCacheAt) < DIALOG_CACHE_TTL_MS) {
      return this.dialogsCache
    }

    let dialogs: Awaited<ReturnType<TelegramClient['getDialogs']>>
    try {
      dialogs = await this.fetchAllDialogs()
    } catch (err) {
      if (isAuthKeyDuplicated(err)) {
        dialogs = await this.reconnectAndRetryDialogs()
      } else {
        rethrowIfSessionInvalid(err)
      }
    }

    const byId = new Map<string, ChannelInfo>()
    for (const d of dialogs) {
      if (!d.isChannel && !d.isGroup) continue
      const entity = (d.entity ?? {}) as { username?: string; participantsCount?: number }
      const id = String(d.id ?? '')
      if (!id) continue
      byId.set(id, {
        id,
        title: d.title ?? 'Unknown',
        username: entity.username ?? '',
        members_count: entity.participantsCount ?? 0,
      })
    }
    const channels = [...byId.values()]

    this.dialogsCache = channels
    this.dialogsCacheAt = Date.now()
    return channels
  }

  private async reconnectAndRetryDialogs(): Promise<Awaited<ReturnType<TelegramClient['getDialogs']>>> {
    console.warn(
      `[userListener] AUTH_KEY_DUPLICATED on getDialogs for ${this.userId}`
      + ' — disconnecting, waiting for old session to release, then reconnecting',
    )
    incMetric('auth_key_duplicated')
    this.isConnected = false
    try { await this.client.disconnect() } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, AUTH_KEY_DUP_RECONNECT_DELAY_MS))
    await this.client.connect()
    this.isConnected = true
    return this.fetchAllDialogs()
  }

  /**
   * Load channel/group dialogs (capped). Uses gramjs built-in pagination, which
   * offsets by top *message* id — not dialog/peer id (large channel ids overflow int32).
   */
  private async fetchAllDialogs(): Promise<Awaited<ReturnType<TelegramClient['getDialogs']>>> {
    return this.client.getDialogs({ limit: DIALOG_MAX_SCAN })
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

    const collected = await this.fetchMessagesBetweenForBacktest(row as ChannelRow, fromMs, toMs)
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

  /**
   * Sync Telegram history into backtest_channel_signals (parse + upsert on worker).
   */
  async syncBacktestSignals(
    channelRowId: string,
    fromIso: string,
    toIso: string,
    opts?: { runId?: string },
  ): Promise<{
    messages_scanned: number
    candidates: number
    imported: number
    errors: string[]
  }> {
    const fromMs = new Date(fromIso).getTime()
    const toMs = new Date(toIso.includes('T') ? toIso : `${toIso}T23:59:59.999Z`).getTime()
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      throw new Error('Invalid backtest date range')
    }

    if (!PARSE_SIGNAL_URL || !PARSE_SIGNAL_AUTH_KEY) {
      throw new Error('PARSE_SIGNAL_URL / service role key not configured on worker')
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

    const collected = await this.fetchMessagesBetweenForBacktest(row as ChannelRow, fromMs, toMs)
    const errors: string[] = []
    const rangeFromIso = new Date(fromMs).toISOString()
    const rangeToIso = new Date(toMs).toISOString()

    const { error: delErr } = await this.supabase
      .from('backtest_channel_signals')
      .delete()
      .eq('user_id', this.userId)
      .eq('channel_id', channelRowId)
      .eq('source', 'telegram_import')
      .gte('signal_at', rangeFromIso)
      .lte('signal_at', rangeToIso)
    if (delErr) errors.push(`clear prior import: ${delErr.message}`)

    type Candidate = {
      raw: string
      signalAt: string
      telegramMessageId: string
    }
    const candidates: Candidate[] = []
    for (const m of collected) {
      const raw = String(m.text ?? m.message ?? '').trim()
      if (!raw) continue
      const isReply = !!(m as MessageLike & { replyTo?: unknown }).replyTo
      if (!looksLikeTradingSignal(raw, isReply)) continue
      const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
      candidates.push({
        raw,
        signalAt: epoch > 0 ? new Date(epoch * 1000).toISOString() : new Date().toISOString(),
        telegramMessageId: String(m.id),
      })
    }

    let imported = 0
    const parseConcurrency = Math.max(1, Math.min(8, Number(process.env.BACKTEST_PARSE_CONCURRENCY ?? 4)))
    const parseDelayMs = Math.max(0, Number(process.env.BACKTEST_PARSE_DELAY_MS ?? 0))
    const runId = opts?.runId

    const reportSyncProgress = async (parsed: number, total: number) => {
      if (!runId) return
      const pct = total > 0 ? 2 + Math.floor((parsed / total) * 12) : 2
      await this.supabase.from('backtest_runs').update({
        progress_pct: pct,
        progress_message: `Syncing Telegram: parsing ${parsed}/${total} candidate message(s)…`,
        updated_at: new Date().toISOString(),
      }).eq('id', runId).eq('user_id', this.userId)
    }

    await reportSyncProgress(0, candidates.length)

    let parsedCount = 0
    await this.mapWithConcurrency(candidates, parseConcurrency, async (c) => {
      try {
        const parsed = await this.parseSignalForBacktest(channelRowId, c.raw)
        if (!parsed) return
        const tradeable = tradeableFromParsed(parsed)
        if (!tradeable) return

        const { error: upsertErr } = await this.supabase.rpc('upsert_backtest_channel_signal', {
          p_user_id: this.userId,
          p_channel_id: channelRowId,
          p_signal_id: null,
          p_telegram_message_id: c.telegramMessageId,
          p_source: 'telegram_import',
          p_direction: tradeable.direction,
          p_symbol: tradeable.symbol,
          p_entry_price: tradeable.entry_price,
          p_sl: tradeable.sl,
          p_tp_levels: tradeable.tp_levels,
          p_lot_size: tradeable.lot_size,
          p_raw_message: c.raw,
          p_parsed_data: parsed,
          p_signal_at: c.signalAt,
        })
        if (upsertErr) {
          errors.push(upsertErr.message)
          return
        }
        imported++
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e))
      } finally {
        parsedCount++
        if (parsedCount % 3 === 0 || parsedCount === candidates.length) {
          await reportSyncProgress(parsedCount, candidates.length)
        }
        if (parseDelayMs > 0) {
          await new Promise(r => setTimeout(r, parseDelayMs))
        }
      }
    })

    if (collected.length === 0) {
      errors.push('0 messages from Telegram — check session and channel access')
    } else if (candidates.length === 0) {
      errors.push('No messages looked like trade signals in this range')
    } else if (imported === 0 && errors.length === 0) {
      errors.push('No tradeable signals — messages need buy/sell, valid symbol, and SL or TP')
    }

    return {
      messages_scanned: collected.length,
      candidates: candidates.length,
      imported,
      errors,
    }
  }

  private async mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) return
    let next = 0
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) break
        await fn(items[i])
      }
    })
    await Promise.all(workers)
  }

  private async parseSignalForBacktest(
    channelRowId: string,
    rawMessage: string,
  ): Promise<Record<string, unknown> | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('parse-timeout'), 15_000)
    try {
      const res = await fetch(PARSE_SIGNAL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
          apikey: PARSE_SIGNAL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          parse_only: true,
          channel_id: channelRowId,
          raw_message: rawMessage,
        }),
        signal: controller.signal,
      })
      const data = await res.json().catch(() => ({})) as {
        parsed?: Record<string, unknown>
        error?: string
      }
      if (!res.ok) {
        throw new Error(data.error ?? `parse-signal ${res.status}`)
      }
      if (data.error) throw new Error(data.error)
      return data.parsed ?? null
    } finally {
      clearTimeout(timeout)
    }
  }

  // ── live message handling ─────────────────────────────────────────────

  private async handleMessage(event: NewMessageEvent) {
    this.lastEventAt = Date.now()
    this.lastLiveMessageAt = Date.now()
    incMetric('telegram_live_events')

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

    await this.logSignal(
      channelRow,
      {
        id: message.id,
        text: message.text ?? message.message,
        replyTo: message.replyTo,
        date: (message as MessageLike & { date?: number | Date | string }).date,
      },
      { source: 'live' },
    )
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
  private async waitForCatchUpParseSlot(): Promise<void> {
    const max = catchUpParseConcurrency()
    while (this.catchUpParseActive >= max) {
      await new Promise(r => setTimeout(r, 50))
    }
    this.catchUpParseActive++
  }

  private releaseCatchUpParseSlot(): void {
    this.catchUpParseActive = Math.max(0, this.catchUpParseActive - 1)
  }

  private async deferCatchUpWhileLiveBusy(): Promise<void> {
    const pauseMs = livePriorityPauseMs()
    if (pauseMs <= 0) return
    while (Date.now() - this.lastLiveMessageAt < pauseMs) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  private async logSignal(
    channelRow: ChannelRow,
    message: MessageLike & { date?: number | Date | string },
    opts?: { source?: 'live' | 'catchup' },
  ): Promise<boolean> {
    const isCatchUp = opts?.source === 'catchup'
    if (isCatchUp) {
      await this.deferCatchUpWhileLiveBusy()
      await this.waitForCatchUpParseSlot()
    } else {
      incMetric('telegram_live_log_signal')
    }

    try {
      return await this.logSignalInner(channelRow, message, opts)
    } finally {
      if (isCatchUp) this.releaseCatchUpParseSlot()
    }
  }

  private async logSignalInner(
    channelRow: ChannelRow,
    message: MessageLike & { date?: number | Date | string },
    opts?: { source?: 'live' | 'catchup' },
  ): Promise<boolean> {
    const messageId = String(message.id)
    const rawMessage = (message.text ?? message.message ?? '') as string
    const isReply = !!message.replyTo
    const messageEpochSec = this.messageEpochSec(message)

    if (opts?.source === 'catchup' && messageEpochSec > 0) {
      const ageMs = Date.now() - messageEpochSec * 1000
      if (ageMs > catchUpMaxAgeMs()) {
        await this.bumpLastSeen(channelRow.id, messageId)
        console.log(
          `[userListener] catch-up skipped stale message user=${this.userId} channelRow=${channelRow.id}`
          + ` messageId=${messageId} ageMin=${Math.round(ageMs / 60_000)}`,
        )
        return false
      }
    }
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

    const { count: dupCount } = await this.supabase
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', this.userId)
      .eq('telegram_message_id', messageId)
    if ((dupCount ?? 0) > 0) {
      console.log(
        `[userListener] duplicate message ignored user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`,
      )
      return false
    }

    const signalId = randomUUID()
    const tListenerReceived = Date.now()
    const pipelineTs: PipelineTimestamps = {
      t_telegram_event: messageEpochSec > 0 ? messageEpochSec * 1000 : undefined,
      t_listener_received: tListenerReceived,
    }

    let parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    try {
      if (listenerInlineParseEnabled()) {
        const { keywords, lexicon } = await getChannelParseContext(this.supabase, channelRow.id)
        parseResult = parseChannelMessageSync(rawMessage, keywords, lexicon)
      } else if (PARSE_SIGNAL_URL) {
        parseResult = await this.parseViaEdgeFunction(signalId, rawMessage, channelRow.id)
      } else {
        parseResult = await parseRawChannelMessage(this.supabase, channelRow.id, rawMessage)
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[userListener] parse failed user=${this.userId} signalId=${signalId}:`, errMsg)
      void this.persistSignalBackground({
        signalId,
        channelRow,
        rawMessage,
        messageId,
        parentSignalId,
        replyToMessageId,
        isReply,
        parseResult: {
          parsed: {
            action: 'ignore',
            symbol: null,
            entry_price: null,
            entry_zone_low: null,
            entry_zone_high: null,
            sl: null,
            tp: [],
            lot_size: null,
            confidence: 0,
            raw_instruction: rawMessage,
            open_tp: false,
          },
          status: 'error',
          skip_reason: errMsg,
        },
      })
      return false
    }
    pipelineTs.t_parse_done = Date.now()

    void this.persistSignalBackground({
      signalId,
      channelRow,
      rawMessage,
      messageId,
      parentSignalId,
      replyToMessageId,
      isReply,
      parseResult,
    })

    if (parseResult.status !== 'parsed') {
      return true
    }

    pipelineTs.t_dispatch_sent = Date.now()
    const dispatchRow: SignalRow = {
      id: signalId,
      user_id: this.userId,
      channel_id: channelRow.id,
      parsed_data: parseResult.parsed as SignalRow['parsed_data'],
      status: parseResult.status,
      parent_signal_id: parentSignalId,
      is_modification: isReply,
      telegram_message_id: messageId,
      reply_to_message_id: replyToMessageId,
      created_at: new Date().toISOString(),
      pipeline_ts: pipelineTs,
    }
    console.log(
      `[userListener] dispatch signal user=${this.userId} signalId=${signalId} channelRow=${channelRow.id} messageId=${messageId}`,
    )

    const dispatchedInProcess = this.onSignalParsed ? this.onSignalParsed(dispatchRow) === true : false
    const shouldPush = workerConfig.runsListener && (!workerConfig.runsTrade || !dispatchedInProcess)
    void (async () => {
      const { error } = await this.supabase.from('trade_execution_logs').insert({
        user_id: this.userId,
        signal_id: signalId,
        action: 'dispatch_route_decision',
        status: 'success',
        request_payload: {
          run_id: 'latency-v2',
          hypothesis_id: 'H4',
          dispatched_in_process: dispatchedInProcess,
          should_push: shouldPush,
          runs_trade: workerConfig.runsTrade,
          runs_listener: workerConfig.runsListener,
        },
      })
      if (error) {
        /* best-effort */
      }
    })()
    if (shouldPush) {
      pushParsedSignalToTradeWorker(dispatchRow)
    }

    return true
  }

  /** Edge parse fallback when LISTENER_INLINE_PARSE=false (UI preview path unchanged on edge). */
  private async parseViaEdgeFunction(
    signalId: string,
    rawMessage: string,
    channelRowId: string,
  ): Promise<Awaited<ReturnType<typeof parseChannelMessageSync>>> {
    if (!PARSE_SIGNAL_URL) {
      return parseRawChannelMessage(this.supabase, channelRowId, rawMessage)
    }
    const parseTimeoutMs = Math.max(
      2_000,
      Math.min(15_000, Number(process.env.PARSE_SIGNAL_TIMEOUT_MS ?? 6_000)),
    )
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('parse-timeout'), parseTimeoutMs)
    try {
      await this.supabase.from('signals').upsert({
        id: signalId,
        user_id: this.userId,
        channel_id: channelRowId,
        raw_message: rawMessage,
        raw_image_url: null,
        status: 'pending',
      })
      const res = await fetch(PARSE_SIGNAL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${PARSE_SIGNAL_AUTH_KEY}`,
          apikey: PARSE_SIGNAL_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ signal_id: signalId }),
        signal: controller.signal,
      })
      const body = await res.json().catch(() => ({})) as {
        parsed?: Record<string, unknown>
        status?: string
        skip_reason?: string | null
        error?: string
      }
      if (!res.ok) {
        throw new Error(body.error ?? `parse-signal returned ${res.status}`)
      }
      return {
        parsed: (body.parsed ?? {}) as unknown as Awaited<ReturnType<typeof parseChannelMessageSync>>['parsed'],
        status: String(body.status ?? 'parsed'),
        skip_reason: body.skip_reason ?? null,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  private persistSignalBackground(args: {
    signalId: string
    channelRow: ChannelRow
    rawMessage: string
    messageId: string
    parentSignalId: string | null
    replyToMessageId: string | null
    isReply: boolean
    parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
  }): void {
    const {
      signalId,
      channelRow,
      rawMessage,
      messageId,
      parentSignalId,
      replyToMessageId,
      isReply,
      parseResult,
    } = args
    void (async () => {
      const { error: insertErr } = await this.supabase.from('signals').upsert(
        {
          id: signalId,
          user_id: this.userId,
          channel_id: channelRow.id,
          raw_message: rawMessage,
          raw_image_url: null,
          status: parseResult.status,
          parsed_data: parseResult.parsed,
          skip_reason: parseResult.skip_reason,
          telegram_message_id: messageId,
          is_modification: isReply,
          parent_signal_id: parentSignalId,
          reply_to_message_id: replyToMessageId,
        },
        { onConflict: 'user_id,telegram_message_id', ignoreDuplicates: true },
      )
      if (insertErr) {
        console.error(`[userListener] signal upsert failed signalId=${signalId}:`, insertErr.message)
        return
      }
      await this.bumpLastSeen(channelRow.id, messageId)
      let resolvedParent = parentSignalId
      if (replyToMessageId && !resolvedParent) {
        resolvedParent = await this.resolveParentSignalIdForReply(channelRow.id, replyToMessageId)
        if (resolvedParent) {
          await this.supabase
            .from('signals')
            .update({ parent_signal_id: resolvedParent })
            .eq('id', signalId)
        }
      }
      await this.relinkReplyOrphansAfterParentInsert(channelRow.id, messageId, signalId)
    })().catch(err => {
      console.error(`[userListener] persistSignalBackground failed signalId=${signalId}:`, err)
    })
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

  /** Non-blocking so live NewMessage handling is not delayed behind history replay. */
  private scheduleCatchUpOnStart() {
    if (!catchUpOnStartEnabled()) {
      console.log(`[userListener] catch-up on start disabled user=${this.userId}`)
      return
    }
    console.log(
      `[userListener] catch-up scheduled (background) user=${this.userId} maxAgeMin=${Math.round(catchUpMaxAgeMs() / 60_000)}`,
    )
    void this.runCatchUp().catch(err =>
      console.error(`[userListener] catch-up failed for ${this.userId}:`, err),
    )
  }

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

  private async resolveChannelPeer(row: ChannelRow): Promise<unknown> {
    const key = row.channel_username?.replace(/^@/, '') || row.channel_id
    try {
      return await this.client.getInputEntity(key)
    } catch {
      // Entity cache miss — warm from dialogs (common right after connect).
    }

    const wantUser = (row.channel_username ?? '').replace(/^@/, '').toLowerCase()
    const idVariants = new Set(toChannelIdVariants(row.channel_id))

    try {
      const dialogs = await this.fetchAllDialogs()
      for (const d of dialogs) {
        if (!d.isChannel && !d.isGroup) continue
        const entity = d.entity
        if (!entity) continue
        const id = String(d.id ?? '')
        const username = String((entity as { username?: string }).username ?? '').toLowerCase()
        const matches =
          (wantUser && username === wantUser)
          || idVariants.has(id)
          || [...idVariants].some(v => id === v || id.endsWith(v))
        if (matches) {
          return await this.client.getInputEntity(entity)
        }
      }
      return await this.client.getInputEntity(key)
    } catch (err) {
      rethrowIfSessionInvalid(err)
      throw new Error('Failed to resolve Telegram channel entity')
    }
  }

  private async catchUpChannel(row: ChannelRow): Promise<void> {
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch (err) {
      console.warn(`[userListener] resolveChannelPeer miss for channel ${row.id}; skipping catch-up this round`, err)
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
    const toProcess = collected.filter(m => {
      const mid = Number(m.id)
      return Number.isFinite(mid) && mid > minId
    })

    incMetric('catchup_messages_queued', toProcess.length)

    await this.mapWithConcurrency(toProcess, catchUpParseConcurrency(), async m => {
      await this.logSignal(row, m, { source: 'catchup' })
    })

    console.log(
      `[userListener] catch-up channel done user=${this.userId} channelRow=${row.id} processed=${toProcess.length}`,
    )
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

  /** All non-empty messages in range (no trading heuristic) — used for backtest import only. */
  private async fetchMessagesBetweenForBacktest(
    row: ChannelRow,
    fromMs: number,
    toMs: number,
  ): Promise<MessageLike[]> {
    return this.fetchMessagesBetween(row, fromMs, toMs, { forBacktest: true })
  }

  private async fetchMessagesBetween(
    row: ChannelRow,
    fromMs: number,
    toMs: number,
    opts?: { forBacktest?: boolean },
  ): Promise<MessageLike[]> {
    const fromSec = Math.floor(fromMs / 1000)
    const toSec = Math.floor(toMs / 1000)

    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
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
        const fetchAllForBacktest = process.env.BACKTEST_FETCH_ALL_MESSAGES === 'true'
        if (!opts?.forBacktest) {
          if (!looksLikeTradingSignal(raw, isReply)) continue
        } else if (!fetchAllForBacktest) {
          if (!looksLikeTradingSignal(raw, isReply)) continue
        }
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
      peer = await this.resolveChannelPeer(row)
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
    this.clearDialogsCache()
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
      incMetric('auth_key_duplicated')
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
