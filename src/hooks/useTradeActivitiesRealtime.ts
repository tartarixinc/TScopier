import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'

const DEBOUNCE_MS = 450

/**
 * Subscribe to new trade_execution_logs rows for the Management page feed.
 */
export function useTradeActivitiesRealtime(
  userId: string | undefined,
  onDataChange: () => void,
): void {
  const onChangeRef = useRef(onDataChange)
  onChangeRef.current = onDataChange

  useEffect(() => {
    if (!userId) return

    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        onChangeRef.current()
      }, DEBOUNCE_MS)
    }

    const filter = `user_id=eq.${userId}`
    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(userId).then(() => {
      if (cancelled) return
      channel = supabase
        .channel(`trade_activities:${userId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'trade_execution_logs', filter },
          schedule,
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'trade_execution_logs', filter },
          schedule,
        )
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR') {
            console.warn('[management] realtime subscription error')
          }
        })
    })

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [userId])
}
