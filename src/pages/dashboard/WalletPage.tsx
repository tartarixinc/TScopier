import { useCallback, useEffect, useState } from 'react'
import { PageShell } from '../../components/layout/PageShell'
import { PageHeader } from '../../components/layout/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { startSocialCopyBillingPortal } from '../../lib/socialCopy'
import { supabase } from '../../lib/supabase'
import type { SocialCopyBillingRow, UserWalletRow, WalletLedgerRow } from '../../types/database'

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card padding="md">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-900 dark:text-neutral-50">
        {title}
      </p>
      <p className="mt-2 text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</p>
    </Card>
  )
}

type LedgerEntry = Pick<
  WalletLedgerRow,
  'id' | 'payer_user_id' | 'provider_user_id' | 'amount_cents' | 'status' | 'description' | 'created_at'
>

type BillingEntry = Pick<
  SocialCopyBillingRow,
  'id' | 'provider_user_id' | 'status' | 'current_period_end' | 'cancel_at_period_end' | 'stripe_subscription_id'
>

export function WalletPage() {
  const t = useT()
  const copy = t.wallet
  const { user, session } = useAuth()
  const { formatMoney } = useFormatMoney()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [availableCents, setAvailableCents] = useState(0)
  const [pendingCents, setPendingCents] = useState(0)
  const [rows, setRows] = useState<LedgerEntry[]>([])
  const [billingRows, setBillingRows] = useState<BillingEntry[]>([])
  const [portalBusyId, setPortalBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!user) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const [walletResult, ledgerResult, billingResult] = await Promise.all([
      supabase
        .from('user_wallets')
        .select('available_cents, pending_cents')
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase
        .from('wallet_ledger')
        .select('id, payer_user_id, provider_user_id, amount_cents, status, description, created_at')
        .or(`payer_user_id.eq.${user.id},provider_user_id.eq.${user.id}`)
        .order('created_at', { ascending: false }),
      supabase
        .from('social_copy_billing')
        .select('id, provider_user_id, status, current_period_end, cancel_at_period_end, stripe_subscription_id')
        .eq('payer_user_id', user.id)
        .order('updated_at', { ascending: false }),
    ])
    if (walletResult.error || ledgerResult.error || billingResult.error) {
      setAvailableCents(0)
      setPendingCents(0)
      setRows([])
      setBillingRows([])
      setError(copy.loadError)
    } else {
      const wallet = walletResult.data as Pick<UserWalletRow, 'available_cents' | 'pending_cents'> | null
      setAvailableCents(wallet?.available_cents ?? 0)
      setPendingCents(wallet?.pending_cents ?? 0)
      setRows((ledgerResult.data ?? []) as LedgerEntry[])
      setBillingRows((billingResult.data ?? []) as BillingEntry[])
    }
    setLoading(false)
  }, [copy.loadError, user])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const statusLabel = (status: LedgerEntry['status']) => {
    if (status === 'paid') return copy.statusPaid
    if (status === 'reversed') return copy.statusReversed
    return copy.statusPending
  }

  const openPortal = async (providerUserId: string) => {
    const token = session?.access_token
    if (!token) {
      setError('Sign in again to manage billing.')
      return
    }
    setPortalBusyId(providerUserId)
    setError('')
    try {
      const url = await startSocialCopyBillingPortal({
        accessToken: token,
        providerUserId,
        returnUrl: `${window.location.origin}/wallet`,
      })
      window.location.assign(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to open billing portal.')
      setPortalBusyId(null)
    }
  }

  return (
    <PageShell>
      <PageHeader
        title={copy.title}
        actions={(
          <Button variant="secondary" onClick={() => void refresh()} loading={loading}>
            {copy.refresh}
          </Button>
        )}
      />

      <div className="mt-6 space-y-6">
        <p className="text-sm text-neutral-900 dark:text-neutral-50">{copy.subtitle}</p>
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard title={copy.available} value={formatMoney(availableCents / 100)} />
          <StatCard title={copy.pending} value={formatMoney(pendingCents / 100)} />
        </div>

        <Card padding="none" className="overflow-hidden">
          <div className="border-b border-neutral-200/65 px-5 py-4 dark:border-neutral-800/55">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">Copy subscriptions</h2>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
              Paid provider copy billing periods. Manage renewal or cancel in Stripe.
            </p>
          </div>
          {billingRows.length === 0 ? (
            <p className="px-5 py-5 text-sm text-neutral-900 dark:text-neutral-50">No copy billing yet.</p>
          ) : (
            <ul className="divide-y divide-neutral-200/65 dark:divide-neutral-800/55">
              {billingRows.map(row => (
                <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium capitalize text-neutral-900 dark:text-neutral-50">
                      {row.status.replaceAll('_', ' ')}
                      {row.cancel_at_period_end ? ' · cancels at period end' : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
                      {row.current_period_end
                        ? `Current period ends ${new Date(row.current_period_end).toLocaleDateString()}`
                        : 'Period pending confirmation'}
                    </p>
                  </div>
                  {row.stripe_subscription_id ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={portalBusyId === row.provider_user_id}
                      onClick={() => void openPortal(row.provider_user_id)}
                    >
                      Manage in Stripe
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padding="none" className="overflow-hidden">
          <div className="border-b border-neutral-200/65 px-5 py-4 dark:border-neutral-800/55">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{copy.history}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-900 dark:bg-neutral-900 dark:text-neutral-50">
                <tr>
                  <th className="px-5 py-3">{copy.colDate}</th>
                  <th className="px-5 py-3">{copy.colDescription}</th>
                  <th className="px-5 py-3">{copy.colAmount}</th>
                  <th className="px-5 py-3">{copy.colRole}</th>
                  <th className="px-5 py-3">{copy.colStatus}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-t border-neutral-200/65 dark:border-neutral-800/55">
                    <td className="px-5 py-3">{new Date(row.created_at).toLocaleDateString()}</td>
                    <td className="px-5 py-3">{row.description}</td>
                    <td className="px-5 py-3">{formatMoney(row.amount_cents / 100)}</td>
                    <td className="px-5 py-3">
                      {row.provider_user_id === user?.id ? copy.roleProvider : copy.rolePayer}
                    </td>
                    <td className="px-5 py-3">{statusLabel(row.status)}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-5 py-5 text-neutral-900 dark:text-neutral-50" colSpan={5}>
                      {copy.empty}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </PageShell>
  )
}
