import { useState } from 'react'
import { CreditCard, ExternalLink, Plus, Minus } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useAuth } from '../../context/AuthContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { PageShell } from '../../components/layout/PageShell'
import { PageHeader } from '../../components/layout/PageHeader'

export function BillingPage() {
  const t = useT()
  const bt = t.pricing.billing
  const { session } = useAuth()
  const { subscription, hasActiveSubscription, refresh, openPricingModal } = useSubscription()
  const [portalLoading, setPortalLoading] = useState(false)
  const [extraCount, setExtraCount] = useState<number | null>(null)
  const [savingExtras, setSavingExtras] = useState(false)
  const [extraSaved, setExtraSaved] = useState(false)

  const currentExtra = subscription?.extra_accounts ?? 0
  const editingExtra = extraCount ?? currentExtra

  const handleManageBilling = async () => {
    if (!session) return
    setPortalLoading(true)
    try {
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/customer-portal`
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
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
          'Authorization': `Bearer ${session.access_token}`,
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

  const statusLabel = subscription
    ? {
        active: bt.statusActive,
        trialing: bt.statusTrialing,
        canceled: bt.statusCanceled,
        past_due: bt.statusPastDue,
        incomplete: bt.statusPastDue,
      }[subscription.status] || subscription.status
    : ''

  const statusColor = subscription
    ? {
        active: 'text-green-600 bg-green-50 dark:text-green-400 dark:bg-green-900/20',
        trialing: 'text-teal-600 bg-teal-50 dark:text-teal-400 dark:bg-teal-900/20',
        canceled: 'text-neutral-500 bg-neutral-100 dark:text-neutral-400 dark:bg-neutral-800',
        past_due: 'text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/20',
        incomplete: 'text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/20',
      }[subscription.status] || ''
    : ''

  return (
    <PageShell>
      <PageHeader title={bt.title} subtitle={bt.subtitle} />
      <div className="max-w-2xl space-y-6">
        {hasActiveSubscription && subscription ? (
          <>
            <Card padding="lg">
              <div className="space-y-6">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-50 dark:bg-teal-900/20">
                      <CreditCard className="h-5 w-5 text-teal-600 dark:text-teal-400" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                        {subscription.plan === 'advanced' ? t.pricing.advanced.name : t.pricing.basic.name}
                      </h3>
                      <span className={`inline-block mt-0.5 rounded-full px-2 py-0.5 text-xs font-medium ${statusColor}`}>
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                </div>

                <dl className="grid gap-4 sm:grid-cols-2">
                  {subscription.current_period_end && (
                    <div>
                      <dt className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                        {bt.nextBilling}
                      </dt>
                      <dd className="mt-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {new Date(subscription.current_period_end).toLocaleDateString()}
                      </dd>
                    </div>
                  )}
                  {subscription.status === 'trialing' && subscription.trial_ends_at && (
                    <div>
                      <dt className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                        {bt.trialEnds}
                      </dt>
                      <dd className="mt-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                        {new Date(subscription.trial_ends_at).toLocaleDateString()}
                      </dd>
                    </div>
                  )}
                </dl>

                <Button
                  variant="secondary"
                  onClick={handleManageBilling}
                  loading={portalLoading}
                  className="gap-2"
                >
                  {bt.manageBilling}
                  <ExternalLink className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>

            {/* Extra accounts management - only for Advanced plan */}
            {subscription.plan === 'advanced' && (
              <Card padding="lg">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                      {bt.extraAccounts}
                    </h3>
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      5 included + {editingExtra} extra = {5 + editingExtra} total accounts
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
                      onChange={(e) => setExtraCount(Math.max(0, Math.min(95, Number(e.target.value) || 0)))}
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

                    {editingExtra !== currentExtra && (
                      <Button
                        size="sm"
                        onClick={handleSaveExtras}
                        loading={savingExtras}
                      >
                        {t.common.save}
                      </Button>
                    )}
                  </div>

                  {extraSaved && (
                    <p className="text-xs font-medium text-green-600 dark:text-green-400">
                      {t.settings.saved}
                    </p>
                  )}
                </div>
              </Card>
            )}
          </>
        ) : (
          <Card padding="lg">
            <div className="text-center py-8">
              <CreditCard className="mx-auto h-10 w-10 text-neutral-300 dark:text-neutral-600" />
              <p className="mt-4 text-sm text-neutral-500 dark:text-neutral-400">
                {bt.noPlan}
              </p>
              <Button className="mt-4" onClick={openPricingModal}>
                {bt.choosePlan}
              </Button>
            </div>
          </Card>
        )}
      </div>
    </PageShell>
  )
}
