import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { supabase } from '../lib/supabase'
import { whenRealtimeReady } from '../lib/whenRealtimeReady'
import type { BrokerAccount } from '../types/database'
import { sortBrokerAccountsNewestFirst } from '../lib/brokerAccountSelect'

/** Keep broker list in sync when the worker or edge function updates broker_accounts. */
export function useBrokerAccountsRealtime(
  userId: string | undefined,
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>,
): void {
  useEffect(() => {
    if (!userId) return

    let cancelled = false
    let channel: ReturnType<typeof supabase.channel> | null = null

    void whenRealtimeReady(userId).then(() => {
      if (cancelled) return
      channel = supabase
        .channel(`broker_accounts:${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'broker_accounts', filter: `user_id=eq.${userId}` },
          payload => {
            if (payload.eventType === 'DELETE') {
              const id = (payload.old as { id?: string }).id
              if (!id) return
              setBrokers(prev => prev.filter(b => b.id !== id))
              return
            }
            const row = payload.new as BrokerAccount | null
            if (!row?.id) return
            setBrokers(prev => {
              const idx = prev.findIndex(b => b.id === row.id)
              if (payload.eventType === 'INSERT') {
                if (idx >= 0) {
                  return prev.map(b => (b.id === row.id ? { ...b, ...row } : b))
                }
                return sortBrokerAccountsNewestFirst([...prev, row])
              }
              if (idx < 0) return prev
              return prev.map(b => (b.id === row.id ? { ...b, ...row } : b))
            })
          },
        )
        .subscribe(status => {
          if (status === 'CHANNEL_ERROR') {
            console.warn('[broker_accounts] realtime subscription error')
          }
        })
    })

    return () => {
      cancelled = true
      if (channel) void supabase.removeChannel(channel)
    }
  }, [userId, setBrokers])
}
