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
import { hasTrialExpired as subscriptionHasTrialExpired } from '../lib/subscriptionCta'

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
  created_at: string
}

export interface SubscriptionUsage {
  brokerAccounts: number
  telegramChannels: number
  backtestsThisMonth: number
}

interface SubscriptionContextValue {
  subscription: Subscription | null
  loading: boolean
  /** Subscription row fetch only (excludes profile loading). */
  subscriptionLoading: boolean
  isAdmin: boolean
  usage: SubscriptionUsage
  usageLoading: boolean
  hasActiveSubscription: boolean
  isPastDue: boolean
  /** User previously had a trial period (expired or converted); show Purchase Subscription. */
  hasTrialExpired: boolean
  effectivePlan: SubscriptionPlan | null
  limits: PlanLimitsSnapshot
  planName: string
  refresh: () => Promise<void>
  requireSubscription: () => boolean
  openUpgrade: (target?: 'advanced') => void
  openPricingModal: () => void
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

const CHECKOUT_SYNC_PENDING_KEY = 'tscopier.checkout.sync.pending'

const SubscriptionContext = createContext<SubscriptionContextValue>({
  subscription: null,
  loading: true,
  subscriptionLoading: true,
  isAdmin: false,
  usage: emptyUsage,
  usageLoading: true,
  hasActiveSubscription: false,
  isPastDue: false,
  hasTrialExpired: false,
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
  openPricingModal: () => {},
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

function scrollToPricingTop() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { isAdmin, loading: profileLoading } = useUserProfile()
  const userId = user?.id ?? null
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [usage, setUsage] = useState<SubscriptionUsage>(emptyUsage)
  const [usageLoading, setUsageLoading] = useState(true)

  const fetchSubscription = useCallback(async (options?: { background?: boolean }) => {
    if (!userId) {
      setSubscription(null)
      setLoading(false)
      setUsage(emptyUsage)
      setUsageLoading(false)
      return
    }

    const background = options?.background ?? false
    if (!background) {
      setLoading(true)
      setUsageLoading(true)
    }
    const monthStart = monthStartUtcIso()

    const [{ data }, usageResults] = await Promise.all([
      supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
      Promise.all([
        supabase
          .from('broker_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .not('fxsocket_account_id', 'is', null)
          .neq('fxsocket_account_id', ''),
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
    if (params.get('checkout') === 'success') {
      window.sessionStorage.setItem(CHECKOUT_SYNC_PENDING_KEY, '1')
      void fetchSubscription({ background: true })
      params.delete('checkout')
    }
    const qs = params.toString()
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState({}, '', next)
    }
  }, [fetchSubscription])

  useEffect(() => {
    if (!userId) return
    if (window.sessionStorage.getItem(CHECKOUT_SYNC_PENDING_KEY) !== '1') return

    let done = false
    const markDone = () => {
      done = true
      window.sessionStorage.removeItem(CHECKOUT_SYNC_PENDING_KEY)
    }
    const runRefresh = () => {
      if (done) return
      void fetchSubscription({ background: true })
    }
    const completeRefresh = () => {
      runRefresh()
      markDone()
    }

    const interactionEvents: Array<keyof WindowEventMap> = ['focus', 'pointerdown', 'keydown']
    for (const evt of interactionEvents) {
      window.addEventListener(evt, completeRefresh, { once: true })
    }

    const retryTimers = [2000, 6000, 12000].map(delay =>
      window.setTimeout(runRefresh, delay),
    )
    const clearTimer = window.setTimeout(markDone, 20_000)

    return () => {
      for (const evt of interactionEvents) {
        window.removeEventListener(evt, completeRefresh)
      }
      retryTimers.forEach(window.clearTimeout)
      window.clearTimeout(clearTimer)
    }
  }, [fetchSubscription, userId])

  const openPricingPage = useCallback(() => {
    if (window.location.pathname === '/pricing') {
      scrollToPricingTop()
      return
    }
    navigate('/pricing')
  }, [navigate])

  const hasActiveSubscription = isAdmin || isSubscriptionActive(subscription?.status)
  const isPastDue = !isAdmin && subscription?.status === 'past_due'
  const hasTrialExpired =
    !isAdmin && !hasActiveSubscription && subscriptionHasTrialExpired(subscription?.trial_ends_at)
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
    openPricingPage()
    return false
  }, [hasActiveSubscription, openPricingPage])

  const openUpgrade = useCallback(
    (_target?: 'advanced') => {
      openPricingPage()
    },
    [openPricingPage],
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
        subscriptionLoading: loading,
        isAdmin,
        usage,
        usageLoading,
        hasActiveSubscription,
        isPastDue,
        hasTrialExpired,
        effectivePlan: activePlan,
        limits,
        planName,
        refresh: () => fetchSubscription({ background: true }),
        requireSubscription,
        openUpgrade,
        openPricingModal: openPricingPage,
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
