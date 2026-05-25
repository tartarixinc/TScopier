import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Zap } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../context/LocaleContext'
import { useAuth } from '../../context/AuthContext'
import { Button } from '../../components/ui/Button'

const BASIC_FEATURES = [
  '1 demo/live account',
  '5 Signal Backtests/month',
  '5 Telegram Channels',
  '3 TPs',
  'Single Trading Mode',
  'Market News',
  'Economic Calendar',
  'Time/Days/News Filter',
]

const ADVANCED_FEATURES = [
  '5 demo/live accounts (expandable to 100)',
  'Unlimited signal backtests/month',
  'Unlimited Telegram Channels',
  'Unlimited TPs/SLs',
  'Single & Range Trading Mode',
  'Range Layering',
  'Close worse entries first',
  'Reverse signal',
  'Auto breakeven & close (Pips, Money, RR, TP Hit)',
  'Risk Reward Mode',
  'Market News',
  'Economic Calendar',
  'Time/Days/News Filter',
  'Channel Keyword follow',
]

const MONTHLY_BASIC = 9.99
const MONTHLY_ADVANCED = 39.99
const MONTHLY_EXTRA_ACCOUNT = 10
const ANNUAL_BASIC = +(MONTHLY_BASIC * 12 * 0.8).toFixed(2)
const ANNUAL_ADVANCED = +(MONTHLY_ADVANCED * 12 * 0.8).toFixed(2)
const ANNUAL_EXTRA_ACCOUNT = +(MONTHLY_EXTRA_ACCOUNT * 12 * 0.8).toFixed(2)

export function PricingPage() {
  const t = useT()
  const pt = t.pricing
  const navigate = useNavigate()
  const { session } = useAuth()
  const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly')
  const [extraAccounts, setExtraAccounts] = useState(0)
  const [checkoutLoading, setCheckoutLoading] = useState<'basic' | 'advanced' | null>(null)
  const [checkoutError, setCheckoutError] = useState('')

  const isAnnual = interval === 'annual'

  const basicDisplayPrice = isAnnual ? +(ANNUAL_BASIC / 12).toFixed(2) : MONTHLY_BASIC
  const advancedDisplayBase = isAnnual ? +(ANNUAL_ADVANCED / 12).toFixed(2) : MONTHLY_ADVANCED
  const extraAccountDisplayPrice = isAnnual ? +(ANNUAL_EXTRA_ACCOUNT / 12).toFixed(2) : MONTHLY_EXTRA_ACCOUNT
  const advancedDisplayTotal = advancedDisplayBase + extraAccounts * extraAccountDisplayPrice

  const basicAnnualTotal = ANNUAL_BASIC
  const advancedAnnualTotal = ANNUAL_ADVANCED + extraAccounts * ANNUAL_EXTRA_ACCOUNT

  const startCheckout = async (plan: 'basic' | 'advanced') => {
    if (!session?.access_token) {
      navigate('/login')
      return
    }
    setCheckoutError('')
    setCheckoutLoading(plan)
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-checkout-session`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan,
          interval,
          extraAccounts: plan === 'advanced' ? extraAccounts : 0,
          successUrl: `${window.location.origin}/dashboard?checkout=success`,
          cancelUrl: `${window.location.origin}/pricing`,
        }),
      })
      const data = (await res.json()) as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        throw new Error(data.error || pt.checkoutFailed)
      }
      window.location.href = data.url
    } catch (err) {
      setCheckoutError(err instanceof Error ? err.message : pt.checkoutFailed)
      setCheckoutLoading(null)
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50 sm:text-4xl">
            {pt.title}
          </h1>
          <p className="mt-3 text-base text-neutral-500 dark:text-neutral-400">
            {pt.subtitle}
          </p>

          {checkoutError ? (
            <div
              role="alert"
              className="mx-auto mt-6 max-w-lg rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
            >
              {checkoutError}
            </div>
          ) : null}

          {/* Billing toggle */}
          <div className="mt-8 inline-flex items-center rounded-full border border-neutral-200 bg-white p-1 dark:border-neutral-700 dark:bg-neutral-900">
            <button
              type="button"
              onClick={() => setInterval('monthly')}
              className={clsx(
                'rounded-full px-5 py-2 text-sm font-medium transition-all',
                !isAnnual
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
              )}
            >
              {pt.monthly}
            </button>
            <button
              type="button"
              onClick={() => setInterval('annual')}
              className={clsx(
                'rounded-full px-5 py-2 text-sm font-medium transition-all',
                isAnnual
                  ? 'bg-teal-600 text-white shadow-sm'
                  : 'text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100',
              )}
            >
              {pt.annual}
              <span className="ml-2 inline-block rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:bg-green-900/30 dark:text-green-400">
                {pt.save20}
              </span>
            </button>
          </div>

          <button
            onClick={() => navigate('/dashboard')}
            className="mt-4 block mx-auto text-sm font-medium text-neutral-400 underline underline-offset-4 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
          >
            {pt.skip}
          </button>
        </div>

        {/* Plans */}
        <div className="mt-12 grid gap-8 lg:grid-cols-2">
          {/* Basic Plan */}
          <div className="relative rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-6">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {pt.basic.name}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                {pt.basic.description}
              </p>
            </div>

            <div className="mb-1">
              <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">
                ${basicDisplayPrice.toFixed(2)}
              </span>
              <span className="text-base text-neutral-500 dark:text-neutral-400">
                {pt.perMonth}
              </span>
            </div>
            {isAnnual ? (
              <p className="mb-6 text-xs text-neutral-400 dark:text-neutral-500">
                Billed ${basicAnnualTotal.toFixed(2)}{pt.perYear}
              </p>
            ) : (
              <div className="mb-6" />
            )}

            <Button
              size="lg"
              className="w-full"
              loading={checkoutLoading === 'basic'}
              disabled={checkoutLoading !== null}
              onClick={() => void startCheckout('basic')}
            >
              {pt.subscribe}
            </Button>

            <div className="mt-8">
              <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {pt.features}
              </p>
              <ul className="mt-4 space-y-3">
                {BASIC_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-500" />
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Advanced Plan */}
          <div className="relative rounded-2xl border-2 border-teal-500 bg-white p-8 shadow-md dark:bg-neutral-900">
            <div className="absolute -top-3 left-6 inline-flex items-center gap-1 rounded-full bg-teal-500 px-3 py-1 text-xs font-semibold text-white">
              <Zap className="h-3 w-3" />
              {pt.popular}
            </div>

            <div className="mb-6">
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {pt.advanced.name}
              </h2>
              <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                {pt.advanced.description}
              </p>
            </div>

            <div className="mb-1">
              <span className="text-4xl font-bold text-neutral-900 dark:text-neutral-50">
                ${advancedDisplayTotal.toFixed(2)}
              </span>
              <span className="text-base text-neutral-500 dark:text-neutral-400">
                {pt.perMonth}
              </span>
            </div>
            {isAnnual ? (
              <p className="mb-4 text-xs text-neutral-400 dark:text-neutral-500">
                Billed ${advancedAnnualTotal.toFixed(2)}{pt.perYear}
              </p>
            ) : (
              <div className="mb-4" />
            )}

            {/* Extra accounts selector */}
            <div className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                    {pt.extraAccountLabel}
                  </p>
                  <p className="text-xs text-neutral-400 dark:text-neutral-500">
                    {isAnnual ? pt.extraAccountUnitAnnual : pt.extraAccountUnit}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setExtraAccounts((v) => Math.max(0, v - 1))}
                    disabled={extraAccounts === 0 || checkoutLoading !== null}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={95}
                    value={extraAccounts}
                    onChange={(e) => setExtraAccounts(Math.max(0, Math.min(95, Number(e.target.value) || 0)))}
                    disabled={checkoutLoading !== null}
                    className="h-8 w-14 rounded-md border border-neutral-300 bg-white text-center text-sm font-medium text-neutral-900 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-50"
                  />
                  <button
                    type="button"
                    onClick={() => setExtraAccounts((v) => Math.min(95, v + 1))}
                    disabled={extraAccounts >= 95 || checkoutLoading !== null}
                    className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-300 text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  >
                    +
                  </button>
                </div>
              </div>
              {extraAccounts > 0 && (
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                  5 included + {extraAccounts} extra = {5 + extraAccounts} total accounts
                </p>
              )}
            </div>

            <Button
              size="lg"
              className="w-full"
              loading={checkoutLoading === 'advanced'}
              disabled={checkoutLoading !== null}
              onClick={() => void startCheckout('advanced')}
            >
              {pt.startTrial}
            </Button>
            <p className="mt-2 text-center text-xs text-neutral-400 dark:text-neutral-500">
              {pt.trialDays}
            </p>

            <div className="mt-8">
              <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {pt.features}
              </p>
              <ul className="mt-4 space-y-3">
                {ADVANCED_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-teal-500" />
                    <span className="text-sm text-neutral-700 dark:text-neutral-300">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
