import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  CreditCard,
  ExternalLink,
  Minus,
  Plus,
  Receipt,
  Zap,
  ChevronLeft,
  ChevronRight,
  Info,
} from 'lucide-react'
import { useT, useLocale } from '../../context/LocaleContext'
import { useAuth } from '../../context/AuthContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useUserProfile } from '../../context/UserProfileContext'
import { getSubscribeCtaLabel } from '../../lib/subscriptionCta'
import { interpolate } from '../../i18n/interpolate'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { PageShell } from '../../components/layout/PageShell'
import { PageHeader } from '../../components/layout/PageHeader'
import { BillingPricingTable } from '../../components/billing/BillingPricingTable'
import {
  customerRefFromUserId,
  fetchBillingHistory,
  formatBillingMoney,
  formatInvoicePeriod,
  type BillingHistoryResponse,
  type BillingInvoice,
} from '../../lib/billingApi'
import { PRICING_ADVANCED_INCLUDED_ACCOUNTS } from '../../lib/pricingPlans'

function formatShortDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function invoiceStatusLabel(status: string, bt: ReturnType<typeof useT>['pricing']['billing']) {
  const map: Record<string, string> = {
    paid: bt.invoiceStatusPaid,
    draft: bt.invoiceStatusDraft,
    open: bt.invoiceStatusOpen,
    void: bt.invoiceStatusVoid,
    uncollectible: bt.invoiceStatusUncollectible,
  }
  return map[status] ?? status
}

function invoiceStatusClass(status: string): string {
  switch (status) {
    case 'paid':
      return 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300'
    case 'draft':
      return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
    case 'open':
      return 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
    default:
      return 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
  }
}

function SummaryCard({
  label,
  value,
  hint,
  status,
}: {
  label: string
  value: string
  hint?: string
  status?: string
}) {
  return (
    <Card padding="md" className="flex flex-col justify-between min-h-[120px]">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </p>
      <div className="mt-3">
        <p className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{value}</p>
        {status ? (
          <p className="mt-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">{status}</p>
        ) : hint ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
        ) : null}
      </div>
    </Card>
  )
}

export function BillingPage() {
  const t = useT()
  const { locale } = useLocale()
  const bt = t.pricing.billing
  const { user, session } = useAuth()
  const { isAdmin, adminUntil } = useUserProfile()
  const {
    subscription,
    hasActiveSubscription,
    effectivePlan,
    loading: subscriptionLoading,
    refresh,
    openPricingModal,
    isPastDue,
    hasTrialExpired,
  } = useSubscription()

  const subscribeCta = getSubscribeCtaLabel(t, { isPastDue, effectivePlan, hasTrialExpired })

  const [portalLoading, setPortalLoading] = useState(false)
  const [extraCount, setExtraCount] = useState<number | null>(null)
  const [savingExtras, setSavingExtras] = useState(false)
  const [extraSaved, setExtraSaved] = useState(false)

  const [billingMeta, setBillingMeta] = useState<Omit<BillingHistoryResponse, 'invoices'> | null>(null)
  const [invoicePages, setInvoicePages] = useState<BillingInvoice[][]>([])
  const [invoicePageIndex, setInvoicePageIndex] = useState(0)
  const [invoiceCursors, setInvoiceCursors] = useState<(string | undefined)[]>([undefined])
  const [invoiceHasMore, setInvoiceHasMore] = useState(false)
  const [invoicesLoading, setInvoicesLoading] = useState(true)
  const [invoicesError, setInvoicesError] = useState('')
  const invoicePagesRef = useRef(invoicePages)
  invoicePagesRef.current = invoicePages
  const invoiceCursorsRef = useRef(invoiceCursors)
  invoiceCursorsRef.current = invoiceCursors

  const localeTag = locale === 'es' ? 'es-ES' : locale === 'fr' ? 'fr-FR' : 'en-US'
  const customerRef = user ? customerRefFromUserId(user.id) : '—'
  const currentExtra = subscription?.extra_accounts ?? 0
  const editingExtra = extraCount ?? currentExtra

  const statusLabel = subscription
    ? {
        active: bt.statusActive,
        trialing: bt.statusTrialing,
        canceled: bt.statusCanceled,
        past_due: bt.statusPastDue,
        incomplete: bt.statusPastDue,
      }[subscription.status] || subscription.status
    : ''

  const memberSinceIso = subscription?.created_at ?? user?.created_at ?? null

  const planDisplay = useMemo(() => {
    if (isAdmin) {
      const summary = adminUntil
        ? interpolate(bt.adminPlanSummaryUntil, {
            date: formatShortDate(adminUntil, localeTag),
          })
        : bt.adminPlanSummary
      return { name: 'Admin', summary }
    }
    if (!hasActiveSubscription || !effectivePlan) {
      return { name: bt.freePlan, summary: bt.freePlanSummary }
    }
    if (effectivePlan === 'advanced') {
      return { name: t.pricing.advanced.name, summary: bt.advancedPlanSummary }
    }
    return { name: t.pricing.basic.name, summary: bt.basicPlanSummary }
  }, [isAdmin, adminUntil, hasActiveSubscription, effectivePlan, bt, t.pricing.advanced.name, t.pricing.basic.name, localeTag])

  const nextRenewalDisplay = useMemo(() => {
    if (!hasActiveSubscription || !subscription) return { value: '—', hint: bt.noActiveSubscription }
    if (subscription.status === 'trialing' && subscription.trial_ends_at) {
      return {
        value: formatShortDate(subscription.trial_ends_at, localeTag),
        hint: bt.trialEnds,
      }
    }
    if (subscription.current_period_end) {
      return {
        value: formatShortDate(subscription.current_period_end, localeTag),
        hint: undefined,
      }
    }
    return { value: '—', hint: bt.noActiveSubscription }
  }, [hasActiveSubscription, subscription, bt, localeTag])

  const billedDisplay = useMemo(() => {
    if (billingMeta?.currentPeriodAmount != null && billingMeta.currentPeriodAmount > 0) {
      return formatBillingMoney(billingMeta.currentPeriodAmount, 'usd', localeTag)
    }
    const page = invoicePages[0]
    const lastPaid = page?.find(inv => inv.status === 'paid')
    if (lastPaid) {
      return formatBillingMoney(lastPaid.amountPaid, lastPaid.currency, localeTag)
    }
    if (!hasActiveSubscription) {
      return { value: '—', hint: bt.noActiveSubscription } as const
    }
    return '—'
  }, [billingMeta, invoicePages, hasActiveSubscription, bt.noActiveSubscription, localeTag])

  useEffect(() => {
    if (!session?.access_token) {
      setInvoicesLoading(false)
      return
    }
    if (invoicePagesRef.current[invoicePageIndex]) {
      setInvoicesLoading(false)
      return
    }

    let cancelled = false
    setInvoicesLoading(true)
    setInvoicesError('')

    void fetchBillingHistory(session.access_token, {
      startingAfter: invoiceCursorsRef.current[invoicePageIndex],
      limit: 8,
    })
      .then(data => {
        if (cancelled) return
        setBillingMeta({
          hasMore: data.hasMore,
          customerId: data.customerId,
          balance: data.balance,
          billingInterval: data.billingInterval,
          currentPeriodAmount: data.currentPeriodAmount,
        })
        setInvoiceHasMore(data.hasMore)
        setInvoicePages(prev => {
          const next = [...prev]
          next[invoicePageIndex] = data.invoices
          return next
        })
        if (data.hasMore && data.invoices.length > 0) {
          const lastId = data.invoices[data.invoices.length - 1].id
          setInvoiceCursors(prev => {
            const next = [...prev]
            next[invoicePageIndex + 1] = lastId
            return next
          })
        }
      })
      .catch(err => {
        if (cancelled) return
        setInvoicesError(err instanceof Error ? err.message : bt.loadInvoicesFailed)
      })
      .finally(() => {
        if (!cancelled) setInvoicesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [invoicePageIndex, session?.access_token, bt.loadInvoicesFailed])

  const currentInvoices = invoicePages[invoicePageIndex] ?? []

  const handleManageBilling = async () => {
    if (!session) return
    setPortalLoading(true)
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/customer-portal`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ returnUrl: `${window.location.origin}/billing` }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      }
    } finally {
      setPortalLoading(false)
    }
  }

  const handleSaveExtras = async () => {
    if (!session || editingExtra === currentExtra) return
    setSavingExtras(true)
    setExtraSaved(false)
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/update-extra-accounts`
      await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ extraAccounts: editingExtra }),
      })
      await refresh()
      setExtraCount(null)
      setExtraSaved(true)
      setTimeout(() => setExtraSaved(false), 3000)
    } finally {
      setSavingExtras(false)
    }
  }

  const billedValue = typeof billedDisplay === 'string' ? billedDisplay : billedDisplay.value
  const billedHint = typeof billedDisplay === 'string' ? undefined : billedDisplay.hint

  return (
    <PageShell>
      <PageHeader
        title={bt.title}
        subtitle={bt.subtitle}
        actions={
          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1 text-sm">
              <div>
                <span className="text-neutral-500 dark:text-neutral-400">{bt.customerId}: </span>
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">{customerRef}</span>
              </div>
            </div>
            <Button onClick={openPricingModal} className="gap-2">
              <Zap className="h-4 w-4" />
              {subscribeCta}
            </Button>
          </div>
        }
        actionsBreakpoint="lg"
      />

      <div className="mt-8 space-y-8">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label={bt.memberSince}
            value={memberSinceIso ? formatShortDate(memberSinceIso, localeTag) : '—'}
            status={
              hasActiveSubscription && statusLabel
                ? interpolate(bt.statusLine, { status: statusLabel })
                : undefined
            }
          />
          <SummaryCard
            label={bt.nextRenewal}
            value={nextRenewalDisplay.value}
            hint={nextRenewalDisplay.hint}
          />
          <SummaryCard
            label={bt.currentPlan}
            value={planDisplay.name}
            hint={planDisplay.summary}
          />
          <SummaryCard
            label={bt.billed}
            value={billedValue}
            hint={billedHint}
          />
        </div>

        {hasActiveSubscription && subscription ? (
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() => void handleManageBilling()}
              loading={portalLoading}
              className="gap-2"
            >
              {bt.manageBilling}
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}

        <Card padding="none" className="overflow-hidden">
          <div className="border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-950/40">
                <Receipt className="h-4 w-4 text-teal-600 dark:text-teal-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {bt.invoices}
                  </h2>
                  <Info className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
                </div>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{bt.invoicesHint}</p>
              </div>
            </div>
          </div>

          {invoicesError ? (
            <div className="px-6 py-8 text-sm text-amber-700 dark:text-amber-300">{invoicesError}</div>
          ) : invoicesLoading && currentInvoices.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {t.common.loading}
            </div>
          ) : currentInvoices.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {bt.noInvoices}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50/80 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-400">
                    <th className="px-6 py-3">{bt.invoiceNumber}</th>
                    <th className="px-6 py-3">{bt.period}</th>
                    <th className="px-6 py-3">{bt.date}</th>
                    <th className="px-6 py-3">{bt.amount}</th>
                    <th className="px-6 py-3">{bt.status}</th>
                    <th className="px-6 py-3 text-right" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {currentInvoices.map(inv => (
                    <tr key={inv.id} className="hover:bg-neutral-50/60 dark:hover:bg-neutral-900/40">
                      <td className="px-6 py-4 font-medium text-neutral-900 dark:text-neutral-100">
                        {inv.number ?? inv.id.slice(-8).toUpperCase()}
                      </td>
                      <td className="px-6 py-4 text-neutral-600 dark:text-neutral-300">
                        {formatInvoicePeriod(inv.periodStart, inv.periodEnd, localeTag)}
                      </td>
                      <td className="px-6 py-4 text-neutral-600 dark:text-neutral-300">
                        {formatShortDate(inv.created, localeTag)}
                      </td>
                      <td className="px-6 py-4 font-medium text-neutral-900 dark:text-neutral-100">
                        {formatBillingMoney(inv.amountPaid, inv.currency, localeTag)}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={clsx(
                            'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                            invoiceStatusClass(inv.status),
                          )}
                        >
                          {invoiceStatusLabel(inv.status, bt)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {inv.pdfUrl || inv.hostedUrl ? (
                          <a
                            href={inv.pdfUrl ?? inv.hostedUrl ?? '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400"
                          >
                            {bt.downloadInvoice}
                          </a>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {(invoicePageIndex > 0 || invoiceHasMore) && currentInvoices.length > 0 ? (
            <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-6 py-3 dark:border-neutral-800">
              <Button
                variant="ghost"
                size="sm"
                disabled={invoicePageIndex === 0 || invoicesLoading}
                onClick={() => setInvoicePageIndex(p => Math.max(0, p - 1))}
                className="gap-1"
              >
                <ChevronLeft className="h-4 w-4" />
                {bt.back}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  (invoicePageIndex >= invoicePages.length - 1 && !invoiceHasMore) || invoicesLoading
                }
                onClick={() => setInvoicePageIndex(p => p + 1)}
                className="gap-1"
              >
                {bt.next}
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </Card>

        {hasActiveSubscription && subscription?.plan === 'advanced' && !isAdmin ? (
          <Card padding="lg">
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                  {bt.extraAccounts}
                </h3>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {interpolate(bt.extraAccountsSummary, {
                    included: String(PRICING_ADVANCED_INCLUDED_ACCOUNTS),
                    extra: String(editingExtra),
                    total: String(PRICING_ADVANCED_INCLUDED_ACCOUNTS + editingExtra),
                  })}
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setExtraCount(Math.max(0, editingExtra - 1))}
                  disabled={editingExtra === 0 || savingExtras}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="number"
                  min={0}
                  max={95}
                  value={editingExtra}
                  onChange={e => setExtraCount(Math.max(0, Math.min(95, Number(e.target.value) || 0)))}
                  disabled={savingExtras}
                  className="h-9 w-16 rounded-lg border border-neutral-200 bg-white text-center text-sm font-semibold text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-50"
                />
                <button
                  type="button"
                  onClick={() => setExtraCount(Math.min(95, editingExtra + 1))}
                  disabled={editingExtra >= 95 || savingExtras}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  <Plus className="h-4 w-4" />
                </button>

                {editingExtra !== currentExtra ? (
                  <Button size="sm" onClick={() => void handleSaveExtras()} loading={savingExtras}>
                    {t.common.save}
                  </Button>
                ) : null}
              </div>

              {extraSaved ? (
                <p className="text-xs font-medium text-green-600 dark:text-green-400">{t.settings.saved}</p>
              ) : null}
            </div>
          </Card>
        ) : null}

        {!hasActiveSubscription && !subscriptionLoading ? (
          <Card padding="lg">
            <div className="flex flex-col items-center py-6 text-center">
              <CreditCard className="h-10 w-10 text-neutral-300 dark:text-neutral-600" />
              <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">{bt.noPlan}</p>
              <Button className="mt-4" onClick={openPricingModal}>
                {bt.choosePlan}
              </Button>
            </div>
          </Card>
        ) : null}

        <section>
          <div className="mb-6 flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-950/40">
              <CreditCard className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
                {bt.subscriptionPlans}
              </h2>
              <p className="mt-0.5 text-sm text-neutral-500 dark:text-neutral-400">
                {bt.subscriptionPlansIntro}
              </p>
            </div>
          </div>
          <BillingPricingTable />
        </section>
      </div>
    </PageShell>
  )
}
