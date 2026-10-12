import { useCallback, useEffect, useState } from 'react'
import { adminMutate, adminQuery } from '../lib/adminApi'
import { PageShell } from '../components/layout/PageShell'
import { PageHeader } from '../components/layout/PageHeader'
import { DataPanel } from '../components/ui/DataPanel'
import { StatBlock } from '../components/ui/StatBlock'

type OverviewStats = {
  total_users: number
  active_brokers: number
  open_trades: number
  closed_trades_today: number
  active_channels: number
  active_subscriptions: number
  signups_last_hour: number
  suspicious_signups_last_hour: number
  signups_today: number
  suspicious_signups_today: number
}

export function OverviewPage() {
  const [stats, setStats] = useState<OverviewStats | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [banLoading, setBanLoading] = useState(false)
  const [banResult, setBanResult] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await adminQuery<{ stats: OverviewStats }>('overview')
      setStats(res.stats)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleBanSpam = async () => {
    const confirmed = window.confirm(
      'Ban all accounts matching spam signup patterns (e.g. pornhub#####@hotmail.com)?',
    )
    if (!confirmed) return

    setBanLoading(true)
    setBanResult('')
    try {
      const preview = await adminMutate<{
        matched_count: number
        matched: Array<{ user_id: string; email: string }>
      }>('bulk_ban_spam_users', { dry_run: true, reason: 'signup spam cleanup' })

      if (preview.matched_count === 0) {
        setBanResult('No spam signups matched the current patterns.')
        return
      }

      const proceed = window.confirm(
        `Found ${preview.matched_count} suspicious accounts. Ban them all?`,
      )
      if (!proceed) {
        setBanResult(`Dry run: ${preview.matched_count} accounts would be banned.`)
        return
      }

      const result = await adminMutate<{
        matched_count: number
        banned_count: number
        failures: Array<{ user_id: string; error: string }>
      }>('bulk_ban_spam_users', { reason: 'signup spam cleanup' })

      const failNote = result.failures.length > 0
        ? ` (${result.failures.length} failed)`
        : ''
      setBanResult(`Banned ${result.banned_count} of ${result.matched_count} matched accounts${failNote}.`)
      await load()
    } catch (e) {
      setBanResult(e instanceof Error ? e.message : 'Bulk ban failed')
    } finally {
      setBanLoading(false)
    }
  }

  const signupAlert = (stats?.suspicious_signups_last_hour ?? 0) >= 5
    || (stats?.suspicious_signups_today ?? 0) >= 20

  return (
    <PageShell>
      <PageHeader
        title="Overview"
        subtitle="Platform health and signup abuse monitoring."
      />

      {error ? <p className="text-sm text-red-500">{error}</p> : null}

      {signupAlert ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Elevated suspicious signup activity detected. Review recent users and consider banning spam accounts.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatBlock label="Total users" value={loading ? '…' : String(stats?.total_users ?? 0)} />
        <StatBlock label="Signups (1h)" value={loading ? '…' : String(stats?.signups_last_hour ?? 0)} />
        <StatBlock
          label="Suspicious signups (1h)"
          value={loading ? '…' : String(stats?.suspicious_signups_last_hour ?? 0)}
        />
        <StatBlock
          label="Suspicious signups (today)"
          value={loading ? '…' : String(stats?.suspicious_signups_today ?? 0)}
        />
      </div>

      <DataPanel title="Signup abuse" subtitle="Ban accounts matching known spam email patterns.">
        <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-sm text-neutral-900 dark:text-neutral-50">
            Matches patterns like <code className="text-xs">pornhub#####@hotmail.com</code> and disposable domains.
          </p>
          <button
            type="button"
            onClick={() => void handleBanSpam()}
            disabled={banLoading}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
          >
            {banLoading ? 'Working…' : 'Ban spam signups'}
          </button>
        </div>
        {banResult ? (
          <p className="border-t border-neutral-100 px-4 py-3 text-sm text-neutral-900 dark:border-neutral-800 dark:text-neutral-50 sm:px-5">
            {banResult}
          </p>
        ) : null}
      </DataPanel>
    </PageShell>
  )
}
