import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'
import type { BrokerAccount } from '../types/database'

const DEBOUNCE_MS = 450

const BROKER_LIGHT_FIELDS = new Set([
  'fxsocket_status',
  'connection_status',
  'connection_error',
  'last_synced_at',
  'last_balance',
  'last_equity',
  'last_currency',
  'terminal_connected',
  'trade_allowed',
  'updated_at',
])

function isBrokerLightweightUpdate(
  oldRow: Record<string, unknown> | undefined,
  newRow: Record<string, unknown>,
): boolean {
  if (!oldRow) return false
  for (const key of Object.keys(newRow)) {
    if (BROKER_LIGHT_FIELDS.has(key)) continue
    if (JSON.stringify(oldRow[key]) !== JSON.stringify(newRow[key])) return false
  }
  return true
}

/**
 * Subscribe to Supabase Realtime for tables that drive dashboard stats.
 * Debounces bursts into a single quiet refresh.
 */
export function useDashboardRealtime(
  userId: string | undefined,
  onDataChange: () => void,
  onBrokerPatch?: (broker: BrokerAccount) => void,
): void {
  const onChangeRef = useRef(onDataChange)
  onChangeRef.current = onDataChange
  const onBrokerPatchRef = useRef(onBrokerPatch)
  onBrokerPatchRef.current = onBrokerPatch

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
        .channel(`dashboard_realtime:${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'trades', filter },
          schedule,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'signals', filter },
          schedule,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'broker_accounts', filter },
          payload => {
            if (
              payload.eventType === 'UPDATE'
              && onBrokerPatchRef.current
              && isBrokerLightweightUpdate(
                payload.old as Record<string, unknown> | undefined,
                payload.new as Record<string, unknown>,
              )
            ) {
              onBrokerPatchRef.current(payload.new as BrokerAccount)
              return
            }
            schedule()
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'telegram_channels', filter },
          schedule,
        )
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR') {
            console.warn('[dashboard] realtime subscription error')
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
