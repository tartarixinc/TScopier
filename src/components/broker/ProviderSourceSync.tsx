import { useEffect } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { fxsocketBroker } from '../../lib/fxsocketBroker'
import { resolveProvider } from '../../lib/brokerLink'
import { supabase } from '../../lib/supabase'

/** Directory performance is only shown while the source sync is under 15 minutes old. */
const PROVIDER_SYNC_INTERVAL_MS = 5 * 60_000

/**
 * Keeps a provider's published source accounts freshly synced while the app is open, so their
 * public profile (win rate, trade counts, balance, equity) stays available instead of "stale".
 * Must render under BrokerAccountsProvider.
 */
export function ProviderSourceSync() {
  const { user } = useAuth()
  const { brokers, upsertBroker } = useBrokerAccounts()
  const hasBrokers = brokers.length > 0

  useEffect(() => {
    if (!user?.id || !hasBrokers) return
    let cancelled = false
    const sync = async () => {
      const { data, error } = await supabase
        .from('social_copy_sources')
        .select('broker_account_id')
        .eq('trader_user_id', user.id)
        .eq('status', 'published')
      if (error || cancelled) return
      for (const row of data ?? []) {
        const broker = brokers.find(item => item.id === row.broker_account_id)
        if (!broker || cancelled) continue
        try {
          const { account } = await fxsocketBroker.refreshSummary(broker.id, resolveProvider(broker))
          if (!cancelled) upsertBroker(account)
        } catch {
          // Terminal unreachable — the next interval retries.
        }
      }
    }
    void sync()
    const timer = window.setInterval(() => void sync(), PROVIDER_SYNC_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // Re-run only when the signed-in user or the presence of brokers changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, hasBrokers, upsertBroker])

  return null
}
