import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { supabase } from '../lib/supabase'
import type { BrokerAccount } from '../types/database'

function isSessionDisconnectLog(row: {
  action?: string
  status?: string
  error_message?: string | null
  request_payload?: Record<string, unknown> | null
}): boolean {
  if (row.action !== 'order_send') return false
  if (row.status === 'failed') {
    const msg = String(row.error_message ?? '').toLowerCase()
    return msg.includes('not connected') || msg.includes('session is not connected')
  }
  if (row.status === 'skipped') {
    const payload = row.request_payload ?? {}
    const reason = String(payload.skip_reason ?? '').toLowerCase()
    return reason === 'broker_session_not_connected'
  }
  return false
}

/**
 * When the worker logs an order failure/skip due to a dead MT session, reflect
 * that immediately on the broker list (don't wait for the next health poll).
 */
export function useBrokerSessionFailureRealtime(
  userId: string | undefined,
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>,
): void {
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`broker_session_failures:${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'trade_execution_logs',
          filter: `user_id=eq.${userId}`,
        },
        payload => {
          const row = payload.new as {
            action?: string
            status?: string
            error_message?: string | null
            broker_account_id?: string
            request_payload?: Record<string, unknown> | null
          }
          if (!isSessionDisconnectLog(row)) return
          const brokerId = row.broker_account_id
          if (!brokerId) return
          setBrokers(prev =>
            prev.map(b =>
              b.id === brokerId ? { ...b, connection_status: 'error' as const } : b,
            ),
          )
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [userId, setBrokers])
}
