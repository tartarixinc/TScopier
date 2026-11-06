import { useMemo } from 'react'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { useSubscription } from '../context/SubscriptionContext'
import { isBrokerSessionConnected } from '../lib/brokerReconnect'
import { resolveCopierStartBlocked, type CopierStartBlockedReason } from '../lib/copierStartBlocked'

export function useCopierStartBlocked() {
  const { hasActiveSubscription, loading: subscriptionLoading } = useSubscription()
  const { brokers, loading: brokersLoading } = useBrokerAccounts()

  const resolving = subscriptionLoading || brokersLoading

  const hasConnectedBroker = useMemo(
    () => brokers.some(b => b.is_active !== false && isBrokerSessionConnected(b)),
    [brokers],
  )

  const { blocked, reason } = useMemo(
    () => resolveCopierStartBlocked({
      hasActiveSubscription,
      hasConnectedBroker,
    }),
    [hasActiveSubscription, hasConnectedBroker],
  )

  return {
    copierStartBlocked: blocked,
    copierStartBlockedReason: reason as CopierStartBlockedReason | null,
    resolving,
  }
}
