import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { TelegramSessionInvalidError } from './telegramClient'
import { ChannelInfo, ListenerStatus, UserListener } from './userListener'
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

  setTradeExecutor(executor: TradeExecutor): void {
    this.tradeExecutor = executor
    for (const listener of this.listeners.values()) {
      listener.setOnSignalParsed(row => executor.dispatchParsedSignal(row))
    }
  }

  async loadAll() {
    const { data: sessions, error } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, phone_number')
      .eq('is_active', true)

    if (error) {
      console.error('[sessionManager] Failed to load sessions:', error.message)
      return
    }

    console.log(`[sessionManager] Loading ${sessions?.length ?? 0} sessions`)

    const staggerMs = Math.max(0, Math.min(30_000, Number(process.env.TELEGRAM_MULTI_SESSION_STAGGER_MS ?? 600)))
    let i = 0
    for (const session of sessions ?? []) {
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

  /**
   * Subscribe to Supabase Realtime postgres_changes on telegram_channels.
   * When a user toggles a channel on/off the relevant listener rebinds
   * its NewMessage filter immediately instead of waiting up to 60s for
   * the safety poll inside UserListener.
   */
  private subscribeToChannelChanges() {
    if (this.channelChannel) return

    this.channelChannel = this.supabase
      .channel('telegram_channels_changes')
      .on(
        // postgres_changes is provided via the realtime-js add-on; the
        // type is a string literal not present in supabase-js core types,
        // hence the explicit cast.
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'telegram_channels' } as never,
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const userId = (payload.new?.user_id ?? payload.old?.user_id) as string | undefined
          if (!userId) return
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
    const { data: sessions } = await this.supabase
      .from('telegram_sessions')
      .select('user_id, session_string, is_active')

    const activeSessions = new Set((sessions ?? []).filter(s => s.is_active).map(s => s.user_id))

    for (const session of sessions ?? []) {
      if (session.is_active && !this.listeners.has(session.user_id)) {
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

  /**
   * Channel-attached copier signals should only execute when this worker holds
   * a live MTProto session for the user; otherwise parsed rows (Realtime/sweep)
   * can still fire orders while Telegram is down or on another host.
   */
  canExecuteTelegramCopierTrades(userId: string): boolean {
    const listener = this.listeners.get(userId)
    if (!listener) return false
    return listener.isTelegramConnected()
  }

  getStatus(): ListenerStatus[] {
    const out: ListenerStatus[] = []
    for (const [, listener] of this.listeners) {
      out.push(listener.getStatus())
    }
    return out
  }

  /**
   * Take ownership of an already-connected, authenticated TelegramClient
   * (e.g. one produced by AuthService.verifyCode) and run it as the
   * long-lived listener. Avoids the second connect from the same host
   * that previously came from the worker spinning up its own client.
   */
  async adoptClient(userId: string, client: TelegramClient, sessionString: string) {
    await this.stopListener(userId)
    const listener = new UserListener(userId, sessionString, this.supabase, client)
    if (this.tradeExecutor) {
      listener.setOnSignalParsed(row => this.tradeExecutor!.dispatchParsedSignal(row))
    }
    await listener.start({ alreadyConnected: true })
    this.listeners.set(userId, listener)
    console.log(`[sessionManager] Adopted live client for user ${userId}`)
  }

  /** Drop worker listener + DB session when Telegram rejects the auth key. */
  async invalidateTelegramSession(userId: string): Promise<void> {
    await this.stopListener(userId)
    await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
    const [sessionRes, channelsRes] = await Promise.all([
      this.supabase.from('telegram_sessions').delete().eq('user_id', userId),
      this.supabase.from('telegram_channels').delete().eq('user_id', userId),
    ])
    if (sessionRes.error) {
      console.warn(`[sessionManager] invalidateTelegramSession session delete failed for ${userId}:`, sessionRes.error.message)
    }
    if (channelsRes.error) {
      console.warn(`[sessionManager] invalidateTelegramSession channels delete failed for ${userId}:`, channelsRes.error.message)
    }
  }

  async listChannels(userId: string): Promise<ChannelInfo[]> {
    const listener = await this.ensureListener(userId)
    return listener.listChannels()
  }

  private async ensureListener(userId: string): Promise<UserListener> {
    let listener = this.listeners.get(userId)
    if (listener) return listener

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
    const listener = await this.ensureListener(userId)
    return listener.backfillChannelHistory(channelRowId, days)
  }

  async importBacktestChannelHistory(
    userId: string,
    channelRowId: string,
    fromIso: string,
    toIso: string,
  ) {
    const listener = await this.ensureListener(userId)
    return listener.importBacktestChannelHistory(channelRowId, fromIso, toIso)
  }

  async syncBacktestSignals(
    userId: string,
    channelRowId: string,
    fromIso: string,
    toIso: string,
    runId?: string,
  ) {
    const listener = await this.ensureListener(userId)
    return listener.syncBacktestSignals(channelRowId, fromIso, toIso, { runId })
  }

  private async startListener(userId: string, sessionString: string): Promise<void> {
    if (this.listeners.has(userId)) return

    const listener = new UserListener(userId, sessionString, this.supabase)
    if (this.tradeExecutor) {
      listener.setOnSignalParsed(row => this.tradeExecutor!.dispatchParsedSignal(row))
    }
    try {
      await listener.start()
    } catch (err) {
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
    console.log(`[sessionManager] Stopped listener for user ${userId}`)
  }

  async disconnectAll() {
    if (this.channelChannel) {
      try { await this.supabase.removeChannel(this.channelChannel) } catch { /* noop */ }
      this.channelChannel = null
    }
    for (const [userId, listener] of this.listeners) {
      await listener.stop()
      console.log(`[sessionManager] Disconnected ${userId}`)
    }
    this.listeners.clear()
  }
}
