import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { adminMutate, adminQuery } from '../lib/adminApi'
import { useAdminRealtime } from '../hooks/useAdminRealtime'
import { PageShell } from '../components/layout/PageShell'
import { PageHeader } from '../components/layout/PageHeader'
import { DataPanel } from '../components/ui/DataPanel'
import {
  adminUntilToDatetimeLocal,
  datetimeLocalToIso,
  displayUserName,
  formatAdminUntil,
  formatJoinedDate,
} from '../lib/format'
import { isAdminAccessActive } from '../lib/adminAccess'

type User360 = {
  profile: Record<string, unknown> | null
  subscription: Record<string, unknown> | null
}

function profileRow(label: string, value: string) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 sm:px-5">
      <dt className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right text-sm font-medium text-neutral-900 dark:text-neutral-100">{value}</dd>
    </div>
  )
}

export function UserDetailPage() {
  const { userId } = useParams()
  const [data, setData] = useState<User360 | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reason, setReason] = useState('Admin access change')
  const [untilInput, setUntilInput] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!userId) return
    try {
      const res = await adminQuery<User360>('user_360', { target_user_id: userId })
      setData(res)
      const profile = res.profile ?? {}
      setUntilInput(adminUntilToDatetimeLocal(profile.admin_until as string | null | undefined))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load user')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])
  useAdminRealtime(() => void load())

  const profile = data?.profile ?? {}
  const subscription = data?.subscription ?? null
  const adminActive = isAdminAccessActive({
    is_admin: profile.is_admin === true,
    admin_until: profile.admin_until as string | null | undefined,
  })

  const planLabel = useMemo(() => {
    if (adminActive) return 'Admin (bypass)'
    const plan = String(subscription?.plan ?? '').trim()
    const status = String(subscription?.status ?? '').trim()
    if (!plan && !status) return 'Free'
    return [plan, status].filter(Boolean).join(' · ')
  }, [adminActive, subscription])

  const setAdminAccess = async (grantAdmin: boolean) => {
    if (!userId) return
    const trimmedReason = reason.trim()
    if (!trimmedReason) {
      setError('Reason is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      await adminMutate('set_admin_access', {
        target_user_id: userId,
        is_admin: grantAdmin,
        admin_until: grantAdmin ? datetimeLocalToIso(untilInput) : null,
        reason: trimmedReason,
      })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update admin access')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <PageShell>
        <p className="text-sm text-neutral-400">Loading user profile…</p>
      </PageShell>
    )
  }

  if (error && !data) {
    return (
      <PageShell>
        <p className="text-sm text-red-400">{error}</p>
      </PageShell>
    )
  }

  if (!data) return null

  const name = displayUserName({
    first_name: String(profile.first_name ?? ''),
    last_name: String(profile.last_name ?? ''),
    display_name: String(profile.display_name ?? ''),
  })

  return (
    <PageShell>
      <PageHeader
        title={name}
        subtitle={`Joined ${formatJoinedDate(String(profile.created_at ?? ''))}`}
        actions={(
          <Link
            to="/users"
            className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to users
          </Link>
        )}
      />

      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      <DataPanel title="Profile" subtitle="Role and admin access expiry">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {profileRow('Role', adminActive ? 'Admin' : 'Free')}
          {profileRow('Until', formatAdminUntil(adminActive, profile.admin_until as string | null | undefined))}
          {profileRow('Plan', planLabel)}
        </dl>

        <div className="space-y-3 border-t border-neutral-100 px-4 py-4 dark:border-neutral-800 sm:px-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">Admin access</p>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">
            Until (leave empty for permanent ∞)
            <input
              type="datetime-local"
              value={untilInput}
              onChange={e => setUntilInput(e.target.value)}
              className="mt-1 w-full max-w-xs rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="block text-xs text-neutral-500 dark:text-neutral-400">
            Reason (required)
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void setAdminAccess(true)}
              className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-60"
            >
              {adminActive ? 'Update expiry' : 'Grant admin'}
            </button>
            <button
              type="button"
              disabled={saving || !adminActive}
              onClick={() => void setAdminAccess(false)}
              className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              Revoke admin
            </button>
          </div>
        </div>
      </DataPanel>
    </PageShell>
  )
}
