import { useCallback, useEffect, useState } from 'react'
import { fetchTradesAcrossProviders } from '../lib/fxsocketBroker'
import { supabase } from '../lib/supabase'
import { openTradeCountInCache } from '../lib/tradesSessionCache'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'

const REFRESH_MS = 60_000
const REALTIME_DEBOUNCE_MS = 450

async function fetchOpenTradeCount(): Promise<number> {
  const res = await fetchTradesAcrossProviders({
    scope: 'open',
    historyProfile: 'trades',
  })
  return (res.trades ?? []).filter(t => t.status === 'open').length
}

/** Sidebar count — broker truth (same source as the Trades page), not stale DB rows. */
export function useOpenTradeCount(userId: string | undefined): number {
  const [openCount, setOpenCount] = useState(0)

  const refresh = useCallback(async () => {
    if (!userId) {
      setOpenCount(0)
      return
    }

    const cached = openTradeCountInCache(userId)
    if (cached != null) setOpenCount(cached)

    try {
      setOpenCount(await fetchOpenTradeCount())
    } catch (e) {
      console.warn('[openTrades] broker check failed', e instanceof Error ? e.message : e)
      if (cached != null) setOpenCount(cached)
      else setOpenCount(0)
    }
  }, [userId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!userId) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void refresh()
      }, REALTIME_DEBOUNCE_MS)
    }

    const filter = `user_id=eq.${userId}`
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(userId).then(() => {
      if (cancelled) return
      channel = supabase
        .channel(`open_trades_indicator:${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'trades', filter },
          schedule,
        )
        .subscribe()
    })

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      window.clearInterval(interval)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [userId, refresh])

  return openCount
}
