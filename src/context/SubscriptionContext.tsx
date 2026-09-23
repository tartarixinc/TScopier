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
  BACKTEST_QUOTA_RUN_MODE,
  maxBacktestsPerMonth,
  maxBrokerAccounts,
  maxTelegramChannels,
  planLimitsSnapshot,
  type PlanFeatureKey,
  type PlanLimitsSnapshot,
  type SubscriptionPlan,
} from '../lib/planLimits'
import { hasTrialExpired as subscriptionHasTrialExpired } from '../lib/subscriptionCta'
import { clearPendingPlanSelection } from '../lib/pendingPlanSelection'
import { confirmCheckoutSession } from '../lib/confirmCheckout'

export interface Subscription {
  id: string
  user_id: string
  stripe_customer_id: string
  stripe_subscription_id: string | null
  plan: SubscriptionPlan
  status: 'active' | 'trialing' | 'canceled' | 'past_due' | 'incomplete' | 'incomplete_expired'
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
  /** True while waiting for Stripe webhook after checkout=success. */
  checkoutSyncPending: boolean
  isPastDue: boolean
  /** Trial calendar end is in the past (even if Stripe status is still stuck as trialing). */
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

function readCheckoutSyncPending(): boolean {
  try {
    return window.sessionStorage.getItem(CHECKOUT_SYNC_PENDING_KEY) === '1'
  } catch {
    return false
  }
}

function writeCheckoutSyncPending(pending: boolean): void {
  try {
    if (pending) window.sessionStorage.setItem(CHECKOUT_SYNC_PENDING_KEY, '1')
    else window.sessionStorage.removeItem(CHECKOUT_SYNC_PENDING_KEY)
  } catch {
    // ignore
  }
}

const SubscriptionContext = createContext<SubscriptionContextValue>({
  subscription: null,
  loading: true,
  subscriptionLoading: true,
  isAdmin: false,
  usage: emptyUsage,
  usageLoading: true,
  hasActiveSubscription: false,
  checkoutSyncPending: false,
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
  const { user, loading: authLoading } = useAuth()
  const { isAdmin, loading: profileLoading } = useUserProfile()
  const userId = user?.id ?? null
  const [subscription, setSubscription] = useState<Subscription | null>(null)
  /** Last user id for which subscription + usage fetch completed (prevents no-plan flash on sign-in). */
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null)
  const [usage, setUsage] = useState<SubscriptionUsage>(emptyUsage)
  const [usageLoading, setUsageLoading] = useState(true)
  const [checkoutSyncPending, setCheckoutSyncPending] = useState(readCheckoutSyncPending)

  const subscriptionLoading =
    authLoading || (userId != null && resolvedUserId !== userId)

  const fetchSubscription = useCallback(async (options?: { background?: boolean }) => {
    if (!userId) {
      setSubscription(null)
      setResolvedUserId(null)
      setUsage(emptyUsage)
      setUsageLoading(false)
      return
    }

    const background = options?.background ?? false
    if (!background) setUsageLoading(true)
    const monthStart = monthStartUtcIso()

    const [{ data }, usageResults] = await Promise.all([
      supabase.from('subscriptions').select('*').eq('user_id', userId).maybeSingle(),
      Promise.all([
        supabase
          .from('broker_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('is_active', true)
          .or('fxsocket_account_id.not.is.null,and(provider.eq.mtapi,mtapi_status.not.is.null)'),
        supabase
          .from('telegram_channels')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('is_active', true),
        supabase
          .from('backtest_runs')
          .select('id', { count: 'exact', head: true })
          .eq('user_id', userId)
          .eq('config->>runMode', BACKTEST_QUOTA_RUN_MODE)
          .gte('created_at', monthStart),
      ]),
    ])

    setSubscription(data as Subscription | null)
    setUsage({
      brokerAccounts: usageResults[0].count ?? 0,
      telegramChannels: usageResults[1].count ?? 0,
      backtestsThisMonth: usageResults[2].count ?? 0,
    })
    setResolvedUserId(userId)
    setUsageLoading(false)
  }, [userId])

  useEffect(() => {
    if (!userId) {
      setSubscription(null)
      setResolvedUserId(null)
      setUsage(emptyUsage)
      setUsageLoading(authLoading)
      return
    }
    void fetchSubscription()
  }, [userId, fetchSubscription, authLoading])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') === 'success') {
      writeCheckoutSyncPending(true)
      setCheckoutSyncPending(true)
      clearPendingPlanSelection()
      const sessionId = params.get('session_id')
      params.delete('checkout')
      // Keep session_id until confirm-checkout runs (stripped below after kickoff).
      void (async () => {
        try {
          const { data: sessionData } = await supabase.auth.getSession()
          const accessToken = sessionData.session?.access_token
          if (accessToken) {
            await confirmCheckoutSession({ accessToken, sessionId })
          }
        } catch {
          // Polling below still retries confirm + fetch.
        }
        await fetchSubscription({ background: true })
      })()
      if (sessionId) params.delete('session_id')
    }
    const qs = params.toString()
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState({}, '', next)
    }
  }, [fetchSubscription])

  const hasActiveSubscription =
    isAdmin || isSubscriptionActive(subscription?.status, subscription?.trial_ends_at)

  // Clear checkout grace once entitlement is live; keep paywall open until then.
  useEffect(() => {
    if (!checkoutSyncPending) return
    if (!hasActiveSubscription) return
    writeCheckoutSyncPending(false)
    setCheckoutSyncPending(false)
  }, [checkoutSyncPending, hasActiveSubscription])

  useEffect(() => {
    if (!userId) return
    if (!checkoutSyncPending && !readCheckoutSyncPending()) return

    let done = false
    const markDone = () => {
      if (done) return
      done = true
      writeCheckoutSyncPending(false)
      setCheckoutSyncPending(false)
    }
    const runRefresh = () => {
      if (done) return
      void (async () => {
        try {
          const { data: sessionData } = await supabase.auth.getSession()
          const accessToken = sessionData.session?.access_token
          if (accessToken) {
            await confirmCheckoutSession({ accessToken })
          }
        } catch {
          // Keep polling local row.
        }
        await fetchSubscription({ background: true })
      })()
    }

    const interactionEvents: Array<keyof WindowEventMap> = ['focus', 'pointerdown', 'keydown']
    for (const evt of interactionEvents) {
      window.addEventListener(evt, runRefresh)
    }

    const retryTimers = [1500, 3000, 6000, 10000, 15000].map(delay =>
      window.setTimeout(runRefresh, delay),
    )
    // Stop grace after 45s even if sync never lands (user can retry from billing).
    const clearTimer = window.setTimeout(markDone, 45_000)

    return () => {
      for (const evt of interactionEvents) {
        window.removeEventListener(evt, runRefresh)
      }
      retryTimers.forEach(window.clearTimeout)
      window.clearTimeout(clearTimer)
    }
  }, [fetchSubscription, userId, checkoutSyncPending])

  // If paywall raced to /pricing before webhook sync, bounce back to dashboard.
  useEffect(() => {
    if (!checkoutSyncPending) return
    if (window.location.pathname !== '/pricing') return
    navigate('/dashboard', { replace: true })
  }, [checkoutSyncPending, navigate])

  // One-shot self-heal: paid users with a missing/incomplete local row (e.g. staging
  // without a Stripe webhook) pull entitlement from Stripe after login.
  useEffect(() => {
    if (!userId || subscriptionLoading || authLoading) return
    if (isAdmin) return
    const status = subscription?.status
    const placeholderCustomer =
      Boolean(subscription?.stripe_customer_id?.startsWith('cus_staging_pending')) ||
      Boolean(subscription?.stripe_subscription_id?.startsWith('sub_staging_pending'))
    const shouldHeal =
      placeholderCustomer ||
      !hasActiveSubscription &&
        (!subscription || status === 'incomplete' || status === 'incomplete_expired')
    if (!shouldHeal && !readCheckoutSyncPending()) return
    const healKey = `tscopier.entitlement.heal.${userId}`
    try {
      if (window.sessionStorage.getItem(healKey) === '1') return
      window.sessionStorage.setItem(healKey, '1')
    } catch {
      // ignore
    }
    void (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession()
        const accessToken = sessionData.session?.access_token
        if (!accessToken) return
        await confirmCheckoutSession({ accessToken })
        await fetchSubscription({ background: true })
      } catch {
        // ignore — user can retry from billing / checkout
      }
    })()
  }, [
    userId,
    subscriptionLoading,
    authLoading,
    isAdmin,
    hasActiveSubscription,
    subscription,
    fetchSubscription,
  ])

  const openPricingPage = useCallback(() => {
    if (window.location.pathname === '/pricing') {
      scrollToPricingTop()
      return
    }
    navigate('/pricing')
  }, [navigate])

  const isPastDue = !isAdmin && subscription?.status === 'past_due'
  // Date-aware: stuck `trialing` after trial_ends_at is inactive, so this becomes true.
  const hasTrialExpired =
    !isAdmin && !hasActiveSubscription && subscriptionHasTrialExpired(subscription?.trial_ends_at)
  const activePlan: SubscriptionPlan | null = isAdmin
    ? 'advanced'
    : effectivePlan(subscription?.plan, subscription?.status, subscription?.trial_ends_at)

  const limits = useMemo(
    () =>
      isAdmin
        ? planLimitsSnapshot('advanced', 'active', 95)
        : planLimitsSnapshot(
            subscription?.plan,
            subscription?.status,
            subscription?.extra_accounts ?? 0,
            subscription?.trial_ends_at,
          ),
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
      isAdmin ||
      canUseFeature(
        subscription?.plan,
        subscription?.status,
        feature,
        subscription?.trial_ends_at,
      ),
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
        loading: subscriptionLoading || profileLoading,
        subscriptionLoading,
        isAdmin,
        usage,
        usageLoading,
        hasActiveSubscription,
        checkoutSyncPending,
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
