import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from './AuthContext'
import { useUserProfile } from './UserProfileContext'
import {
  canUseFeature,
  effectivePlan,
  isSubscriptionActive,
  maxBacktestsPerMonth,
  maxBrokerAccounts,
  maxTelegramChannels,
  planLimitsSnapshot,
  type PlanFeatureKey,
  type PlanLimitsSnapshot,
  type SubscriptionPlan,
} from '../lib/planLimits'

export interface Subscription {
  id: string
  user_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  plan: SubscriptionPlan
  status: 'active' | 'trialing' | 'canceled' | 'past_due' | 'incomplete'
  extra_accounts: number
  trial_ends_at: string | null
  current_period_end: string | null
}

export interface SubscriptionUsage {
  brokerAccounts: number
  telegramChannels: number
  backtestsThisMonth: number
}

interface SubscriptionContextValue {
  subscription: Subscription | null
  loading: boolean
  isAdmin: boolean
  usage: SubscriptionUsage
  usageLoading: boolean
  hasActiveSubscription: boolean
  isPastDue: boolean
  effectivePlan: SubscriptionPlan | null
  limits: PlanLimitsSnapshot
  planName: string
  refresh: () => Promise<void>
  requireSubscription: () => boolean
  openUpgrade: (target?: 'advanced') => void
  canUseFeature: (feature: PlanFeatureKey) => boolean
  canAddBroker: () => boolean
  canAddChannel: () => boolean
  canRunBacktest: () => boolean
}

const emptyUsage: SubscriptionUsage = {
  brokerAccounts: 0,
  telegramChannels: 0,
  backtestsThisMonth: 0,
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
  subscription: null,
  loading: true,
  isAdmin: false,
  usage: emptyUsage,
  usageLoading: true,
  hasActiveSubscription: false,
  isPastDue: false,
  effectivePlan: null,
  limits: {
    maxBrokerAccounts: 0,
    maxTelegramChannels: 0,
    maxBacktestsPerMonth: 0,
    maxTpRows: 3,
  },
  planName: '',
  refresh: async () => {},
  requireSubscription: () => false,
  openUpgrade: () => {},
  canUseFeature: () => false,
  canAddBroker: () => false,
  canAddChannel: () => false,
  canRunBacktest: () => false,
})

function monthStartUtcIso(): string {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  return monthStart.toISOString()
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const { isAdmin, loading: profileLoading } = useUserProfile()
  const navigate = useNavigate()
  const userId = user?.id ?? null
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [usage, setUsage] = useState<SubscriptionUsage>(emptyUsage)
  const [usageLoading, setUsageLoading] = useState(true)

  const fetchSubscription = useCallback(async () => {
    if (!userId) {
      setSubscription(null)
      setLoading(false)
      setUsage(emptyUsage)
      setUsageLoading(false)
      return
    }

    setLoading(true)
    setUsageLoading(true)
    const monthStart = monthStartUtcIso()

    const [{ data }, usageResults] = await Promise.all([
      supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
      Promise.all([
        supabase
          .from('broker_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('is_active', true),
        supabase
          .from('telegram_channels')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId),
        supabase
          .from('backtest_runs')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .gte('created_at', monthStart),
      ]),
    ])

    setSubscription(data as Subscription | null)
    setUsage({
      brokerAccounts: usageResults[0].count ?? 0,
      telegramChannels: usageResults[1].count ?? 0,
      backtestsThisMonth: usageResults[2].count ?? 0,
    })
    setLoading(false)
    setUsageLoading(false)
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setSubscription(null)
      setLoading(false)
      setUsage(emptyUsage)
      setUsageLoading(false)
      return
    }
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

  const hasActiveSubscription = isAdmin || isSubscriptionActive(subscription?.status)
  const isPastDue = !isAdmin && subscription?.status === 'past_due'
  const activePlan: SubscriptionPlan | null = isAdmin
    ? 'advanced'
    : effectivePlan(subscription?.plan, subscription?.status)

  const limits = useMemo(
    () =>
      isAdmin
        ? planLimitsSnapshot('advanced', 'active', 95)
        : planLimitsSnapshot(subscription?.plan, subscription?.status, subscription?.extra_accounts ?? 0),
    [subscription, isAdmin],
  )

  const planName = isAdmin
    ? 'Admin'
    : subscription
      ? subscription.plan === 'advanced'
        ? 'Advanced'
        : 'Basic'
      : ''

  const requireSubscription = useCallback(() => {
    if (hasActiveSubscription) return true
    navigate('/pricing')
    return false
  }, [hasActiveSubscription, navigate])

  const openUpgrade = useCallback(
    (_target?: 'advanced') => {
      navigate('/pricing')
    },
    [navigate],
  )

  const canUseFeatureFn = useCallback(
    (feature: PlanFeatureKey) =>
      isAdmin || canUseFeature(subscription?.plan, subscription?.status, feature),
    [isAdmin, subscription],
  )

  const canAddBroker = useCallback(() => {
    if (isAdmin) return true
    if (!activePlan) return false
    const limit = maxBrokerAccounts(activePlan, subscription?.extra_accounts ?? 0)
    return usage.brokerAccounts < limit
  }, [isAdmin, activePlan, subscription?.extra_accounts, usage.brokerAccounts])

  const canAddChannel = useCallback(() => {
    if (isAdmin) return true
    if (!activePlan) return false
    const limit = maxTelegramChannels(activePlan)
    if (limit == null) return true
    return usage.telegramChannels < limit
  }, [isAdmin, activePlan, usage.telegramChannels])

  const canRunBacktest = useCallback(() => {
    if (isAdmin) return true
    if (!activePlan) return false
    const limit = maxBacktestsPerMonth(activePlan)
    if (limit == null) return true
    return usage.backtestsThisMonth < limit
  }, [isAdmin, activePlan, usage.backtestsThisMonth])

  return (
    <SubscriptionContext.Provider
      value={{
        subscription,
        loading: loading || profileLoading,
        isAdmin,
        usage,
        usageLoading,
        hasActiveSubscription,
        isPastDue,
        effectivePlan: activePlan,
        limits,
        planName,
        refresh: fetchSubscription,
        requireSubscription,
        openUpgrade,
        canUseFeature: canUseFeatureFn,
        canAddBroker,
        canAddChannel,
        canRunBacktest,
      }}
    >
      {children}
    </SubscriptionContext.Provider>
  )
}

export const useSubscription = () => useContext(SubscriptionContext)
