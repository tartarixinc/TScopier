import { useEffect, useMemo } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { fxsocketBroker } from '../../lib/fxsocketBroker'

/** Poll refresh_summary for accounts still linking (must render under BrokerAccountsProvider). */
export function PendingBrokerConnectionSync() {
  const { user } = useAuth()
  const { brokers, upsertBroker } = useBrokerAccounts()

  const pendingBrokerKey = useMemo(
    () => brokers
      .filter(b => b.connection_status === 'pending' || b.fxsocket_status === 'connecting')
      .map(b => b.id)
      .sort()
      .join(','),
    [brokers],
  )

  useEffect(() => {
    if (!pendingBrokerKey || !user?.id) return

    let cancelled = false
    const syncPending = async () => {
      for (const id of pendingBrokerKey.split(',')) {
        if (cancelled || !id) continue
        try {
          const { account } = await fxsocketBroker.refreshSummary(id)
          if (cancelled) return
          upsertBroker(account)
        } catch {
          // Terminal still starting — next interval retries.
        }
      }
    }

    void syncPending()
    const timer = window.setInterval(() => void syncPending(), 2_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [pendingBrokerKey, upsertBroker, user?.id])

  return null
}
