import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, CheckCircle2, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Alert } from '../ui/Alert'
import { SlaveConfigureModal } from '../configure/SlaveConfigureModal'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useAuth } from '../../context/AuthContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { getBrokerDisplayLabel } from '../../lib/brokerChannelLink'
import { normalizeCopyRisk, type CopyRiskSettings } from '../../lib/copyRiskTypes'
import type { BrokerAccount } from '../../types/database'
import {
  changeSocialCopySubscription,
  createSocialCopySubscription,
  fetchPlatformFeeSettings,
  fetchSocialCopyBillingForProvider,
  isActiveSocialCopyBilling,
  socialCopyChargeBreakdown,
  socialSizingColumnsFromCopyRisk,
  startSocialCopyCheckout,
} from '../../lib/socialCopy'
import { DEFAULT_SOCIAL_COPY_FILTER_SETTINGS } from '../../lib/socialCopyFilterSettings'
import { copyRiskLabelsForSocial, socialCopySetupToMirrorSetup } from '../../lib/socialCopySetupLabels'
import { isSocialDestinationEligible, resolveSocialAccountMode } from '../../lib/socialAccount'
import { sourceAllowsCopy } from '../../lib/socialCopyAvailability'
import { eligibilityDiagnosticForReason } from '../../lib/socialEligibility'
import type { SocialTrader } from '../../lib/socialTradingFixture'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import { supabase } from '../../lib/supabase'

function isPaidCopyPrice(cents: number | null | undefined): boolean {
  return cents != null && cents > 0
}

function accountRouteLabel(account: BrokerAccount): string {
  const broker = account.broker_name?.trim() || getBrokerDisplayLabel(account)
  return `${broker} ${account.platform.toUpperCase()}`
}

function checkoutReturnState(): { success: boolean; providerId: string | null } {
  if (typeof window === 'undefined') return { success: false, providerId: null }
  const params = new URLSearchParams(window.location.search)
  const flag = params.get('social_copy_checkout')
  return {
    success: flag === 'success',
    providerId: params.get('provider'),
  }
}

export function CopyTraderModal({
  trader,
  copy,
  onClose,
  onConnectBroker,
}: {
  trader: SocialTrader
  copy: SocialTradingPageTranslations
  onClose: () => void
  onConnectBroker: () => void
}) {
  const c = copy.copySetup
  const t = useT()
  const { session } = useAuth()
  const { brokers, loading } = useBrokerAccounts()
  const { formatMoney } = useFormatMoney()
  const [selectedBrokerId, setSelectedBrokerId] = useState('')
  const [settings, setSettings] = useState<CopyRiskSettings>(() => normalizeCopyRisk({
    sizing: {
      mode: trader.syntheticDemo ? 'fixed_lot' : 'balance_ratio',
      fixed_lot: 0.1,
      lot_multiplier: 0.75,
      balance_multiplier: 1,
      max_lot: 0.1,
    },
  }))
  const [symbolMap, setSymbolMap] = useState<Record<string, string>>({})
  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null)
  const [subscriptionState, setSubscriptionState] = useState<'pending' | 'pause_requested' | 'stop_requested'>('pending')
  const pricePaid = isPaidCopyPrice(trader.monthlyCopyPriceCents)
  const [paywallCleared, setPaywallCleared] = useState(!pricePaid)
  const [billingChecking, setBillingChecking] = useState(pricePaid)
  const [copierFeePercent, setCopierFeePercent] = useState(0)

  const destinations = brokers.filter(isSocialDestinationEligible)
  useEffect(() => {
    if (selectedBrokerId || destinations.length !== 1) return
    setSelectedBrokerId(destinations[0].id)
  }, [destinations, selectedBrokerId])

  useEffect(() => {
    if (!pricePaid) {
      setCopierFeePercent(0)
      return
    }
    let active = true
    void fetchPlatformFeeSettings(supabase)
      .then(fees => {
        if (active) setCopierFeePercent(fees.copierFeePercent)
      })
      .catch(() => {
        if (active) setCopierFeePercent(0)
      })
    return () => { active = false }
  }, [pricePaid])

  useEffect(() => {
    if (!pricePaid) {
      setPaywallCleared(true)
      setBillingChecking(false)
      return
    }
    let active = true
    const returned = checkoutReturnState()
    const shouldPoll = returned.success && (!returned.providerId || returned.providerId === trader.id)

    const confirmBilling = async () => {
      setBillingChecking(true)
      setError(null)
      try {
        for (let attempt = 0; attempt < (shouldPoll ? 12 : 1); attempt += 1) {
          const billing = await fetchSocialCopyBillingForProvider(supabase, trader.id)
          if (!active) return
          if (isActiveSocialCopyBilling(billing)) {
            setPaywallCleared(true)
            setBillingChecking(false)
            if (shouldPoll && typeof window !== 'undefined') {
              const url = new URL(window.location.href)
              url.searchParams.delete('social_copy_checkout')
              url.searchParams.delete('provider')
              url.searchParams.delete('session_id')
              window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
            }
            return
          }
          if (!shouldPoll) break
          await new Promise(resolve => setTimeout(resolve, 1500))
        }
        if (active) {
          setPaywallCleared(false)
          setBillingChecking(false)
          if (shouldPoll) {
            setError('Payment is still confirming. If you were charged, wait a moment and try again.')
          }
        }
      } catch (cause) {
        if (active) {
          setBillingChecking(false)
          setError(cause instanceof Error ? cause.message : 'Unable to confirm copy billing.')
        }
      }
    }

    void confirmBilling()
    return () => { active = false }
  }, [pricePaid, trader.id])

  const sources = trader.sources?.length ? trader.sources : trader.sourceId ? [{
    sourceId: trader.sourceId,
    label: trader.sourceLabel ?? 'Copy source',
    provider: trader.sourceProvider ?? 'fxsocket',
    platform: trader.sourcePlatform ?? 'MT5',
    accountHint: 'Identifier unavailable',
    accountMode: trader.sourceAccountMode ?? 'unknown',
    connectionHealthy: true,
    isCopyEligible: trader.copyEligible === true,
    eligibilityReason: trader.copyEligibilityReason ?? 'source_missing',
    eligibilityDiagnostics: [eligibilityDiagnosticForReason(trader.copyEligibilityReason ?? 'source_missing')],
    isSynthetic: trader.syntheticDemo === true,
  }] : []
  // Always use the provider's registered copy account — no source picker in this modal.
  const selectedSource = (
    sources.find(source => source.isCopyEligible && source.sourceId === trader.sourceId)
    ?? sources.find(source => sourceAllowsCopy(source) && source.sourceId === trader.sourceId)
    ?? sources.find(source => sourceAllowsCopy(source))
    ?? null
  )
  const selectedBroker = destinations.find(broker => broker.id === selectedBrokerId) ?? null
  const isSyntheticSimulation = selectedSource?.isSynthetic === true
  const destinationMode = selectedBroker ? resolveSocialAccountMode(selectedBroker) : 'unknown'
  const showPaywall = pricePaid && !paywallCleared
  const charge = socialCopyChargeBreakdown(trader.monthlyCopyPriceCents ?? 0, copierFeePercent)
  const basePriceLabel = formatMoney(charge.baseCents / 100)
  const feePriceLabel = formatMoney(charge.feeCents / 100)
  const totalPriceLabel = formatMoney(charge.totalCents / 100)
  const priceLabel = totalPriceLabel
  const sizingPreview = socialSizingColumnsFromCopyRisk(settings)
  const profileLabel = settings.sizing.mode === 'fixed_lot'
    ? `${settings.sizing.fixed_lot.toFixed(2)} ${c.lots}`
    : settings.sizing.mode === 'lot_multiplier'
      ? `${settings.sizing.lot_multiplier.toFixed(2)}x`
      : c.proportionalProfile

  const submitCopy = async () => {
    if (!selectedBroker || !selectedSource || !sourceAllowsCopy(selectedSource) || destinationMode === 'unknown' || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      if (pricePaid) {
        const billing = await fetchSocialCopyBillingForProvider(supabase, trader.id)
        if (!isActiveSocialCopyBilling(billing)) {
          throw new Error('An active paid subscription is required before copying this provider')
        }
      }
      const sizing = socialSizingColumnsFromCopyRisk(settings)
      const createdSubscriptionId = await createSocialCopySubscription(supabase, {
        sourceId: selectedSource.sourceId,
        destinationBrokerAccountId: selectedBroker.id,
        sizingMode: sizing.sizingMode,
        fixedLot: sizing.fixedLot,
        lotMultiplier: sizing.lotMultiplier,
        maxLot: sizing.maxLot,
        accountMode: destinationMode,
        manualSettings: DEFAULT_SOCIAL_COPY_FILTER_SETTINGS,
        copyRisk: settings,
        symbolMap,
      })
      setSubscriptionId(createdSubscriptionId)
      setSubscriptionState('pending')
      setReady(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create the copy subscription.')
    } finally {
      setSubmitting(false)
    }
  }

  const requestSubscriptionChange = async (action: 'pause' | 'stop') => {
    if (!subscriptionId || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await changeSocialCopySubscription(supabase, subscriptionId, action)
      setSubscriptionState(action === 'pause' ? 'pause_requested' : 'stop_requested')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to update the copy subscription.')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmPaywallSubscribe = async () => {
    if (!pricePaid || paywallCleared || submitting) return
    const accessToken = session?.access_token
    if (!accessToken) {
      setError('Sign in again to subscribe.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const origin = window.location.origin
      const result = await startSocialCopyCheckout({
        accessToken,
        providerUserId: trader.id,
        successUrl: `${origin}/social-trading?site=app&social_copy_checkout=success&provider=${trader.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin}/social-trading?site=app&social_copy_checkout=cancel&provider=${trader.id}`,
      })
      if (result.kind === 'already_active') {
        setPaywallCleared(true)
        setSubmitting(false)
        return
      }
      window.location.assign(result.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to start Stripe Checkout.')
      setSubmitting(false)
    }
  }

  const disabled = !selectedBroker || !selectedSource || !sourceAllowsCopy(selectedSource) || destinationMode === 'unknown' || submitting

  if (ready && selectedBroker) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-trader-success-title"
      >
        <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={c.close} onClick={onClose} />
        <div className="relative w-full rounded-t-2xl border border-neutral-200/65 bg-white px-6 py-8 text-center shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-md sm:rounded-2xl">
          <button
            type="button"
            className="absolute right-4 top-4 rounded-lg p-2 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={c.close}
            onClick={onClose}
          >
            <X className="h-5 w-5" />
          </button>
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-green-400 dark:bg-teal-950/40 dark:text-teal-300">
            <CheckCircle2 className="h-7 w-7" aria-hidden />
          </span>
          <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-green-500 dark:text-teal-300">{isSyntheticSimulation ? 'SIMULATED DEMO \u2014 NO BROKER ORDERS' : c.previewLabel}</p>
          <h2 id="copy-trader-success-title" className="mt-1 text-xl font-semibold text-neutral-900 dark:text-neutral-50">{isSyntheticSimulation ? c.successTitle : 'Subscription request created'}</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-neutral-900 dark:text-neutral-50">
            {`Your request to copy ${trader.displayName} is persisted and pending worker acknowledgement. No active status is claimed until the worker confirms it.`}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-900 ring-1 ring-neutral-200/70 dark:bg-neutral-900 dark:text-neutral-100 dark:ring-neutral-800">
            <span>{trader.displayName}</span>
            <ArrowRight className="h-4 w-4 shrink-0 text-green-400 dark:text-green-400" aria-hidden />
            <span>{accountRouteLabel(selectedBroker)}</span>
          </div>
          {isSyntheticSimulation ? <Alert variant="warning">Synthetic simulation only. The worker will acknowledge the persisted lifecycle state without creating broker orders or contacting a broker.</Alert> : null}
          <div className="mt-4 space-y-3 text-left">
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              <strong>Status:</strong> {subscriptionState === 'pending' ? 'Pending worker acknowledgement' : subscriptionState === 'pause_requested' ? 'Pause requested' : 'Stop requested'}
              {subscriptionId ? <span className="mt-1 block break-all text-[10px] opacity-75">Subscription {subscriptionId}</span> : null}
            </div>
            <p className="text-xs leading-5 text-neutral-600 dark:text-neutral-300">Sizing: {profileLabel}; maximum lot {sizingPreview.maxLot.toFixed(2)}. Broker execution can differ because of market conditions and account constraints.</p>
            {error ? <Alert variant="error">{error}</Alert> : null}
            {subscriptionState !== 'stop_requested' ? (
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={submitting || subscriptionState === 'pause_requested'} onClick={() => void requestSubscriptionChange('pause')}>Request pause</Button>
                <Button type="button" size="sm" variant="secondary" disabled={submitting} onClick={() => void requestSubscriptionChange('stop')}>Stop copying</Button>
              </div>
            ) : null}
          </div>
          <Button type="button" className="mt-6 w-full" disabled={submitting} onClick={onClose}>{c.done}</Button>
        </div>
      </div>,
      document.body,
    )
  }

  if (showPaywall) {
    return createPortal(
      <div
        className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copy-trader-title"
      >
        <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={c.close} onClick={onClose} />
        <div className="relative flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-3xl sm:rounded-2xl">
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:px-6">
            <div className="min-w-0">
              <h2 id="copy-trader-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {interpolate(c.paywallTitle, { trader: trader.displayName })}
              </h2>
              <p className="mt-0.5 text-sm text-neutral-900 dark:text-neutral-50">{c.paywallBody}</p>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-lg p-2 text-neutral-900 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-50 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
              aria-label={c.close}
              onClick={onClose}
            >
              <X className="h-5 w-5" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4 sm:px-6">
            <section aria-labelledby="copy-paywall-heading" className="mx-auto max-w-md space-y-4 py-4 text-center sm:py-8">
              <p className="text-3xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-50">
                {totalPriceLabel}<span className="text-base font-medium text-neutral-500 dark:text-neutral-400">/Month</span>
              </p>
              <dl className="mx-auto w-full max-w-sm space-y-2 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-left text-sm dark:border-neutral-800 dark:bg-neutral-900/60">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-600 dark:text-neutral-300">{c.paywallProviderPrice}</dt>
                  <dd className="tabular-nums font-medium text-neutral-900 dark:text-neutral-50">{basePriceLabel}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-neutral-600 dark:text-neutral-300">
                    {charge.feePercent > 0
                      ? interpolate(c.paywallCopierFeeWithPercent, { percent: String(charge.feePercent) })
                      : c.paywallCopierFee}
                  </dt>
                  <dd className="tabular-nums font-medium text-neutral-900 dark:text-neutral-50">{feePriceLabel}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-neutral-200 pt-2 dark:border-neutral-700">
                  <dt id="copy-paywall-heading" className="font-semibold text-neutral-900 dark:text-neutral-50">{c.paywallTotal}</dt>
                  <dd className="tabular-nums font-semibold text-neutral-900 dark:text-neutral-50">{totalPriceLabel}</dd>
                </div>
              </dl>
              <p className="text-sm leading-6 text-neutral-600 dark:text-neutral-300">
                {c.paywallBody}
              </p>
              <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400">{c.paywallPendingNote}</p>
              {billingChecking ? (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">Confirming payment…</p>
              ) : null}
              {error ? <Alert variant="error">{error}</Alert> : null}
            </section>
          </div>
          <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-100 bg-white px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950 sm:flex-row sm:justify-end sm:px-6">
            <Button type="button" variant="secondary" disabled={submitting} onClick={onClose}>{c.cancel}</Button>
            <Button type="button" loading={submitting || billingChecking} disabled={submitting || billingChecking} onClick={() => void confirmPaywallSubscribe()}>
              {interpolate(c.paywallSubscribe, { amount: priceLabel })}
            </Button>
          </footer>
        </div>
      </div>,
      document.body,
    )
  }

  return (
    <SlaveConfigureModal
      slave={selectedBroker}
      source={null}
      settings={settings}
      labels={copyRiskLabelsForSocial(t.copyRisk)}
      setup={socialCopySetupToMirrorSetup(c)}
      loginLabel={c.login}
      balanceLabel={c.balance}
      saveError={error}
      closeLabel={c.close}
      symbolMap={symbolMap}
      onSymbolMapChange={setSymbolMap}
      onChange={setSettings}
      onClose={onClose}
      title={interpolate(c.title, { trader: trader.displayName })}
      sourceName={`@${trader.username}`}
      destinationOptions={destinations}
      selectedDestinationId={selectedBrokerId}
      onSelectDestination={setSelectedBrokerId}
      onConnectDestination={onConnectBroker}
      loadingDestinations={loading}
      emptyDestinationsTitle={c.noAccountsTitle}
      emptyDestinationsBody={c.noAccountsBody}
      connectDestinationLabel={c.connectBroker}
      primaryLabel={isSyntheticSimulation ? 'Create simulated subscription' : c.startCopying}
      onPrimary={submitCopy}
      primaryLoading={submitting}
      primaryDisabled={disabled}
    />
  )
}
