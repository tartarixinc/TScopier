import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'

export interface Subscription {
  id: string
  user_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  plan: 'basic' | 'advanced'
  status: 'active' | 'trialing' | 'canceled' | 'past_due' | 'incomplete'
  extra_accounts: number
  trial_ends_at: string | null
  current_period_end: string | null
}

interface SubscriptionContextValue {
  subscription: Subscription | null
  loading: boolean
  hasActiveSubscription: boolean
  planName: string
  refresh: () => Promise<void>
  requireSubscription: () => boolean
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
  subscription: null,
  loading: true,
  hasActiveSubscription: false,
  planName: '',
  refresh: async () => {},
  requireSubscription: () => false,
})

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchSubscription = useCallback(async () => {
    if (!userId) {
      setSubscription(null)
      setLoading(false)
      return
    }

    const { data } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    setSubscription(data as Subscription | null)
    setLoading(false)
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setSubscription(null)
      setLoading(false)
      return
    }
    setLoading(true)
    void fetchSubscription()
  }, [userId, fetchSubscription])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') !== 'success') return
    void fetchSubscription()
    params.delete('checkout')
    const qs = params.toString()
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    window.history.replaceState({}, '', next)
  }, [fetchSubscription])

  const hasActiveSubscription =
    subscription?.status === 'active' || subscription?.status === 'trialing'

  const planName = subscription
    ? subscription.plan === 'advanced' ? 'Advanced' : 'Basic'
    : ''

  const requireSubscription = useCallback(() => {
    if (hasActiveSubscription) return true
    window.location.href = '/pricing'
    return false
  }, [hasActiveSubscription])

  return (
    <SubscriptionContext.Provider
      value={{ subscription, loading, hasActiveSubscription, planName, refresh: fetchSubscription, requireSubscription }}
    >
      {children}
    </SubscriptionContext.Provider>
  )
}

export const useSubscription = () => useContext(SubscriptionContext)
