import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '../ui/Card'
import { Alert } from '../ui/Alert'
import { useAuth } from '../../context/AuthContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import {
  fetchMyProviderCopiers,
  fetchProviderPaymentLedger,
  type ProviderCopier,
  type ProviderPaymentRow,
} from '../../lib/socialCopy'
import { supabase } from '../../lib/supabase'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'

export function ProviderCopiersPanel({ copy }: { copy: SocialTradingPageTranslations }) {
  const [rows, setRows] = useState<ProviderCopier[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    void fetchMyProviderCopiers(supabase)
      .then(next => { if (active) { setRows(next); setError(null) } })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : copy.providerCopiersError)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [copy.providerCopiersError])

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.providerCopiersTitle}</h2>
        <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">{copy.providerCopiersBody}</p>
      </div>
      {error ? <div className="px-4 py-3"><Alert variant="error">{error}</Alert></div> : null}
      {loading ? (
        <p className="px-4 py-6 text-sm text-neutral-600 dark:text-neutral-300">{copy.loadingDirectory}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-600 dark:text-neutral-300">{copy.providerCopiersEmpty}</p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {rows.map(row => (
            <li key={row.subscriptionId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">{row.displayName}</p>
                {row.username ? <p className="truncate text-xs text-neutral-500">@{row.username}</p> : null}
              </div>
              <div className="text-end text-xs text-neutral-600 dark:text-neutral-300">
                <p className="font-medium capitalize">{row.status.replaceAll('_', ' ')}</p>
                <p>{new Date(row.createdAt).toLocaleDateString()}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function ProviderPaymentsPanel({ copy }: { copy: SocialTradingPageTranslations }) {
  const { user } = useAuth()
  const { formatMoney } = useFormatMoney()
  const [rows, setRows] = useState<ProviderPaymentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (!user?.id) {
      setRows([])
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    void fetchProviderPaymentLedger(supabase, user.id)
      .then(next => { if (active) { setRows(next); setError(null) } })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : copy.providerPaymentsError)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [copy.providerPaymentsError, user?.id])

  const statusLabel = (status: ProviderPaymentRow['status']) => {
    if (status === 'paid') return copy.providerPaymentPaid
    if (status === 'reversed') return copy.providerPaymentReversed
    return copy.providerPaymentPending
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.providerPaymentsTitle}</h2>
        <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">{copy.providerPaymentsBody}</p>
      </div>
      {error ? <div className="px-4 py-3"><Alert variant="error">{error}</Alert></div> : null}
      {loading ? (
        <p className="px-4 py-6 text-sm text-neutral-600 dark:text-neutral-300">{copy.loadingDirectory}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-600 dark:text-neutral-300">{copy.providerPaymentsEmpty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2">{copy.providerPaymentDate}</th>
                <th className="px-4 py-2">{copy.providerPaymentDescription}</th>
                <th className="px-4 py-2">{copy.providerPaymentAmount}</th>
                <th className="px-4 py-2">{copy.providerPaymentStatus}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="px-4 py-2">{new Date(row.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-2">{row.description ?? '—'}</td>
                  <td className="px-4 py-2">{formatMoney(row.amountCents / 100)}</td>
                  <td className="px-4 py-2">{statusLabel(row.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-neutral-100 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800">
        <Link to="/wallet" className="font-medium text-green-600 hover:underline dark:text-teal-300">{copy.providerPaymentsWalletLink}</Link>
      </div>
    </Card>
  )
}
