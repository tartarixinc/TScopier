import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import type { MonitorLoopHandle } from './monitorIdleGate'

const WATCH_TABLES = [
  'range_pending_legs',
  'partial_tp_legs',
  'signal_entry_pending_orders',
  'signal_range_entry_waits',
  'basket_reconcile_jobs',
  'trades',
  'signals',
] as const

/**
 * Supabase Realtime wake: poke idle monitors when new work is inserted/updated.
 * Resubscribes on channel errors so a silent subscribe failure cannot leave
 * trade workers waiting on the idle sweep (5–15s) for live signals.
 */
export function subscribeMonitorWorkWake(
  supabase: SupabaseClient,
  loops: MonitorLoopHandle[],
): () => void {
  let stopped = false
  let channel: RealtimeChannel | null = null
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null
  let consecutiveFailures = 0

  const pokeAll = () => {
    for (const loop of loops) loop.poke()
  }

  const clearResubscribe = () => {
    if (resubscribeTimer) {
      clearTimeout(resubscribeTimer)
      resubscribeTimer = null
    }
  }

  const teardownChannel = () => {
    if (channel) {
      void supabase.removeChannel(channel)
      channel = null
    }
  }

  const attach = () => {
    if (stopped) return
    teardownChannel()
    const next = supabase.channel(`monitor_work_wake:${process.pid}:${Date.now()}`)
    for (const table of WATCH_TABLES) {
      next.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table },
        pokeAll,
      )
      next.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table },
        pokeAll,
      )
    }
    next.subscribe((status, err) => {
      if (stopped) return
      if (status === 'SUBSCRIBED') {
        consecutiveFailures = 0
        return
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        consecutiveFailures += 1
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(consecutiveFailures, 4))
        console.warn(
          `[monitorWorkWake] realtime status=${status}`
          + ` failures=${consecutiveFailures} retry_in_ms=${delayMs}`
          + (err ? ` err=${err.message ?? String(err)}` : ''),
        )
        clearResubscribe()
        resubscribeTimer = setTimeout(() => {
          resubscribeTimer = null
          attach()
        }, delayMs)
        resubscribeTimer.unref?.()
      }
    })
    channel = next
  }

  attach()

  return () => {
    stopped = true
    clearResubscribe()
    teardownChannel()
  }
}
