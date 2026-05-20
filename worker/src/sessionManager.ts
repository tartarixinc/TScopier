import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { runEphemeralBacktestSync, runWithEphemeralListener } from './backtestSync'
import { TelegramSessionInvalidError } from './telegramClient'
import { ChannelInfo, ListenerStatus, UserListener } from './userListener'
import {
  acquireSessionLease,
  listActiveLeases,
  releaseSessionLease,
  renewSessionLease,
} from './sessionLease'
import { getMetricsSnapshot } from './workerMetrics'
import { userBelongsToShard, workerConfig } from './workerConfig'
import type { TradeExecutor } from './tradeExecutor'

export { TelegramSessionInvalidError }

export class UserSessionManager {
  private listeners = new Map<string, UserListener>()
  private supabase: SupabaseClient
  private channelChannel: RealtimeChannel | null = null
  private tradeExecutor: TradeExecutor | null = null

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase
  }

  setTradeExecutor(executor: TradeExecutor | null): void {
    this.tradeExecutor = executor
    for (const listener of this.listeners.values()) {
      listener.setOnSignalParsed(
        executor ? row => executor.dispatchParsedSignal(row) : null,
      )
    }
  }

  async loadAll() {
    if (!workerConfig.runsListener) return

    const { data: sessions, error } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, phone_number')
      .eq('is_active', true)

    if (error) {
      console.error('[sessionManager] Failed to load sessions:', error.message)
      return
    }

    const owned = (sessions ?? []).filter(s => userBelongsToShard(s.user_id))
    console.log(
      `[sessionManager] Loading ${owned.length}/${sessions?.length ?? 0} sessions`
      + ` (shard ${workerConfig.shardId}/${workerConfig.shardCount})`,
    )

    const staggerMs = Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_MULTI_SESSION_STAGGER_MS ?? 600)))
    let i = 0
    for (const session of owned) {
      if (i++ > 0 && staggerMs > 0) {
        await new Promise(r => setTimeout(r, staggerMs))
      }
      try {
        await this.startListener(session.user_id, session.session_string)
      } catch (err) {
        console.error(`[sessionManager] Failed to start listener for ${session.user_id}:`, err)
      }
    }

    this.subscribeToChannelChanges()
  }

  async renewAllLeases(): Promise<void> {
    for (const userId of this.listeners.keys()) {
      await renewSessionLease(this.supabase, userId).catch(err =>
        console.warn(`[sessionManager] lease renew failed ${userId}:`, err),
      )
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

  async syncSessions() {
    if (!workerConfig.runsListener) return

    const { data: sessions } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, is_active')

    const activeOnShard = (sessions ?? []).filter(
      s => s.is_active && userBelongsToShard(s.user_id),
    )
    const activeSessions = new Set(activeOnShard.map(s => s.user_id))

    for (const session of activeOnShard) {
      if (!this.listeners.has(session.user_id)) {
        try {
          await this.startListener(session.user_id, session.session_string)
        } catch (err) {
          console.error(`[sessionManager] Failed to start listener for ${session.user_id}:`, err)
        }
      }
    }

    for (const [userId] of this.listeners) {
      if (!activeSessions.has(userId)) {
        await this.stopListener(userId)
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

  /** Async lease check for trade-only workers. */
  async canExecuteTelegramCopierTradesAsync(userId: string): Promise<boolean> {
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
    detail: ListenerStatus[]
    active_leases: number
    metrics: Record<string, number>
    checked_at: string
  }> {
    const status = this.getStatus()
    const now = Date.now()
    const staleMs = Math.max(
      60_000,
      Math.min(600_000, Number(process.env.WORKER_HEALTH_STALE_MS ?? 180_000)),
    )
    const listenerOk = !workerConfig.runsListener
      || status.length === 0
      || status.every(s =>
        s.connected && (s.last_event_at === 0 || now - s.last_event_at < staleMs),
      )
    const leases = workerConfig.runsListener
      ? await listActiveLeases(this.supabase)
      : []
    return {
      ok: listenerOk,
      role: workerConfig.role,
      shard: `${workerConfig.shardId}/${workerConfig.shardCount}`,
      instance: workerConfig.instanceId,
      listeners: status.length,
      detail: status,
      active_leases: leases.length,
      metrics: getMetricsSnapshot(),
      checked_at: new Date(now).toISOString(),
    }
  }

  async adoptClient(userId: string, client: TelegramClient, sessionString: string) {
    if (!workerConfig.runsListener) {
      throw new Error('Telegram listener not enabled on this worker (WORKER_ROLE)')
    }
    await this.stopListener(userId)
    const listener = new UserListener(userId, sessionString, this.supabase, client)
    if (this.tradeExecutor) {
      listener.setOnSignalParsed(row => this.tradeExecutor!.dispatchParsedSignal(row))
    }
    await listener.start({ alreadyConnected: true })
    this.listeners.set(userId, listener)
    await acquireSessionLease(this.supabase, userId)
    console.log(`[sessionManager] Adopted live client for user ${userId}`)
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
    const listener = await this.ensureListener(userId)
    return listener.listChannels(opts)
  }

  private async ensureListener(userId: string): Promise<UserListener> {
    let listener = this.listeners.get(userId)
    if (listener) return listener

    if (!workerConfig.runsListener) {
      throw new Error('Live Telegram listener not available on this worker')
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
    listener = this.listeners.get(userId)
    if (!listener) throw new Error('Failed to start listener for user')
    return listener
  }

  async backfillChannelHistory(userId: string, channelRowId: string, days: number) {
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
        return listener.backfillChannelHistory(channelRowId, days)
      }
    }

    if (!workerConfig.runsBacktestHttp) {
      throw new Error(
        'Telegram listener is not connected. Link Telegram on Copier Engine, wait a few seconds, then refresh.',
      )
    }
    return this.withEphemeralTelegram(userId, () =>
      runWithEphemeralListener(this.supabase, userId, listener =>
        listener.backfillChannelHistory(channelRowId, days),
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
    if (pauseLive && this.listeners.has(userId)) {
      sessionString = (await this.supabase
        .from('telegram_sessions')
        .select('session_string')
        .eq('user_id', userId)
        .maybeSingle()).data?.session_string ?? null
      console.log(`[sessionManager] pausing live listener for backtest user=${userId}`)
      await this.stopListener(userId)
      await new Promise(r => setTimeout(r, 2000))
    }

    try {
      return await fn()
    } finally {
      if (pauseLive && sessionString) {
        await this.startListener(userId, sessionString)
      }
    }
  }

  private async startListener(userId: string, sessionString: string): Promise<void> {
    if (this.listeners.has(userId)) return
    if (!userBelongsToShard(userId)) return

    const lease = await acquireSessionLease(this.supabase, userId)
    if (!lease.ok) {
      console.warn(`[sessionManager] skip listener for ${userId}: ${lease.reason}`)
      return
    }

    const listener = new UserListener(userId, sessionString, this.supabase)
    if (this.tradeExecutor) {
      listener.setOnSignalParsed(row => this.tradeExecutor!.dispatchParsedSignal(row))
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
  }

  private async stopListener(userId: string) {
    const listener = this.listeners.get(userId)
    if (!listener) return
    await listener.stop()
    this.listeners.delete(userId)
    await releaseSessionLease(this.supabase, userId)
    console.log(`[sessionManager] Stopped listener for user ${userId}`)
  }

  async disconnectAll() {
    if (this.channelChannel) {
      try { await this.supabase.removeChannel(this.channelChannel) } catch { /* noop */ }
      this.channelChannel = null
    }
    for (const [userId, listener] of this.listeners) {
      await listener.stop()
      await releaseSessionLease(this.supabase, userId)
      console.log(`[sessionManager] Disconnected ${userId}`)
    }
    this.listeners.clear()
  }
}
