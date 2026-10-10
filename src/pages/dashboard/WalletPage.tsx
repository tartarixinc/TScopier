import { useCallback, useEffect, useState } from 'react'
import { PageShell } from '../../components/layout/PageShell'
import { PageHeader } from '../../components/layout/PageHeader'
import { Card } from '../../components/ui/Card'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { supabase } from '../../lib/supabase'
import type { UserWalletRow, WalletLedgerRow } from '../../types/database'

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <Card padding="md">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
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

export function WalletPage() {
  const t = useT()
  const copy = t.wallet
  const { user } = useAuth()
  const { formatMoney } = useFormatMoney()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [availableCents, setAvailableCents] = useState(0)
  const [pendingCents, setPendingCents] = useState(0)
  const [rows, setRows] = useState<LedgerEntry[]>([])

  const refresh = useCallback(async () => {
    if (!user) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    const [walletResult, ledgerResult] = await Promise.all([
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
    ])
    if (walletResult.error || ledgerResult.error) {
      setAvailableCents(0)
      setPendingCents(0)
      setRows([])
      setError(copy.loadError)
    } else {
      const wallet = walletResult.data as Pick<UserWalletRow, 'available_cents' | 'pending_cents'> | null
      setAvailableCents(wallet?.available_cents ?? 0)
      setPendingCents(wallet?.pending_cents ?? 0)
      setRows((ledgerResult.data ?? []) as LedgerEntry[])
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
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{copy.subtitle}</p>
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard title={copy.available} value={formatMoney(availableCents / 100)} />
          <StatCard title={copy.pending} value={formatMoney(pendingCents / 100)} />
        </div>

        <Card padding="none" className="overflow-hidden">
          <div className="border-b border-neutral-200/65 px-5 py-4 dark:border-neutral-800/55">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{copy.history}</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
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
                    <td className="px-5 py-5 text-neutral-500 dark:text-neutral-400" colSpan={5}>
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
