import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminMutate, adminQuery } from '../lib/adminApi'
import { PageShell } from '../components/layout/PageShell'
import { PageHeader } from '../components/layout/PageHeader'
import { DataPanel } from '../components/ui/DataPanel'

type PayoutRow = {
  id: string
  affiliate_user_id: string
  affiliate_name: string
  referred_user_id: string
  referred_name: string
  commission_cents: number
  currency: string
  stripe_invoice_id: string
  status: string
  created_at: string
}

type PayoutOverview = {
  payouts: PayoutRow[]
  totals: {
    count: number
    total_pending_cents: number
  }
}

function formatMoney(cents: number, currency = 'USD') {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((cents || 0) / 100)
}

export function AffiliatePayoutsPage() {
  const [rows, setRows] = useState<PayoutRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await adminQuery<PayoutOverview>('affiliate_payouts_overview', { status: 'pending' })
      setRows(res.payouts)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load affiliate payouts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const totals = useMemo(() => {
    const cents = rows.reduce((sum, row) => sum + (Number(row.commission_cents) || 0), 0)
    return {
      count: rows.length,
      cents,
    }
  }, [rows])

  const markAllPaid = async () => {
    if (rows.length === 0) return
    if (!window.confirm(`Mark ${rows.length} commission rows as paid?`)) return
    setSaving(true)
    try {
      await adminMutate('affiliate_mark_paid', {
        ledger_ids: rows.map((r) => r.id),
        period_label: new Date().toISOString().slice(0, 7),
        reason: 'Monthly affiliate payout run',
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to mark payouts as paid')
    } finally {
      setSaving(false)
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Affiliate Payouts"
        subtitle="Review pending affiliate commissions and mark payout batches as paid."
        actions={(
          <button
            type="button"
            onClick={() => void markAllPaid()}
            disabled={rows.length === 0 || saving}
            className="inline-flex items-center rounded-lg bg-green-400 px-3 py-2 text-sm font-semibold text-neutral-950 transition-colors hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Mark all pending as paid
          </button>
        )}
      />

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <DataPanel title="Pending rows" subtitle={loading ? 'Loading…' : `${totals.count} commission rows`}>
          <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{totals.count}</p>
        </DataPanel>
        <DataPanel title="Pending total" subtitle="Commission amount waiting for payout">
          <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
            {formatMoney(totals.cents)}
          </p>
        </DataPanel>
      </div>

      <DataPanel
        title="Pending commissions"
        subtitle={loading ? 'Loading…' : `${rows.length} rows`}
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-xs font-medium uppercase tracking-wide text-neutral-400 dark:border-neutral-800">
                <th className="px-4 py-3 sm:px-5">Affiliate</th>
                <th className="px-4 py-3 sm:px-5">Referred user</th>
                <th className="px-4 py-3 sm:px-5">Invoice</th>
                <th className="px-4 py-3 sm:px-5">Commission</th>
                <th className="px-4 py-3 sm:px-5">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(5)].map((__, j) => (
                      <td key={j} className="px-4 py-4 sm:px-5">
                        <div className="h-4 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : rows.map((row) => (
                <tr key={row.id} className="hover:bg-neutral-50/80 dark:hover:bg-neutral-800/30">
                  <td className="px-4 py-3 sm:px-5">
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">{row.affiliate_name}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{row.affiliate_user_id}</p>
                  </td>
                  <td className="px-4 py-3 sm:px-5">
                    <p className="font-medium text-neutral-900 dark:text-neutral-100">{row.referred_name}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400">{row.referred_user_id}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-600 dark:text-neutral-300 sm:px-5">
                    {row.stripe_invoice_id}
                  </td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300 sm:px-5">
                    {formatMoney(row.commission_cents, row.currency)}
                  </td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300 sm:px-5">
                    {new Date(row.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-neutral-500 dark:text-neutral-400 sm:px-5">
                    No pending affiliate commissions.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </DataPanel>
    </PageShell>
  )
}

