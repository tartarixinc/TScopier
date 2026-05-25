import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { supabase } from '../lib/supabase'
import type { BrokerAccount } from '../types/database'
import { metatraderApi } from '../lib/metatraderapi'

const RECONNECT_DEBOUNCE_MS = 3_000

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
 * that immediately on the broker list and trigger a silent reconnect attempt.
 */
export function useBrokerSessionFailureRealtime(
  userId: string | undefined,
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>,
  options?: { silentReconnect?: boolean },
): void {
  const reconnectTimeouts = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const silentReconnect = options?.silentReconnect !== false

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

          if (silentReconnect && !reconnectTimeouts.current.has(brokerId)) {
            const timeout = setTimeout(async () => {
              reconnectTimeouts.current.delete(brokerId)
              try {
                const result = await metatraderApi.reconnect(brokerId)
                if (result.connection_status === 'connected') {
                  setBrokers(prev =>
                    prev.map(b => {
                      if (b.id !== brokerId) return b
                      return {
                        ...b,
                        connection_status: 'connected' as const,
                        last_synced_at: new Date().toISOString(),
                        ...(result.summary
                          ? {
                              last_balance: result.summary.balance ?? b.last_balance,
                              last_equity: result.summary.equity ?? b.last_equity,
                              last_currency: result.summary.currency ?? b.last_currency,
                            }
                          : {}),
                      }
                    }),
                  )
                }
              } catch {
                // Silent — periodic reconnect loop will handle retries
              }
            }, RECONNECT_DEBOUNCE_MS)
            reconnectTimeouts.current.set(brokerId, timeout)
          }
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
      for (const t of reconnectTimeouts.current.values()) clearTimeout(t)
      reconnectTimeouts.current.clear()
    }
  }, [userId, setBrokers, silentReconnect])
}
