import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { runEphemeralBacktestSync, runWithEphemeralListener } from './backtestSync'
import { TelegramSessionInvalidError } from './telegramClient'
import { ChannelInfo, ListenerStatus, UserListener, type SignalReconcileStats } from './userListener'
import {
  acquireSessionLease,
  countFreshListenerLeasesForUsers,
  ensureSessionLeaseFresh,
  listActiveLeases,
  releaseSessionLease,
} from './sessionLease'
import { getMetricsSnapshot } from './workerMetrics'
import { userBelongsToShard, workerConfig } from './workerConfig'
import { parallelMap } from './parallelPool'
import type { TradeExecutor } from './tradeExecutor'
import type { SignalRow } from './tradeExecutor/types'
import { dispatchPriorityForAction, parsedAction } from './tradeSignalActions'
import { ChannelListenerManager } from './channelListenerManager'
import { ChannelReconcileMonitor } from './channelReconcileMonitor'
import { isChannelFeedLiveForSubscriber } from './channelFeedGate'
import { channelListenerPrimaryMode } from './channelListenerConfig'

/**
 * Race a promise against a timeout so a single wedged network call cannot
 * stall a whole loop forever. Does not cancel the underlying work (the
 * caller just stops waiting), which is enough to keep periodic loops alive.
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function listenerInProcessDispatch(executor: TradeExecutor, row: SignalRow): boolean {
  return executor.acceptDispatchSignal(row, {
    priority: dispatchPriorityForAction(parsedAction(row.parsed_data)),
    source: row.dispatch_source ?? 'in_process',
  })
}

export { TelegramSessionInvalidError }

function gramjsListenerEnabled(): boolean {
  const engine = String(process.env.LISTENER_ENGINE ?? 'gramjs').toLowerCase().trim()
  return engine !== 'telethon'
}

function shouldRunGramjsForSession(session: { listener_engine?: string | null }): boolean {
  if (!gramjsListenerEnabled()) return false
  const engine = String(session.listener_engine ?? 'gramjs').toLowerCase().trim()
  return engine !== 'telethon'
}

/** Wait after disconnect so Telegram releases the auth key before a new connect. */
function authKeyReleaseDelayMs(): number {
  return Math.max(500, Math.min(120_000, Number(process.env.TELEGRAM_RECONNECT_COOLDOWN_MS ?? 3500)))
}

export class UserSessionManager {
  private listeners = new Map<string, UserListener>()
  private supabase: SupabaseClient
  private channelChannel: RealtimeChannel | null = null
  private authPendingChannel: RealtimeChannel | null = null
  private tradeExecutor: TradeExecutor | null = null
  /** Serializes start/stop/adopt for one user — prevents AUTH_KEY_DUPLICATED races. */
  private userConnectionLocks = new Map<string, Promise<void>>()
  /** True while adoptClient is handing off the auth-time MTProto socket. */
  private adoptingUsers = new Set<string>()
  private authGuard: ((userId: string) => boolean) | null = null
  /** Guards renewAllLeases so slow cycles cannot stack up and exhaust sockets. */
  private renewLeasesInFlight = false
  private channelListenerManager: ChannelListenerManager | null = null
  private channelReconcileMonitor: ChannelReconcileMonitor | null = null

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase
    this.channelListenerManager = new ChannelListenerManager(supabase)
    this.channelReconcileMonitor = new ChannelReconcileMonitor(
      supabase,
      async (readerUserId, signalChannelId, telegramChatId) => {
        const listener = this.listeners.get(readerUserId)
        if (!listener?.isTelegramConnected()) return null
        const row = {
          id: '',
          channel_id: telegramChatId,
          channel_username: '',
          signal_channel_id: signalChannelId,
          last_seen_message_id: null,
        }
        return {
          client: listener.getClient(),
          resolvePeer: () => listener.resolveChannelPeerForReconcile(row),
        }
      },
    )
  }

  getListener(userId: string): UserListener | undefined {
    return this.listeners.get(userId)
  }

  async startChannelListenerServices(): Promise<void> {
    if (!this.channelListenerManager) return
    await this.channelListenerManager.startup()
    this.channelListenerManager.startPeriodicSync()
    this.channelReconcileMonitor?.start()
  }

  stopChannelListenerServices(): void {
    this.channelListenerManager?.stop()
    this.channelReconcileMonitor?.stop()
  }

  /** In-memory pending auth check (send_code → verify_code window on this process). */
  setAuthGuard(fn: (userId: string) => boolean): void {
    this.authGuard = fn
  }

  private async withConnectionLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userConnectionLocks.get(userId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const chain = prev.then(() => gate)
    this.userConnectionLocks.set(userId, chain)
    try {
      await prev
      return await fn()
    } finally {
      release()
      if (this.userConnectionLocks.get(userId) === chain) {
        this.userConnectionLocks.delete(userId)
      }
    }
  }

  private isAuthBlocked(userId: string): boolean {
    return this.adoptingUsers.has(userId) || Boolean(this.authGuard?.(userId))
  }

  private async hasActivePendingAuthInDb(userId: string): Promise<boolean> {
    const { data } = await this.supabase
      .from('telegram_auth_pending')
      .select('user_id')
      .eq('user_id', userId)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()
    return Boolean(data)
  }

  private async shouldSkipListenerStart(userId: string): Promise<boolean> {
    if (this.isAuthBlocked(userId)) return true
    return this.hasActivePendingAuthInDb(userId)
  }

  getSupabase(): SupabaseClient {
    return this.supabase
  }

  setTradeExecutor(executor: TradeExecutor | null): void {
    this.tradeExecutor = executor
    for (const listener of this.listeners.values()) {
      listener.setOnSignalParsed(
        executor ? row => listenerInProcessDispatch(executor, row) : null,
      )
    }
  }

  async loadAll() {
    if (!workerConfig.runsListener) return
    if (!gramjsListenerEnabled()) {
      console.log('[sessionManager] LISTENER_ENGINE=telethon — gramjs listener disabled on this service')
      return
    }

    const { data: sessions, error } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, phone_number, listener_engine')
      .eq('is_active', true)

    if (error) {
      console.error('[sessionManager] Failed to load sessions:', error.message)
      return
    }

    const owned = (sessions ?? []).filter(
      s => userBelongsToShard(s.user_id) && shouldRunGramjsForSession(s),
    )
    console.log(
      `[sessionManager] Loading ${owned.length}/${sessions?.length ?? 0} sessions`
      + ` (shard ${workerConfig.shardId}/${workerConfig.shardCount})`,
    )

    const staggerMs = Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_MULTI_SESSION_STAGGER_MS ?? 600)))
    const startTimeoutMs = Math.max(
      15_000,
      Math.min(180_000, Number(process.env.LISTENER_START_TIMEOUT_MS ?? 60_000)),
    )
    let i = 0
    for (const session of owned) {
      if (i++ > 0 && staggerMs > 0) {
        await new Promise(r => setTimeout(r, staggerMs))
      }
      try {
        // Bound each connect so one wedged listener (e.g. a hung Telegram
        // warm-up) cannot stall startup for every other session.
        await withTimeout(
          this.startListener(session.user_id, session.session_string),
          startTimeoutMs,
          `startListener ${session.user_id}`,
        )
      } catch (err) {
        console.error(
          `[sessionManager] Failed to start listener for ${session.user_id}:`,
          err instanceof Error ? err.message : err,
        )
      }
    }

    this.subscribeToChannelChanges()
    this.subscribeToAuthPendingChanges()
  }

  async renewAllLeases(): Promise<void> {
    // A previous cycle is still running (a wedged Supabase call). Skip rather
    // than stacking overlapping runs that each re-hang and leak sockets — that
    // race froze every lease but the first listener, taking the engine offline.
    if (this.renewLeasesInFlight) {
      console.warn('[sessionManager] renewAllLeases skipped — previous cycle still running')
      return
    }
    this.renewLeasesInFlight = true
    try {
      const staleMs = Math.max(
        60_000,
        Math.min(600_000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180_000)),
      )
      const perUserTimeoutMs = Math.max(
        3_000,
        Math.min(30_000, Number(process.env.WORKER_LEASE_RENEW_TIMEOUT_MS ?? 8_000)),
      )
      const concurrency = Math.max(
        1,
        Math.min(16, Number(process.env.WORKER_LEASE_RENEW_CONCURRENCY ?? 6)),
      )

      // Renew with bounded parallelism and a per-user timeout so a single slow
      // or wedged lease write cannot block renewal for every other listener.
      const entries = Array.from(this.listeners.entries())
      await parallelMap(entries, concurrency, async ([userId, listener]) => {
        if (!listener.isTelegramConnected()) return

        try {
          const result = await withTimeout(
            ensureSessionLeaseFresh(this.supabase, userId),
            perUserTimeoutMs,
            `lease renew ${userId}`,
          )
          if (!result.ok) {
            console.warn(`[sessionManager] lease refresh failed ${userId}: ${result.reason}`)
            return
          }
          if (result.recovered && this.tradeExecutor) {
            const { replaySignalsAfterListenerRecovery } = await import('./listenerSignalReplay')
            void replaySignalsAfterListenerRecovery(this.tradeExecutor, userId)
          }
        } catch (err) {
          console.warn(
            `[sessionManager] lease refresh failed ${userId}:`,
            err instanceof Error ? err.message : err,
          )
          return
        }

        if (!listener.isListenerHealthy(staleMs)) {
          console.warn(
            `[sessionManager] listener quiet but lease renewed user=${userId}`
            + ' (no Telegram events recently — normal for low-traffic channels)',
          )
        }
      })
    } finally {
      this.renewLeasesInFlight = false
    }
  }

  private subscribeToChannelChanges() {
    if (this.channelChannel) return

    this.channelChannel = this.supabase
      .channel('telegram_channels_changes')
      .on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'telegram_channels' } as never,
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const userId = (payload.new?.user_id ?? payload.old?.user_id) as string | undefined
          if (!userId) return
          if (!userBelongsToShard(userId)) return
          const listener = this.listeners.get(userId)
          if (!listener) return
          listener.onChannelsChanged().catch(err =>
            console.error(`[sessionManager] onChannelsChanged failed for ${userId}:`, err),
          )
        },
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          console.log('[sessionManager] Realtime telegram_channels subscription active')
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          console.warn(`[sessionManager] Realtime subscription status: ${status}`)
        }
      })
  }

  private subscribeToAuthPendingChanges() {
    if (this.authPendingChannel) return

    this.authPendingChannel = this.supabase
      .channel('telegram_auth_pending_changes')
      .on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'telegram_auth_pending' } as never,
        (payload: { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const userId = (payload.new?.user_id ?? payload.old?.user_id) as string | undefined
          if (!userId || !userBelongsToShard(userId)) return
          if (payload.eventType === 'DELETE') {
            void this.onAuthPendingCleared(userId)
            return
          }
          void this.stopListenerForPendingAuth(userId)
        },
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          console.log('[sessionManager] Realtime telegram_auth_pending subscription active')
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          console.warn(`[sessionManager] telegram_auth_pending subscription status: ${status}`)
        }
      })
  }

  /** Stop the live listener before send_code so the auth key slot is free on this host. */
  async pauseForAuth(userId: string, opts?: { releaseDelay?: boolean }): Promise<void> {
    if (!workerConfig.runsListener) return
    await this.withConnectionLock(userId, async () => {
      await this.disconnectListener(userId)
      if (opts?.releaseDelay === false) return
      const delay = authKeyReleaseDelayMs()
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
    })
  }

  private async stopListenerForPendingAuth(userId: string): Promise<void> {
    if (!this.listeners.has(userId)) return
    console.log(`[sessionManager] stopping listener for ${userId} — telegram auth in progress`)
    await this.withConnectionLock(userId, async () => {
      await this.disconnectListener(userId)
    })
  }

  private async onAuthPendingCleared(userId: string): Promise<void> {
    // Debounce: send_code clears pending before inserting the new row.
    await new Promise(r => setTimeout(r, 2500))
    if (this.listeners.has(userId) || this.isAuthBlocked(userId)) return
    if (await this.hasActivePendingAuthInDb(userId)) return
    const { data: sess } = await this.supabase
      .from('telegram_sessions')
      .select('session_string, is_active, listener_engine')
      .eq('user_id', userId)
      .maybeSingle()
    if (!sess?.session_string || !sess.is_active || !shouldRunGramjsForSession(sess)) return
    try {
      await this.startListener(userId, sess.session_string)
    } catch (err) {
      console.warn(`[sessionManager] restart after auth cleared failed for ${userId}:`, err)
    }
  }

  async syncSessions() {
    if (!workerConfig.runsListener) return

    const { data: sessions } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, is_active, listener_engine')

    const activeOnShard = (sessions ?? []).filter(
      s => s.is_active && userBelongsToShard(s.user_id) && shouldRunGramjsForSession(s),
    )
    const activeSessions = new Set(activeOnShard.map(s => s.user_id))

    for (const [userId] of this.listeners) {
      if (!activeSessions.has(userId) || await this.hasActivePendingAuthInDb(userId)) {
        await this.stopListener(userId)
      }
    }

    for (const session of activeOnShard) {
      if (this.listeners.has(session.user_id)) continue
      if (await this.shouldSkipListenerStart(session.user_id)) continue
      try {
        await this.startListener(session.user_id, session.session_string)
      } catch (err) {
        console.error(`[sessionManager] Failed to start listener for ${session.user_id}:`, err)
      }
    }
  }

  hasListener(userId: string): boolean {
    return this.listeners.has(userId)
  }

  canExecuteTelegramCopierTrades(userId: string): boolean {
    if (workerConfig.runsListener) {
      const listener = this.listeners.get(userId)
      if (listener?.isTelegramConnected()) return true
    }
    return false
  }

  /** Async lease check for trade-only workers; canonical feed satisfies gate in primary mode. */
  async canExecuteTelegramCopierTradesAsync(
    userId: string,
    subscriptionChannelId?: string | null,
  ): Promise<boolean> {
    if (subscriptionChannelId && channelListenerPrimaryMode()) {
      const { data } = await this.supabase
        .from('telegram_channels')
        .select('signal_channel_id')
        .eq('id', subscriptionChannelId)
        .maybeSingle()
      const signalChannelId = (data as { signal_channel_id?: string | null } | null)?.signal_channel_id
      if (signalChannelId) {
        const feedLive = await isChannelFeedLiveForSubscriber(this.supabase, userId, signalChannelId)
        if (feedLive) return true
      }
    }

    if (workerConfig.runsListener) {
      return this.canExecuteTelegramCopierTrades(userId)
    }
    const { isTelegramListenerLiveForUser } = await import('./sessionLease')
    return isTelegramListenerLiveForUser(this.supabase, userId)
  }

  getStatus(): ListenerStatus[] {
    const out: ListenerStatus[] = []
    for (const [, listener] of this.listeners) {
      out.push(listener.getStatus())
    }
    return out
  }

  async getHealthPayload(): Promise<{
    ok: boolean
    role: string
    shard: string
    instance: string
    listeners: number
    connected_listeners: number
    detail: ListenerStatus[]
    active_leases: number
    fresh_leases_for_connected: number
    lease_mismatch: boolean
    lease_gap: number
    lease_mismatch_user_ids?: string[]
    metrics: Record<string, number>
    checked_at: string
  }> {
    const status = this.getStatus()
    const now = Date.now()
    const staleMs = Math.max(
      60_000,
      Math.min(600_000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180_000)),
    )
    const connectedStatus = status.filter(s => s.connected)
    const listenerActivityOk = !workerConfig.runsListener
      || status.length === 0
      || status.every(s =>
        s.connected && (s.last_event_at === 0 || now - s.last_event_at < staleMs),
      )

    let freshLeasesForConnected = 0
    let leaseMismatchUserIds: string[] = []
    if (workerConfig.runsListener && connectedStatus.length > 0) {
      const leaseCheck = await countFreshListenerLeasesForUsers(
        this.supabase,
        connectedStatus.map(s => s.user_id),
      )
      freshLeasesForConnected = leaseCheck.fresh
      leaseMismatchUserIds = leaseCheck.missingUserIds
    }

    const leaseGap = Math.max(0, connectedStatus.length - freshLeasesForConnected)
    const leaseMismatch = workerConfig.runsListener && leaseGap > 0

    const leases = workerConfig.runsListener
      ? await listActiveLeases(this.supabase)
      : []

    if (leaseMismatch) {
      console.warn(
        `[sessionManager] lease mismatch connected=${connectedStatus.length}`
        + ` fresh_leases=${freshLeasesForConnected} gap=${leaseGap}`
        + ` users=${leaseMismatchUserIds.join(',')}`,
      )
    }

    return {
      ok: listenerActivityOk && !leaseMismatch,
      role: workerConfig.role,
      shard: `${workerConfig.shardId}/${workerConfig.shardCount}`,
      instance: workerConfig.instanceId,
      listeners: status.length,
      connected_listeners: connectedStatus.length,
      detail: status,
      active_leases: leases.length,
      fresh_leases_for_connected: freshLeasesForConnected,
      lease_mismatch: leaseMismatch,
      lease_gap: leaseGap,
      ...(leaseMismatchUserIds.length > 0
        ? { lease_mismatch_user_ids: leaseMismatchUserIds }
        : {}),
      metrics: getMetricsSnapshot(),
      checked_at: new Date(now).toISOString(),
    }
  }

  async adoptClient(userId: string, client: TelegramClient, sessionString: string) {
    if (!workerConfig.runsListener) {
      throw new Error('Telegram listener not enabled on this worker (WORKER_ROLE)')
    }

    return this.withConnectionLock(userId, async () => {
      this.adoptingUsers.add(userId)
      try {
        await this.disconnectListener(userId)

        const lease = await acquireSessionLease(this.supabase, userId)
        if (!lease.ok) {
          throw new Error(`Cannot adopt Telegram client: ${lease.reason}`)
        }

        const listener = new UserListener(userId, sessionString, this.supabase, client)
        if (this.tradeExecutor) {
          listener.setOnSignalParsed(row => listenerInProcessDispatch(this.tradeExecutor!, row))
        }
        try {
          await listener.start({ alreadyConnected: true })
        } catch (err) {
          await releaseSessionLease(this.supabase, userId)
          throw err
        }
        this.listeners.set(userId, listener)
        console.log(`[sessionManager] Adopted live client for user ${userId}`)
      } catch (err) {
        try { await client.disconnect() } catch { /* ignore */ }
        throw err
      } finally {
        this.adoptingUsers.delete(userId)
      }
    })
  }

  /** List channels on the listener adoptClient just registered — never opens a second MTProto socket. */
  async listChannelsForAdoptedUser(userId: string, opts?: { skipColdDelay?: boolean }): Promise<ChannelInfo[]> {
    const listener = this.listeners.get(userId)
    if (!listener) throw new Error('No listener after Telegram auth')
    return listener.listChannels(opts)
  }

  /**
   * Telegram revoked the auth key (AUTH_KEY_UNREGISTERED). Drop the dead session
   * so we stop reconnect loops, but keep configured telegram_channels — the user
   * reconnects manually without re-adding channels.
   */
  async invalidateTelegramSession(userId: string): Promise<void> {
    await this.stopListener(userId)
    await releaseSessionLease(this.supabase, userId)
    await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
    const { error } = await this.supabase.from('telegram_sessions').delete().eq('user_id', userId)
    if (error) {
      console.warn(`[sessionManager] invalidateTelegramSession session delete failed for ${userId}:`, error.message)
    }
  }

  async listChannels(userId: string, opts?: { skipColdDelay?: boolean }): Promise<ChannelInfo[]> {
    const local = this.listeners.get(userId)
    if (local?.isTelegramConnected()) {
      return local.listChannels(opts)
    }
    const listener = await this.ensureListener(userId)
    return listener.listChannels(opts)
  }

  private async ensureListener(userId: string): Promise<UserListener> {
    const existing = this.listeners.get(userId)
    if (existing) return existing

    if (!workerConfig.runsListener) {
      throw new Error('Live Telegram listener not available on this worker')
    }

    if (await this.shouldSkipListenerStart(userId)) {
      throw new Error('Telegram auth is in progress. Finish linking, then try again.')
    }

    const { data: sess, error } = await this.supabase
      .from('telegram_sessions')
      .select('session_string, is_active')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw new Error(`Failed to load session: ${error.message}`)
    if (!sess?.session_string) throw new Error('No Telegram session for this user')
    if (!sess.is_active) throw new Error('Telegram session is paused')

    await this.startListener(userId, sess.session_string)
    const listener = this.listeners.get(userId)
    if (!listener) throw new Error('Failed to start listener for user')
    return listener
  }

  async backfillChannelHistory(
    userId: string,
    channelRowId: string,
    days: number,
    opts?: { forTraining?: boolean },
  ) {
    // Prefer the live listener (listener-only deploys). Avoids a second MTProto
    // connection that would trigger AUTH_KEY_DUPLICATED.
    if (workerConfig.runsListener) {
      let listener = this.listeners.get(userId)
      if (!listener?.isTelegramConnected()) {
        try {
          listener = await this.ensureListener(userId)
        } catch {
          listener = undefined
        }
      }
      if (listener?.isTelegramConnected()) {
        return listener.backfillChannelHistory(channelRowId, days, opts)
      }
    }

    if (!workerConfig.runsBacktestHttp) {
      throw new Error(
        'Telegram listener is not connected. Link Telegram on Copier Engine, wait a few seconds, then refresh.',
      )
    }
    return this.withEphemeralTelegram(userId, () =>
      runWithEphemeralListener(this.supabase, userId, listener =>
        listener.backfillChannelHistory(channelRowId, days, opts),
      ),
    )
  }

  async importBacktestChannelHistory(
    userId: string,
    channelRowId: string,
    fromIso: string,
    toIso: string,
  ) {
    if (!workerConfig.runsBacktestHttp) {
      throw new Error('Backtest not enabled on this worker')
    }
    return this.withEphemeralTelegram(userId, () =>
      runWithEphemeralListener(this.supabase, userId, listener =>
        listener.importBacktestChannelHistory(channelRowId, fromIso, toIso),
      ),
    )
  }

  async syncBacktestSignals(
    userId: string,
    channelRowId: string,
    fromIso: string,
    toIso: string,
    runId?: string,
  ) {
    if (!workerConfig.runsBacktestHttp) {
      throw new Error(
        'Backtest sync is not enabled on this worker. Use a WORKER_ROLE=backtest or all service.',
      )
    }

    if (workerConfig.role === 'listener') {
      throw new Error(
        'Backtest sync blocked on listener-only workers. Point BACKTEST_WORKER_URL to a backtest service.',
      )
    }

    return this.withEphemeralTelegram(userId, () =>
      runEphemeralBacktestSync(this.supabase, userId, channelRowId, fromIso, toIso, runId),
    )
  }

  /**
   * Runs fn while the live listener is stopped (if any) so backtest can use the sole MTProto slot.
   */
  private async withEphemeralTelegram<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const pauseLive = workerConfig.runsListener
      && (workerConfig.role === 'all' || process.env.BACKTEST_PAUSE_LIVE_LISTENER !== 'false')

    let sessionString: string | null = null
    let hadLiveListener = false
    if (pauseLive) {
      sessionString = (await this.supabase
        .from('telegram_sessions')
        .select('session_string')
        .eq('user_id', userId)
        .maybeSingle()).data?.session_string ?? null
      hadLiveListener = this.listeners.has(userId)
      if (hadLiveListener) {
        console.log(`[sessionManager] pausing live listener for backtest user=${userId}`)
        await this.stopListener(userId)
      }
      if (sessionString) {
        await new Promise(r => setTimeout(r, authKeyReleaseDelayMs()))
      }
    }

    try {
      return await fn()
    } finally {
      if (pauseLive && sessionString && hadLiveListener) {
        await this.restartListenerAfterBacktest(userId, sessionString)
      }
    }
  }

  /** Backtest pauses the copier listener; retry MTProto restart so Telegram does not stay offline. */
  private async restartListenerAfterBacktest(userId: string, sessionString: string): Promise<void> {
    const retryDelaysMs = [0, 3_000, 5_000, 10_000]
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
      const delay = retryDelaysMs[attempt] ?? 0
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      if (this.listeners.has(userId)) {
        console.log(`[sessionManager] listener restored after backtest user=${userId}`)
        return
      }
      try {
        await this.startListener(userId, sessionString)
      } catch (err) {
        console.warn(
          `[sessionManager] restart listener after backtest attempt ${attempt + 1} for ${userId}:`,
          err instanceof Error ? err.message : err,
        )
      }
      if (this.listeners.has(userId)) return
    }
    console.error(
      `[sessionManager] failed to restart listener after backtest user=${userId}`
      + ' — open Copier Engine and use Reconnect Telegram',
    )
  }

  private async startListener(userId: string, sessionString: string): Promise<void> {
    if (this.listeners.has(userId)) return
    if (!userBelongsToShard(userId)) return
    if (await this.shouldSkipListenerStart(userId)) {
      console.log(`[sessionManager] skip listener for ${userId}: auth in progress`)
      return
    }

    await this.withConnectionLock(userId, async () => {
      if (this.listeners.has(userId)) return
      if (await this.shouldSkipListenerStart(userId)) return

      const lease = await acquireSessionLease(this.supabase, userId)
      if (!lease.ok) {
        console.warn(`[sessionManager] skip listener for ${userId}: ${lease.reason}`)
        return
      }

      const listener = new UserListener(userId, sessionString, this.supabase)
      if (this.tradeExecutor) {
        listener.setOnSignalParsed(row => listenerInProcessDispatch(this.tradeExecutor!, row))
      }
      try {
        await listener.start()
      } catch (err) {
        await releaseSessionLease(this.supabase, userId)
        if (err instanceof TelegramSessionInvalidError) {
          await this.invalidateTelegramSession(userId)
        }
        throw err
      }
      this.listeners.set(userId, listener)
      console.log(`[sessionManager] Started listener for user ${userId}`)
    })
  }

  private async disconnectListener(userId: string): Promise<void> {
    const listener = this.listeners.get(userId)
    if (!listener) return
    await listener.stop()
    this.listeners.delete(userId)
    await releaseSessionLease(this.supabase, userId)
    console.log(`[sessionManager] Stopped listener for user ${userId}`)
  }

  private async stopListener(userId: string) {
    await this.withConnectionLock(userId, async () => {
      await this.disconnectListener(userId)
    })
  }

  async reconcileUserSignals(
    userId: string,
    opts?: { channelRowId?: string },
  ): Promise<{ ok: boolean; reason?: string; stats?: SignalReconcileStats }> {
    if (!userBelongsToShard(userId)) {
      return { ok: false, reason: 'wrong_shard' }
    }
    const listener = this.listeners.get(userId)
    if (!listener) {
      return { ok: false, reason: 'listener_not_running' }
    }
    let channelRow: { id: string; channel_id: string; channel_username: string } | undefined
    if (opts?.channelRowId) {
      const { data } = await this.supabase
        .from('telegram_channels')
        .select('id, channel_id, channel_username, last_seen_message_id, last_seen_at, last_live_at')
        .eq('id', opts.channelRowId)
        .eq('user_id', userId)
        .maybeSingle()
      if (data) channelRow = data as typeof channelRow
    }
    const stats = await listener.runSignalTelegramReconcile('cron', channelRow as never)
    return { ok: true, stats }
  }

  async reconcileAllListenersOnShard(): Promise<{
    users: number
    stats: SignalReconcileStats
  }> {
    const totals: SignalReconcileStats = { checked: 0, mismatches: 0, revised: 0, errors: 0 }
    let users = 0
    for (const [, listener] of this.listeners) {
      users += 1
      const stats = await listener.runSignalTelegramReconcile('cron')
      totals.checked += stats.checked
      totals.mismatches += stats.mismatches
      totals.revised += stats.revised
      totals.errors += stats.errors
    }
    return { users, stats: totals }
  }

  async disconnectAll() {
    if (this.channelChannel) {
      try { await this.supabase.removeChannel(this.channelChannel) } catch { /* noop */ }
      this.channelChannel = null
    }
    if (this.authPendingChannel) {
      try { await this.supabase.removeChannel(this.authPendingChannel) } catch { /* noop */ }
      this.authPendingChannel = null
    }
    for (const [userId, listener] of this.listeners) {
      await listener.stop()
      await releaseSessionLease(this.supabase, userId)
      console.log(`[sessionManager] Disconnected ${userId}`)
    }
    this.listeners.clear()
  }
}
