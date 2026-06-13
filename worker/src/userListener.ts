import { randomUUID } from 'node:crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { utils } from 'telegram'
import { NewMessage } from 'telegram/events'
import type { NewMessageEvent } from 'telegram/events/NewMessage'
import { EditedMessage } from 'telegram/events/EditedMessage'
import type { EditedMessageEvent } from 'telegram/events/EditedMessage'
import { Api } from 'telegram/tl'
import { buildClient, isAuthKeyUnregistered, rethrowIfSessionInvalid, TelegramSessionInvalidError, tgInvoke } from './telegramClient'
import { tradeableFromParsed } from './backtestSignal'
import { hasTradableInstrumentInText } from './tradableSymbol'
import type { SignalRow } from './tradeExecutor'
import { enqueueParsedSignal } from './queue/signalQueuePublisher'
import { signalQueueConfig } from './queue/signalQueueConfig'
import { pushParsedSignalToTradeWorker, pushParsedSignalToTradeWorkerAwait } from './tradeSignalPush'
import { persistListenerEvent } from './listenerEvents'
import { getChannelParseContext, invalidateChannelParseCache } from './channelKeywordsCache'
import { parseChannelMessageSync, parseRawChannelMessage, looksLikeChannelManagementUpdate, looksLikeExplicitFullCloseCommand } from './parseSignal'
import type { PipelineTimestamps } from './pipelineTimestamps'
import { incMetric } from './workerMetrics'
import { workerConfig } from './workerConfig'
import { applyCopierPauseProfileUpdate, loadCachedUserCopierPaused } from './copierPause'
import {
  MESSAGE_REVISION_DISPATCH_SOURCE,
  buildRevisionDispatchRow,
  entryDispatchLooksSettleable,
  loadSignalByTelegramMessage,
  storedMessageDiffersFromTelegram,
  updateSignalAfterRevision,
} from './signalRevision'
import { aiParseModification, aiResultToParseResult } from './aiParseModification'
import {
  RECONCILE_POLL_HOOK_MAX_SIGNALS,
  RECONCILE_POLL_HOOK_WINDOW_MS,
  RECONCILE_SWEEP_INTERVAL_MS,
  chunkTelegramMessageIds,
  findSignalsNeedingReconcile,
  groupSignalsByChannel,
  loadSignalsForReconcile,
  markSignalsReconciled,
  snapshotsFromTelegramMessages,
  telegramEditDateSec,
  telegramMessageText,
} from './signalTelegramReconcile'
import { evaluateParsedSignalExecutionEligibility } from './signalExecutionEligibility'
import { looksLikeCasualNonTradeMessage } from './signalCommentaryGuard'

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
const SAFETY_POLL_INTERVAL_MS = 30_000
/**
 * Fast poll for channels Telegram is NOT pushing live updates for (last_live_at
 * stale/null). Telegram silently stops pushing updates for broadcast channels it
 * considers inactive on a session; without this, those signals are only picked
 * up by the 30s safety poll (avg ~15s extra latency).
 */
const FAST_POLL_INTERVAL_MS = Math.max(
  1_000, Math.min(15_000, Number(process.env.TELEGRAM_FAST_POLL_MS ?? 3_000)),
)
/** A channel counts as live-dead when no live push has been seen for this long. */
const FAST_POLL_LIVE_STALE_MS = Math.max(
  60_000, Number(process.env.TELEGRAM_FAST_POLL_LIVE_STALE_MS ?? 10 * 60_000),
)
const SESSION_PERSIST_INTERVAL_MS = 30 * 60_000
const CATCHUP_BACKPRESSURE_MS = 250
const CATCHUP_PER_CHANNEL_CAP = 200
const BACKFILL_PER_CHANNEL_CAP = 1000
const REPLY_CHAIN_SWEEP_MS = 60_000
/** Re-fetch teaser entries (e.g. "Gold buy now") after channel adds SL/TP via edit. */
const ENTRY_MESSAGE_SETTLE_MS = Math.max(
  3_000,
  Math.min(30_000, Number(process.env.ENTRY_MESSAGE_SETTLE_MS ?? 10_000)),
)

function entryMessageSettleDelaysMs(): number[] {
  const raw = String(process.env.ENTRY_MESSAGE_SETTLE_DELAYS_MS ?? '').trim()
  if (raw) {
    const parsed = raw
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n) && n >= 3_000)
      .map(n => Math.min(30_000, Math.floor(n)))
    if (parsed.length) return [...new Set(parsed)]
  }
  const second = Math.min(30_000, ENTRY_MESSAGE_SETTLE_MS * 3)
  return second > ENTRY_MESSAGE_SETTLE_MS
    ? [ENTRY_MESSAGE_SETTLE_MS, second]
    : [ENTRY_MESSAGE_SETTLE_MS]
}
const ENTITY_WARMUP_INTERVAL_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.TELEGRAM_ENTITY_WARMUP_INTERVAL_MS ?? 10 * 60_000)),
)

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
  last_successful_poll_at: number
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
  last_seen_at?: string | null
  last_live_at?: string | null
}

type Handler = (event: NewMessageEvent) => void
type EditHandler = (event: EditedMessageEvent) => void

export type SignalReconcileStats = {
  checked: number
  mismatches: number
  revised: number
  errors: number
}

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

  if (looksLikeCasualNonTradeMessage(text)) return false

  const hasInstrument = hasTradableInstrumentInText(text)

  const hasDirectionOrAction =
    /\b(buy|sell|long|short|tp|take profit|sl|stop loss|breakeven|be)\b/.test(normalized)
    || looksLikeExplicitFullCloseCommand(text)

  const hasPriceContext =
    /\b\d{1,5}(?:\.\d{1,5})\b/.test(normalized) ||
    /\b(entry|zone|between|above|below|now)\b/.test(normalized)

  const hasTradeStructure =
    /\b(tp\s*\d*|sl|entry|signal|setup)\b/.test(normalized)

  // Reply updates like "move SL to ..." are often signal modifications.
  if (isReply && /\b(move|set|update|adjust|tp|sl|breakeven|be|close)\b/.test(normalized)) {
    return true
  }

  // Breakeven / partial-close / TP-hit updates often lack symbol or explicit SL/TP labels.
  if (looksLikeChannelManagementUpdate(text)) return true

  // Require stronger evidence than a single keyword to reduce false positives.
  const score = Number(hasDirectionOrAction) + Number(hasInstrument) + Number(hasPriceContext) + Number(hasTradeStructure)
  return score >= 2
}

function normalizeChannelUsername(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^@/, '').toLowerCase()
}

function isValidTelegramUsername(raw: string | null | undefined): boolean {
  const value = normalizeChannelUsername(raw)
  if (!value) return false
  return /^[a-z0-9_]{5,32}$/i.test(value)
}

function isNumericTelegramChatId(raw: string | null | undefined): boolean {
  return /^-?\d+$/.test(String(raw ?? '').trim())
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
  private currentEditHandler: EditHandler | null = null
  private currentEditEventBuilder: EditedMessage | null = null
  private startedAt = 0
  /** Set when start() reuses the auth-time client (no second connect). */
  private startedWithLiveClient = false
  private dialogsCache: ChannelInfo[] | null = null
  private dialogsCacheAt = 0
  private safetyPollTimer: NodeJS.Timeout | null = null
  private fastPollTimer: NodeJS.Timeout | null = null
  private fastPollRows: ChannelRow[] = []
  private fastPollRowsAt = 0
  private fastPollInFlight = false
  /** In-memory live-push freshness per channel row (DB last_live_at can lag). */
  private lastLiveByRow = new Map<string, number>()
  private watchdogTimer: NodeJS.Timeout | null = null
  private sessionPersistTimer: NodeJS.Timeout | null = null
  private replyChainSweepTimer: NodeJS.Timeout | null = null
  private signalReconcileSweepTimer: NodeJS.Timeout | null = null
  private signalReconcileInFlight = false
  private entityWarmupTimer: NodeJS.Timeout | null = null
  private catchUpInFlight = false
  private catchUpParseActive = 0
  private lastLiveMessageAt = 0
  private isConnected = false
  private lastEventAt = 0
  private lastSuccessfulPollAt = 0
  private lastReconnectAt = 0
  private consecutiveProbeFailures = 0
  private lastSavedSession: string
  private onSignalParsed: ((row: SignalRow) => boolean) | null = null
  /** Recent live message ids — avoids a Supabase round-trip on hot-path dedup. */
  private liveMessageDedup = new Map<string, number>()
  private userProfilesCopierPauseChannel: ReturnType<SupabaseClient['channel']> | null = null

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

    // Warm gramjs entity cache so NewMessage events fire for all channels.
    await this.warmEntityCache()
    await this.refreshChannelSubscription()
    this.scheduleCatchUpOnStart()

    this.startWatchdog()
    this.startSafetyPoll()
    this.startFastPoll()
    void this.pollMonitoredChannelsForMessages().catch(err =>
      console.warn(`[userListener] initial channel poll failed for ${this.userId}:`, err),
    )
    this.startSessionPersist()
    this.startReplyChainSweep()
    this.startSignalReconcileSweep()
    this.startEntityWarmup()
    this.subscribeCopierPauseState()
  }

  async stop() {
    try {
      if (this.userProfilesCopierPauseChannel) {
        await this.supabase.removeChannel(this.userProfilesCopierPauseChannel)
        this.userProfilesCopierPauseChannel = null
      }
      this.stopTimer('watchdogTimer')
      this.stopTimer('safetyPollTimer')
      this.stopTimer('fastPollTimer')
      this.stopTimer('sessionPersistTimer')
      this.stopTimer('replyChainSweepTimer')
      this.stopTimer('signalReconcileSweepTimer')
      this.stopTimer('entityWarmupTimer')
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

  private stopTimer(field: 'watchdogTimer' | 'safetyPollTimer' | 'fastPollTimer' | 'sessionPersistTimer' | 'replyChainSweepTimer' | 'signalReconcileSweepTimer' | 'entityWarmupTimer') {
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
      last_successful_poll_at: this.lastSuccessfulPollAt,
      last_reconnect_at: this.lastReconnectAt,
      monitored_channels: this.monitoredChannels.size,
      consecutive_probe_failures: this.consecutiveProbeFailures,
    }
  }

  /** Used by session manager to skip lease renew when listener is stale. */
  isListenerHealthy(staleMs: number): boolean {
    const now = Date.now()
    const lastActivity = Math.max(this.lastEventAt, this.lastSuccessfulPollAt)
    return this.isConnected && (lastActivity === 0 || now - lastActivity < staleMs)
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

    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    const added = [...this.monitoredChannels].filter(c => !previous.has(c))

    const lookup = new Map<string, ChannelRow>()
    for (const row of (rows ?? []) as ChannelRow[]) {
      if (row.channel_id && isNumericTelegramChatId(String(row.channel_id))) {
        for (const v of toChannelIdVariants(String(row.channel_id))) {
          lookup.set(v, row)
        }
      }
      if (isValidTelegramUsername(row.channel_username)) {
        lookup.set(normalizeChannelUsername(row.channel_username), row)
      }
    }
    for (const key of added) {
      const row = lookup.get(key)
      if (row) {
        await this.warmChannelEntity(row).catch(err =>
          console.warn(`[userListener] entity warmup failed channel=${row.id}:`, err),
        )
        await this.catchUpChannel(row).catch(err =>
          console.error(`[userListener] catchUp (added) failed for ${row.id}:`, err),
        )
      }
    }

    // Keep entity cache hot for every active channel (not only newly added keys).
    for (const row of (rows ?? []) as ChannelRow[]) {
      await this.warmChannelEntity(row).catch(() => { /* logged inside */ })
      await this.ensureJoinedPublicChannel(row).catch(err =>
        console.warn(`[userListener] join channel failed ${row.id}:`, err),
      )
    }

    // Poll channels with no recent activity (missed live events or stale entity).
    const pollStaleMs = 5 * 60_000
    const now = Date.now()
    for (const row of (rows ?? []) as ChannelRow[]) {
      const lastLive = row.last_live_at ? new Date(row.last_live_at).getTime() : 0
      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0
      const lastActivity = Math.max(lastLive, lastSeen)
      if (lastActivity > 0 && now - lastActivity < pollStaleMs) continue
      await this.pollChannelNewMessages(row).catch(err =>
        console.warn(`[userListener] poll (stale) failed for ${row.id}:`, err),
      )
    }

    // Never heard from Telegram at all.
    for (const row of (rows ?? []) as ChannelRow[]) {
      if (row.last_seen_at) continue
      await this.pollChannelNewMessages(row).catch(err =>
        console.warn(`[userListener] poll (never-heard) failed for ${row.id}:`, err),
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
    const editHandler: EditHandler = (event: EditedMessageEvent) => {
      this.handleEditedMessage(event).catch(err => {
        console.error(`[userListener] handleEditedMessage error for ${this.userId}:`, err)
      })
    }
    const builder = new NewMessage({})
    const editBuilder = new EditedMessage({})
    this.client.addEventHandler(handler, builder)
    this.client.addEventHandler(editHandler, editBuilder)
    this.currentHandler = handler
    this.currentEventBuilder = builder
    this.currentEditHandler = editHandler
    this.currentEditEventBuilder = editBuilder
  }

  private removeCurrentHandler() {
    if (this.currentHandler && this.currentEventBuilder) {
      try {
        this.client.removeEventHandler(this.currentHandler, this.currentEventBuilder)
      } catch {
        // ignore
      }
    }
    if (this.currentEditHandler && this.currentEditEventBuilder) {
      try {
        this.client.removeEventHandler(this.currentEditHandler, this.currentEditEventBuilder)
      } catch {
        // ignore
      }
    }
    this.currentHandler = null
    this.currentEventBuilder = null
    this.currentEditHandler = null
    this.currentEditEventBuilder = null
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
      if (ch.channel_id && isNumericTelegramChatId(String(ch.channel_id))) {
        for (const v of toChannelIdVariants(String(ch.channel_id))) next.add(v)
      }
      if (isValidTelegramUsername(ch.channel_username)) {
        next.add(normalizeChannelUsername(ch.channel_username))
      }
    }
    return next
  }

  private async resolveChannelRowForChat(
    chatIdVariants: string[],
    chatUsername: string,
  ): Promise<ChannelRow | null> {
    const { data: rows, error } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('is_active', true)
    if (error || !rows?.length) return null

    const variantSet = new Set(chatIdVariants)
    for (const row of rows as ChannelRow[]) {
      const storedId = String(row.channel_id ?? '').trim()
      if (storedId && isNumericTelegramChatId(storedId)) {
        if (toChannelIdVariants(storedId).some(v => variantSet.has(v))) {
          return row
        }
      }
    }

    if (chatUsername) {
      const wanted = normalizeChannelUsername(chatUsername)
      for (const row of rows as ChannelRow[]) {
        const stored = normalizeChannelUsername(row.channel_username)
        if (stored && stored === wanted) return row
      }
    }

    return null
  }

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
    const channelRow = await this.resolveChannelRowForChat(chatIdVariants, chatUsername)

    if (!channelRow) {
      const { data: configured } = await this.supabase
        .from('telegram_channels')
        .select('display_name, channel_id, channel_username')
        .eq('user_id', this.userId)
        .eq('is_active', true)
      const configuredSummary = (configured ?? [])
        .map(c => `${c.display_name ?? '?'} id=${c.channel_id ?? '-'} @${c.channel_username ?? '-'}`)
        .join('; ')
      console.warn(
        `[userListener] monitored message could not map to telegram_channels row user=${this.userId}`
        + ` chatId=${chatId} username=${chatUsername || '-'} variants=${chatIdVariants.join(',')}`
        + ` configured=[${configuredSummary}]`,
      )
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'unmapped_channel',
        telegramMessageId: String(message.id),
        detail: {
          chat_id: chatId,
          chat_username: chatUsername || null,
          variants: chatIdVariants,
          configured: configuredSummary,
        },
      })
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
    void this.bumpLastLive(channelRow.id)
  }

  private async handleEditedMessage(event: EditedMessageEvent) {
    this.lastEventAt = Date.now()
    incMetric('telegram_edit_events')

    const message = event.message
    if (!message) return

    const { chatId, chatIdVariants, chatUsername } = await this.resolveChatIdentity(event)
    if (!chatId && !chatUsername) return

    const isMonitored =
      chatIdVariants.some(v => this.monitoredChannels.has(v)) ||
      (!!chatUsername && this.monitoredChannels.has(chatUsername))
    if (!isMonitored) return

    const channelRow = await this.resolveChannelRowForChat(chatIdVariants, chatUsername)
    if (!channelRow) return

    const rawMessage = (message.text ?? message.message ?? '') as string
    if (!rawMessage.trim()) return

    await this.tryApplyMessageRevision({
      channelRow,
      messageId: String(message.id),
      rawMessage,
      source: 'live_edit',
      telegramEditDateSeen: telegramEditDateSec(message),
    })
    void this.bumpLastLive(channelRow.id)
  }

  private async tryApplyMessageRevision(args: {
    channelRow: ChannelRow
    messageId: string
    rawMessage: string
    source: string
    telegramEditDateSeen?: number | null
  }  ): Promise<boolean> {
    const { channelRow, messageId, rawMessage, source } = args
    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) return false

    const existing = await loadSignalByTelegramMessage(this.supabase, {
      userId: this.userId,
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
    })
    if (!existing) return false
    if (!storedMessageDiffersFromTelegram(existing.raw_message, rawMessage)) return false

    let aiResult: Awaited<ReturnType<typeof aiParseModification>>
    try {
      aiResult = await aiParseModification(this.supabase, {
        userId: this.userId,
        channelRowId: channelRow.id,
        rawMessage,
        revision: {
          prior_raw_message: existing.raw_message,
          prior_parsed_data: (existing.parsed_data ?? null) as Record<string, unknown> | null,
        },
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(
        `[userListener] message revision AI parse failed user=${this.userId} signalId=${existing.id}:`,
        errMsg,
      )
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_modification_failed',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: { error: errMsg.slice(0, 300), signal_id: existing.id, source, revision: true },
      })
      return false
    }

    const parseResult = aiResultToParseResult(aiResult)
    if (parseResult.status !== 'parsed') {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_modification_skipped',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: existing.id,
          source,
          revision: true,
          skip_reason: parseResult.skip_reason,
          intent: aiResult.intent,
        },
      })
      return false
    }

    const updated = await updateSignalAfterRevision(this.supabase, {
      signalId: existing.id,
      rawMessage,
      parseResult,
      telegramEditDateSeen: args.telegramEditDateSeen,
    })
    if (!updated) {
      console.error(
        `[userListener] message revision update failed user=${this.userId} signalId=${existing.id}`,
      )
      return false
    }

    const tRevision = Date.now()
    const dispatchRow = buildRevisionDispatchRow(existing, parseResult, {
      t_ai_parse_done: tRevision,
      t_dispatch_sent: tRevision,
    })
    dispatchRow.dispatch_source = MESSAGE_REVISION_DISPATCH_SOURCE
    if (existing.parsed_data?.action) {
      dispatchRow.revision_prior_action = String(existing.parsed_data.action)
    }

    console.log(
      `[userListener] message revision dispatch user=${this.userId} signalId=${existing.id}`
      + ` channelRow=${channelRow.id} messageId=${messageId} source=${source}`,
    )

    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'message_revision_applied',
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
      detail: {
        signal_id: existing.id,
        source,
        intent: aiResult.intent,
        ai_source: aiResult.source,
        sl: parseResult.parsed.sl ?? null,
        tp: parseResult.parsed.tp ?? [],
      },
    })

    await this.dispatchRevisionSignal(dispatchRow)
    return true
  }

  private scheduleEntryMessageSettlePoll(channelRow: ChannelRow, messageId: string) {
    for (const delayMs of entryMessageSettleDelaysMs()) {
      setTimeout(() => {
        this.pollEntryMessageRevision(channelRow, messageId, delayMs).catch(err => {
          console.error(
            `[userListener] entry settle poll failed user=${this.userId} messageId=${messageId}:`,
            err instanceof Error ? err.message : err,
          )
        })
      }, delayMs)
    }
  }

  private async pollEntryMessageRevision(
    channelRow: ChannelRow,
    messageId: string,
    delayMs?: number,
  ) {
    const existing = await loadSignalByTelegramMessage(this.supabase, {
      userId: this.userId,
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
    })
    if (!existing) return

    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(channelRow)
    } catch {
      return
    }

    const numericId = Number(messageId)
    if (!Number.isFinite(numericId) || numericId <= 0) return

    const batch = (await this.client.getMessages(peer as never, {
      ids: [numericId],
    })) as unknown[]
    const message = batch?.[0]
    const rawMessage = telegramMessageText(message)
    if (!rawMessage.trim()) return
    if (!storedMessageDiffersFromTelegram(existing.raw_message, rawMessage)) return

    void persistListenerEvent(this.supabase, {
      userId: this.userId,
      eventType: 'entry_settle_poll_mismatch',
      channelRowId: channelRow.id,
      telegramMessageId: messageId,
      detail: {
        signal_id: existing.id,
        delay_ms: delayMs ?? null,
        stored_len: existing.raw_message.length,
        fetched_len: rawMessage.length,
      },
    })

    const revised = await this.tryApplyMessageRevision({
      channelRow,
      messageId,
      rawMessage,
      source: 'entry_settle_poll',
      telegramEditDateSeen: telegramEditDateSec(message),
    })
    if (revised) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'entry_settle_poll_applied',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: { signal_id: existing.id, delay_ms: delayMs ?? null },
      })
    }
  }

  private async dispatchRevisionSignal(dispatchRow: SignalRow): Promise<void> {
    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) return

    const dispatchedInProcess = this.onSignalParsed
      ? this.onSignalParsed(dispatchRow) === true
      : false
    const shouldPush = workerConfig.runsListener && (!workerConfig.runsTrade || !dispatchedInProcess)

    if (shouldPush) {
      const pushed = await pushParsedSignalToTradeWorkerAwait(
        {
          ...dispatchRow,
          dispatch_source: MESSAGE_REVISION_DISPATCH_SOURCE,
        },
        { source: MESSAGE_REVISION_DISPATCH_SOURCE },
      )
      if (!pushed) incMetric('dispatch_push_exhausted')
    }
  }

  private isModificationClassMessage(rawMessage: string, isReply: boolean): boolean {
    return isReply || looksLikeChannelManagementUpdate(rawMessage)
  }

  private async parseSignalForListener(args: {
    channelRowId: string
    rawMessage: string
    signalId: string
    isReply: boolean
    parentSignalId: string | null
  }): Promise<{
    parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    aiMeta?: { intent: string; source: string }
  }> {
    if (this.isModificationClassMessage(args.rawMessage, args.isReply)) {
      const aiResult = await aiParseModification(this.supabase, {
        userId: this.userId,
        channelRowId: args.channelRowId,
        rawMessage: args.rawMessage,
        isReply: args.isReply,
        parentSignalId: args.parentSignalId,
      })
      return {
        parseResult: aiResultToParseResult(aiResult),
        aiMeta: { intent: aiResult.intent, source: aiResult.source },
      }
    }
    if (listenerInlineParseEnabled()) {
      const { keywords, lexicon } = await getChannelParseContext(this.supabase, args.channelRowId)
      return { parseResult: parseChannelMessageSync(args.rawMessage, keywords, lexicon) }
    }
    if (PARSE_SIGNAL_URL) {
      return {
        parseResult: await this.parseViaEdgeFunction(args.signalId, args.rawMessage, args.channelRowId),
      }
    }
    return {
      parseResult: await parseRawChannelMessage(this.supabase, args.channelRowId, args.rawMessage),
    }
  }

  /**
   * Resolve chat identity for an update without depending solely on
   * getChat(), which can fail transiently when gramjs entity cache is cold.
   */
  private async resolveChatIdentity(event: NewMessageEvent | EditedMessageEvent): Promise<ChatIdentity> {
    const message = event.message
    const fallbackId = event.chatId != null ? String(event.chatId) : ''
    let chatId = fallbackId
    let chatUsername = ''

    if ((!chatId || chatId === 'undefined') && message?.peerId) {
      try {
        chatId = utils.getPeerId(message.peerId, false).toString()
      } catch {
        // keep fallback
      }
    }

    try {
      const chat = await event.message?.getChat()
      if (chat) {
        const chatRaw = chat as unknown as { id?: unknown; username?: string }
        if (chatRaw.id != null) chatId = String(chatRaw.id)
        chatUsername = (chatRaw.username ?? '').toLowerCase()
      }
    } catch {
      // Fallback to event.chatId / peerId if entity lookup fails.
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
   * on signals(user_id, channel_id, telegram_message_id) — a row that already exists
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
    if (await this.skipMessageWhileCopierPaused(channelRow, String(message.id))) return false

    const messageId = String(message.id)
    const rawMessage = (message.text ?? message.message ?? '') as string
    const isReply = !!message.replyTo
    const messageEpochSec = this.messageEpochSec(message)
    // Stamp listener arrival as early as possible so telegram_to_listener_ms
    // reflects only Telegram delivery time (not our dedup/parent lookup DB calls).
    const tListenerReceived = Date.now()

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
      void this.persistNonSignalSkip({
        channelRow,
        rawMessage,
        messageId,
        parentSignalId,
        replyToMessageId,
        isReply,
      })
      return false
    }

    const dedupKey = `${channelRow.id}:${messageId}`

    const { count: dupCount } = await this.supabase
      .from('signals')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', this.userId)
      .eq('channel_id', channelRow.id)
      .eq('telegram_message_id', messageId)
    if ((dupCount ?? 0) > 0) {
      const revised = await this.tryApplyMessageRevision({
        channelRow,
        messageId,
        rawMessage,
        source: opts?.source === 'catchup' ? 'catchup' : 'duplicate_fallback',
      })
      if (revised) return true
      console.log(
        `[userListener] duplicate message ignored user=${this.userId} channelRow=${channelRow.id} messageId=${messageId}`,
      )
      return false
    }

    const dedupAt = this.liveMessageDedup.get(dedupKey)
    if (dedupAt != null && Date.now() - dedupAt < 120_000) {
      return false
    }

    const signalId = randomUUID()
    const pipelineTs: PipelineTimestamps = {
      t_telegram_event: messageEpochSec > 0 ? messageEpochSec * 1000 : undefined,
      t_listener_received: tListenerReceived,
    }

    let parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
    let aiMeta: { intent: string; source: string } | undefined
    try {
      const parsed = await this.parseSignalForListener({
        channelRowId: channelRow.id,
        rawMessage,
        signalId,
        isReply,
        parentSignalId,
      })
      parseResult = parsed.parseResult
      aiMeta = parsed.aiMeta
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
    if (aiMeta) pipelineTs.t_ai_parse_done = pipelineTs.t_parse_done

    if (aiMeta && parseResult.status === 'parsed') {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_modification_parsed',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: signalId,
          intent: aiMeta.intent,
          ai_source: aiMeta.source,
        },
      })
    } else if (aiMeta && parseResult.status !== 'parsed') {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'ai_modification_skipped',
        channelRowId: channelRow.id,
        telegramMessageId: messageId,
        detail: {
          signal_id: signalId,
          intent: aiMeta.intent,
          skip_reason: parseResult.skip_reason,
        },
      })
    }

    const executionEligibility = evaluateParsedSignalExecutionEligibility(parseResult.parsed, rawMessage)
    const effectiveParseResult = (
      parseResult.status === 'parsed' && !executionEligibility.eligible
    )
      ? {
          ...parseResult,
          parsed: {
            ...parseResult.parsed,
            action: 'ignore',
            confidence: 0,
          },
          status: 'skipped',
          skip_reason: executionEligibility.skipReason ?? parseResult.skip_reason,
        }
      : parseResult

    if (effectiveParseResult.status !== 'parsed') {
      void this.persistSignalBackground({
        signalId,
        channelRow,
        rawMessage,
        messageId,
        parentSignalId,
        replyToMessageId,
        isReply,
        parseResult: effectiveParseResult,
      })
      return true
    }

    pipelineTs.t_dispatch_sent = Date.now()
    const dispatchRow: SignalRow = {
      id: signalId,
      user_id: this.userId,
      channel_id: channelRow.id,
      parsed_data: effectiveParseResult.parsed as SignalRow['parsed_data'],
      status: effectiveParseResult.status,
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

    this.liveMessageDedup.set(dedupKey, Date.now())

    const dispatchedInProcess = this.onSignalParsed ? this.onSignalParsed(dispatchRow) === true : false
    this.routeDispatchToTradeWorker(dispatchRow, dispatchedInProcess)

    if (entryDispatchLooksSettleable(effectiveParseResult.parsed)) {
      this.scheduleEntryMessageSettlePoll(channelRow, messageId)
    }

    void this.persistSignalBackground({
      signalId,
      channelRow,
      rawMessage,
      messageId,
      parentSignalId,
      replyToMessageId,
      isReply,
      parseResult: effectiveParseResult,
    })

    return true
  }

  /** Fire-and-forget handoff to trade worker (in-process, queue, or HTTP push). */
  private routeDispatchToTradeWorker(dispatchRow: SignalRow, dispatchedInProcess: boolean): void {
    const shouldPush = workerConfig.runsListener && (!workerConfig.runsTrade || !dispatchedInProcess)
    if (!shouldPush) return

    void enqueueParsedSignal(this.supabase, dispatchRow).then(queueResult => {
      const queueCfg = signalQueueConfig()
      const queueSucceeded = queueResult?.ok === true
      const shouldHttpPush = !queueSucceeded
        && (queueCfg.pushFallbackOnQueueFail || !queueResult || queueResult.skipped)
      if (shouldHttpPush) {
        pushParsedSignalToTradeWorker(dispatchRow)
      }
      void this.supabase.from('trade_execution_logs').insert({
        user_id: this.userId,
        signal_id: dispatchRow.id,
        action: 'dispatch_route_decision',
        status: 'success',
        request_payload: {
          dispatched_in_process: dispatchedInProcess,
          should_push: shouldPush,
          queue_enabled: queueCfg.enabled,
          queue_enqueued: queueSucceeded,
          queue_skipped_reason: queueResult?.skipped ? queueResult.reason : null,
          queue_error: queueResult?.error ?? null,
          http_push_fallback: shouldHttpPush,
          runs_trade: workerConfig.runsTrade,
          runs_listener: workerConfig.runsListener,
          persist_before_dispatch: false,
        },
      })
    })
  }

  /** @deprecated Use persistSignalBackground after dispatch-first handoff. */
  private async persistSignalSync(args: {
    signalId: string
    channelRow: ChannelRow
    rawMessage: string
    messageId: string
    parentSignalId: string | null
    replyToMessageId: string | null
    isReply: boolean
    parseResult: Awaited<ReturnType<typeof parseChannelMessageSync>>
  }): Promise<boolean> {
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
      { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true },
    )
    if (insertErr) {
      console.error(`[userListener] signal upsert failed signalId=${signalId}:`, insertErr.message)
      return false
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

  private persistNonSignalSkip(args: {
    channelRow: ChannelRow
    rawMessage: string
    messageId: string
    parentSignalId: string | null
    replyToMessageId: string | null
    isReply: boolean
  }): void {
    const { channelRow, rawMessage, messageId, parentSignalId, replyToMessageId, isReply } = args
    void (async () => {
      void rawMessage
      void parentSignalId
      void replyToMessageId
      void isReply
      // Non-trade chatter should not be persisted as skipped signal rows.
      await this.bumpLastSeen(channelRow.id, messageId)
    })().catch(err => {
      console.error('[userListener] persistNonSignalSkip failed:', err)
    })
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
      const rowPatch: Record<string, unknown> = {
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
      }
      const { error: insertErr } = await this.supabase.from('signals').upsert(
        rowPatch,
        { onConflict: 'user_id,channel_id,telegram_message_id', ignoreDuplicates: true },
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

  private startSignalReconcileSweep() {
    if (this.signalReconcileSweepTimer) return
    this.signalReconcileSweepTimer = setInterval(() => {
      this.runSignalTelegramReconcile('reconcile_sweep').catch(err =>
        console.error(`[userListener] signal reconcile sweep error for ${this.userId}:`, err),
      )
    }, RECONCILE_SWEEP_INTERVAL_MS)
    this.signalReconcileSweepTimer.unref?.()
    console.log(
      `[userListener] signal reconcile sweep started user=${this.userId}`
      + ` intervalMs=${RECONCILE_SWEEP_INTERVAL_MS}`,
    )
  }

  /**
   * Fetch live Telegram text for recent signals and reconcile mismatches with AI revision.
   */
  async runSignalTelegramReconcile(
    source: 'reconcile_sweep' | 'reconcile_poll_hook' | 'cron' | 'live_edit',
    channelRow?: ChannelRow,
  ): Promise<SignalReconcileStats> {
    const stats: SignalReconcileStats = { checked: 0, mismatches: 0, revised: 0, errors: 0 }
    if (this.signalReconcileInFlight) return stats
    this.signalReconcileInFlight = true
    try {
      const windowMs = source === 'reconcile_poll_hook' ? RECONCILE_POLL_HOOK_WINDOW_MS : undefined
      const maxSignals = source === 'reconcile_poll_hook' ? RECONCILE_POLL_HOOK_MAX_SIGNALS : undefined
      const signals = await loadSignalsForReconcile(this.supabase, {
        userId: this.userId,
        windowMs,
        maxSignals,
        channelRowId: channelRow?.id,
      })
      if (!signals.length) return stats

      const grouped = groupSignalsByChannel(signals)
      for (const [channelRowId, rows] of grouped) {
        const row = channelRow?.id === channelRowId
          ? channelRow
          : this.fastPollRows.find(r => r.id === channelRowId)
            ?? (await this.supabase
              .from('telegram_channels')
              .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
              .eq('id', channelRowId)
              .maybeSingle()).data as ChannelRow | null
        if (!row) continue

        const channelStats = await this.runSignalReconcileForChannel(row, rows, source)
        stats.checked += channelStats.checked
        stats.mismatches += channelStats.mismatches
        stats.revised += channelStats.revised
        stats.errors += channelStats.errors
      }
      return stats
    } finally {
      this.signalReconcileInFlight = false
    }
  }

  private async runSignalReconcileForChannel(
    channelRow: ChannelRow,
    signals: Awaited<ReturnType<typeof loadSignalsForReconcile>>,
    source: string,
  ): Promise<SignalReconcileStats> {
    const stats: SignalReconcileStats = { checked: 0, mismatches: 0, revised: 0, errors: 0 }
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(channelRow)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      stats.errors += 1
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'signal_reconcile_sweep_error',
        channelRowId: channelRow.id,
        detail: { source, error: msg.slice(0, 300), phase: 'peer_resolve' },
      })
      return stats
    }

    const snapshots = new Map<string, { text: string; editDateSec: number | null }>()
    const ids = signals.map(s => s.telegram_message_id)
    for (const chunk of chunkTelegramMessageIds(ids)) {
      const numericIds = chunk
        .map(id => Number(id))
        .filter(n => Number.isFinite(n) && n > 0)
      if (!numericIds.length) continue
      try {
        const batch = (await this.client.getMessages(peer as never, {
          ids: numericIds,
        })) as unknown[]
        for (const [id, snap] of snapshotsFromTelegramMessages(batch ?? [])) {
          snapshots.set(id, snap)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        stats.errors += 1
        incMetric('signal_reconcile_get_messages_failed')
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'signal_reconcile_sweep_error',
          channelRowId: channelRow.id,
          detail: {
            source,
            error: msg.slice(0, 300),
            phase: 'get_messages',
            ids: chunk.slice(0, 10),
          },
        })
      }
    }

    const checkedIds: string[] = []
    const editDateBySignalId = new Map<string, number | null>()
    for (const signal of signals) {
      const mid = signal.telegram_message_id?.trim()
      const snap = mid ? snapshots.get(mid) : undefined
      if (!snap) continue
      checkedIds.push(signal.id)
      editDateBySignalId.set(signal.id, snap.editDateSec)
    }
    stats.checked = checkedIds.length

    const mismatches = findSignalsNeedingReconcile(signals, snapshots)
    const mismatchIds = new Set(mismatches.map(m => m.signal.id))
    const reconciledIds = checkedIds.filter(id => !mismatchIds.has(id))
    if (reconciledIds.length) {
      await markSignalsReconciled(this.supabase, {
        signalIds: reconciledIds,
        editDateBySignalId,
      })
    }
    if (!mismatches.length) {
      if (stats.checked > 0) {
        void persistListenerEvent(this.supabase, {
          userId: this.userId,
          eventType: 'signal_reconcile_checked',
          channelRowId: channelRow.id,
          detail: { source, checked: stats.checked, mismatches: 0 },
        })
      }
      return stats
    }

    stats.mismatches = mismatches.length
    for (const candidate of mismatches) {
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'signal_reconcile_mismatch',
        channelRowId: channelRow.id,
        telegramMessageId: candidate.signal.telegram_message_id,
        detail: {
          source,
          signal_id: candidate.signal.id,
          edit_date_sec: candidate.editDateSec,
        },
      })
      try {
        const revised = await this.tryApplyMessageRevision({
          channelRow,
          messageId: candidate.signal.telegram_message_id,
          rawMessage: candidate.rawMessage,
          source: `reconcile_${source}`,
          telegramEditDateSeen: candidate.editDateSec,
        })
        if (revised) {
          stats.revised += 1
          await markSignalsReconciled(this.supabase, {
            signalIds: [candidate.signal.id],
            editDateBySignalId,
          })
        }
      } catch {
        stats.errors += 1
      }
    }
    return stats
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

  private async skipMessageWhileCopierPaused(channelRow: ChannelRow, messageId: string): Promise<boolean> {
    if (!(await loadCachedUserCopierPaused(this.supabase, this.userId))) return false
    await this.bumpLastSeen(channelRow.id, messageId)
    return true
  }

  private subscribeCopierPauseState(): void {
    if (this.userProfilesCopierPauseChannel) return
    this.userProfilesCopierPauseChannel = this.supabase
      .channel(`user_listener_copier_pause_${this.userId}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'user_profiles',
          filter: `user_id=eq.${this.userId}`,
        } as never,
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const row = payload.new
          if (!row) return
          const copierPaused = row.copier_paused === true
          const previousPaused = payload.old?.copier_paused === true
          const transition = applyCopierPauseProfileUpdate(this.userId, copierPaused, previousPaused)
          if (transition === 'resumed') {
            void this.advanceAllChannelsLastSeenToLatest()
          }
        },
      )
      .subscribe()
  }

  private async advanceChannelLastSeenToLatest(row: ChannelRow, peer?: unknown): Promise<void> {
    try {
      const resolvedPeer = peer ?? await this.resolveChannelPeer(row)
      const latest = await this.client.getMessages(resolvedPeer as never, { limit: 1 })
      const latestId = Number(latest[0]?.id)
      if (!Number.isFinite(latestId)) return
      await this.bumpLastSeen(row.id, String(latestId))
      row.last_seen_message_id = latestId
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[userListener] advance last_seen failed user=${this.userId} channel=${row.id}:`,
        msg,
      )
    }
  }

  private async advanceAllChannelsLastSeenToLatest(): Promise<void> {
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    for (const row of (rows ?? []) as ChannelRow[]) {
      await this.advanceChannelLastSeenToLatest(row)
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

  private async bumpLastLive(channelRowId: string) {
    this.lastLiveByRow.set(channelRowId, Date.now())
    await this.supabase
      .from('telegram_channels')
      .update({ last_live_at: new Date().toISOString() })
      .eq('id', channelRowId)
  }

  /** Resolve + join every monitored channel so live NewMessage fires for all of them. */
  private async warmAllMonitoredChannelEntities(): Promise<void> {
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    for (const row of (rows ?? []) as ChannelRow[]) {
      await this.ensureJoinedPublicChannel(row).catch(() => { /* optional */ })
      await this.warmChannelEntity(row).catch(() => { /* logged inside */ })
    }
  }

  /**
   * Join public channels by @username so getMessages and live updates work for
   * external signal providers the user has not opened in Telegram yet.
   */
  private async ensureJoinedPublicChannel(row: ChannelRow): Promise<void> {
    const username = normalizeChannelUsername(row.channel_username)
    if (!username) return
    try {
      const entity = await this.client.getInputEntity(username)
      await tgInvoke(this.client, new Api.channels.JoinChannel({ channel: entity }))
      incMetric('channel_join_ok')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        msg.includes('USER_ALREADY_PARTICIPANT')
        || msg.includes('CHANNELS_TOO_MUCH')
        || msg.includes('INVITE_HASH_EMPTY')
      ) {
        return
      }
      console.warn(
        `[userListener] ensureJoinedPublicChannel @${username} channel=${row.id}:`,
        msg.slice(0, 200),
      )
    }
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

  private async runRecentCatchUp(): Promise<void> {
    if (this.catchUpInFlight) return
    this.catchUpInFlight = true
    try {
      const { data: rows } = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id')
        .eq('user_id', this.userId)
        .eq('is_active', true)

      for (const row of (rows ?? []) as ChannelRow[]) {
        await this.catchUpChannelRecent(row).catch(err =>
          console.error(`[userListener] recent catchUp failed for channel ${row.id}:`, err)
        )
      }
    } finally {
      this.catchUpInFlight = false
    }
  }

  private async pollMonitoredChannelsForMessages(): Promise<void> {
    if (!this.isConnected) return
    const { data: rows } = await this.supabase
      .from('telegram_channels')
      .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
      .eq('user_id', this.userId)
      .eq('is_active', true)

    for (const row of (rows ?? []) as ChannelRow[]) {
      await this.pollChannelNewMessages(row).catch(err =>
        console.warn(`[userListener] poll failed channel=${row.id}:`, err),
      )
    }
  }

  /**
   * Poll Telegram history for channels where live NewMessage updates are missing
   * (common when the linked account broadcasts to its own channel).
   */
  private async pollChannelNewMessages(row: ChannelRow): Promise<void> {
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[userListener] poll peer resolve failed user=${this.userId} channel=${row.id}:`,
        msg,
      )
      incMetric('poll_peer_resolve_failed')
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'poll_peer_resolve_failed',
        channelRowId: row.id,
        detail: { error: msg.slice(0, 300) },
      })
      return
    }

    let minId = Number(row.last_seen_message_id ?? 0)
    if (!Number.isFinite(minId) || minId < 0) minId = 0

    let batch: Array<MessageLike & { id: number | bigint }>
    try {
      batch = (await this.client.getMessages(peer as never, {
        limit: minId === 0 ? 20 : 30,
        ...(minId > 0 ? { minId } : {}),
      })) as unknown as Array<MessageLike & { id: number | bigint }>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[userListener] poll getMessages failed user=${this.userId} channel=${row.id}:`,
        msg,
      )
      incMetric('poll_get_messages_failed')
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'poll_error',
        channelRowId: row.id,
        detail: { error: msg.slice(0, 300), min_id: minId },
      })
      return
    }

    this.lastSuccessfulPollAt = Date.now()

    if (!batch.length) {
      await this.runSignalTelegramReconcile('reconcile_poll_hook', row)
      return
    }

    const sorted = [...batch].sort((a, b) => Number(a.id) - Number(b.id))
    const latestId = Number(sorted[sorted.length - 1]?.id)
    if (!Number.isFinite(latestId)) return

    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) {
      await this.bumpLastSeen(row.id, String(latestId))
      row.last_seen_message_id = latestId
      return
    }

    if (minId === 0) {
      const now = Date.now()
      const recentWindowMs = 15 * 60_000
      for (const m of sorted) {
        const mid = Number(m.id)
        if (!Number.isFinite(mid)) continue
        const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
        if (epoch > 0 && now - epoch * 1000 <= recentWindowMs) {
          await this.logSignal(row, m, { source: 'catchup' })
        }
      }
      await this.bumpLastSeen(row.id, String(latestId))
      row.last_seen_message_id = latestId
      console.log(
        `[userListener] poll seeded channel=${row.id} username=${row.channel_username || '-'} lastMsg=${latestId}`,
      )
      return
    }

    const toProcess = sorted.filter(m => Number(m.id) > minId)
    if (!toProcess.length) {
      await this.runSignalTelegramReconcile('reconcile_poll_hook', row)
      return
    }

    for (const m of toProcess) {
      await this.logSignal(row, m, { source: 'catchup' })
    }
    // Advance the caller's row in place so cached rows (fast poll) don't
    // refetch the same batch on the next tick while the DB bump lags.
    row.last_seen_message_id = latestId
    await this.runSignalTelegramReconcile('reconcile_poll_hook', row)
  }

  private async catchUpChannelRecent(row: ChannelRow): Promise<void> {
    let peer: unknown
    try {
      peer = await this.resolveChannelPeer(row)
    } catch {
      return
    }

    const minIdRaw = row.last_seen_message_id
    const minId = minIdRaw == null ? 0 : Number(minIdRaw)
    if (!Number.isFinite(minId) || minId <= 0) return

    let batch: Array<MessageLike & { id: number | bigint }>
    try {
      batch = (await this.client.getMessages(peer as never, {
        limit: 20,
        minId,
      })) as unknown as Array<MessageLike & { id: number | bigint }>
    } catch {
      return
    }

    if (!batch.length) return

    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) {
      const sorted = [...batch].sort((a, b) => Number(a.id) - Number(b.id))
      const latestId = Number(sorted[sorted.length - 1]?.id)
      if (Number.isFinite(latestId) && latestId > minId) {
        await this.bumpLastSeen(row.id, String(latestId))
        row.last_seen_message_id = latestId
      }
      return
    }

    const now = Date.now()
    const maxAgeMs = 60_000
    const recent = batch
      .filter(m => {
        const mid = Number(m.id)
        if (!Number.isFinite(mid) || mid <= minId) return false
        const epoch = this.messageEpochSec(m as MessageLike & { date?: number | Date | string })
        return epoch > 0 && (now - epoch * 1000) <= maxAgeMs
      })
      .sort((a, b) => Number(a.id) - Number(b.id))

    for (const m of recent) {
      await this.logSignal(row, m, { source: 'catchup' })
    }
  }

  private async warmChannelEntity(row: ChannelRow): Promise<void> {
    try {
      await this.resolveChannelPeer(row)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[userListener] warmChannelEntity failed channel=${row.id}:`, msg)
      void persistListenerEvent(this.supabase, {
        userId: this.userId,
        eventType: 'peer_resolve_failed',
        channelRowId: row.id,
        detail: { error: msg.slice(0, 300) },
      })
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

    if (await loadCachedUserCopierPaused(this.supabase, this.userId)) {
      await this.advanceChannelLastSeenToLatest(row, peer)
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
    // Warm entity cache BEFORE registering the handler so gramjs can
    // deliver NewMessage events for all monitored channels.
    await this.warmEntityCache()
    await this.refreshChannelSubscription()
    // Run a lightweight catch-up for very recent messages (last 60s) that
    // may have arrived during the reconnect window. Full history replay is
    // NOT done here to avoid stale trade execution.
    void this.runRecentCatchUp().catch(err =>
      console.error(`[userListener] recent catch-up after reconnect failed for ${this.userId}:`, err)
    )
    await this.runReplyChainSweep()
  }

  // ── safety poll (Realtime drop fallback) ──────────────────────────────

  private startSafetyPoll() {
    if (this.safetyPollTimer) return
    this.safetyPollTimer = setInterval(() => {
      this.refreshChannelSubscription().catch(err =>
        console.error(`[userListener] safety poll error for ${this.userId}:`, err),
      )
      this.warmAllMonitoredChannelEntities().catch(err =>
        console.error(`[userListener] entity warm (poll tick) error for ${this.userId}:`, err),
      )
      this.pollMonitoredChannelsForMessages().catch(err =>
        console.error(`[userListener] channel poll error for ${this.userId}:`, err),
      )
    }, SAFETY_POLL_INTERVAL_MS)
    this.safetyPollTimer.unref?.()
  }

  // ── fast poll (channels with no live push from Telegram) ──────────────

  private startFastPoll() {
    if (this.fastPollTimer) return
    this.fastPollTimer = setInterval(() => {
      this.runFastPoll().catch(err =>
        console.error(`[userListener] fast poll error for ${this.userId}:`, err),
      )
    }, FAST_POLL_INTERVAL_MS)
    this.fastPollTimer.unref?.()
    console.log(
      `[userListener] fast poll started user=${this.userId}`
      + ` intervalMs=${FAST_POLL_INTERVAL_MS} liveStaleMs=${FAST_POLL_LIVE_STALE_MS}`,
    )
  }

  /**
   * Poll only the channels Telegram is not delivering live NewMessage updates
   * for (last_live_at null or stale). Channels with healthy live push are left
   * to the event handler + 30s safety poll. The channel list is cached and
   * refreshed every SAFETY_POLL_INTERVAL_MS to keep DB load flat.
   */
  private async runFastPoll(): Promise<void> {
    if (!this.isConnected || this.fastPollInFlight) return
    this.fastPollInFlight = true
    try {
      const now = Date.now()
      if (now - this.fastPollRowsAt > SAFETY_POLL_INTERVAL_MS) {
        const { data } = await this.supabase
          .from('telegram_channels')
          .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
          .eq('user_id', this.userId)
          .eq('is_active', true)
        this.fastPollRows = (data ?? []) as ChannelRow[]
        this.fastPollRowsAt = now
      }

      for (const row of this.fastPollRows) {
        const liveDb = row.last_live_at ? new Date(row.last_live_at).getTime() : 0
        const liveMem = this.lastLiveByRow.get(row.id) ?? 0
        const lastLive = Math.max(liveDb, liveMem)
        if (lastLive > 0 && now - lastLive < FAST_POLL_LIVE_STALE_MS) continue
        await this.pollChannelNewMessages(row).catch(err =>
          console.warn(`[userListener] fast poll failed channel=${row.id}:`, err),
        )
      }
    } finally {
      this.fastPollInFlight = false
    }
  }

  // ── entity cache warmup ────────────────────────────────────────────────

  private startEntityWarmup() {
    if (this.entityWarmupTimer) return
    this.entityWarmupTimer = setInterval(() => {
      this.warmEntityCache().catch(err =>
        console.error(`[userListener] entity warmup error for ${this.userId}:`, err)
      )
    }, ENTITY_WARMUP_INTERVAL_MS)
    this.entityWarmupTimer.unref?.()
  }

  private async warmEntityCache(): Promise<void> {
    if (!this.isConnected) return
    try {
      const dialogs = await this.client.getDialogs({ limit: DIALOG_MAX_SCAN })
      const channelCount = dialogs.filter(
        (d: { isChannel?: boolean; isGroup?: boolean }) => d.isChannel || d.isGroup,
      ).length
      console.log(
        `[userListener] entity cache warmed user=${this.userId} dialogs=${dialogs.length} channels=${channelCount}`,
      )
      incMetric('entity_cache_warmed')
      await this.warmAllMonitoredChannelEntities()
    } catch (err: unknown) {
      if (isAuthKeyDuplicated(err)) return
      if (isAuthKeyUnregistered(err)) rethrowIfSessionInvalid(err)
      console.warn(
        `[userListener] entity warmup getDialogs failed for ${this.userId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
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
