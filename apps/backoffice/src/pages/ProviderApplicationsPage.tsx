import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { supabase } from '../lib/supabase'
import { sendProviderApprovalEmail } from '../lib/adminApi'
import { PageShell } from '../components/layout/PageShell'
import { PageHeader } from '../components/layout/PageHeader'
import { DataPanel } from '../components/ui/DataPanel'

type Status = 'pending' | 'approved' | 'rejected' | 'suspended'
type Kind = 'demo' | 'live' | 'prop'

type ApplicationRow = {
  user_id: string
  display_name: string | null
  username: string
  email: string | null
  status: Status
  submitted_at: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  submit_count: number
  declared_account_kind: Kind | null
  detected_account_mode: 'demo' | 'live' | 'unknown' | null
  prop_firm_name: string | null
  monthly_price_cents: number | null
  access_mode: 'open' | 'private'
  bio: string | null
  social_links: Record<string, string> | null
  account_label: string | null
  platform: string | null
  account_login: string | null
  connection_status: string | null
  balance: number | string | null
  equity: number | string | null
  currency: string | null
  synced_at: string | null
  eligibility: string | null
}

const TABS: { key: Status; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'suspended', label: 'Suspended' },
]

function money(value: number | string | null, currency: string | null): string {
  if (value == null) return '\u2014'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '\u2014'
  const code = (currency ?? '').toUpperCase()
  try {
    if (/^[A-Z]{3}$/.test(code)) return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount)
  } catch { /* non-ISO currency */ }
  return `${amount.toFixed(2)} ${code}`.trim()
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">{children}</dd>
    </div>
  )
}

function ReviewCard({
  row, busy, onDecide,
}: {
  row: ApplicationRow
  busy: boolean
  onDecide: (row: ApplicationRow, decision: 'approve' | 'reject' | 'suspend' | 'reinstate', reason: string | null, kind: Kind | null) => void
}) {
  const [kind, setKind] = useState<Kind>(row.declared_account_kind ?? 'live')
  const [reason, setReason] = useState('')
  const mismatch = row.declared_account_kind != null && row.declared_account_kind !== 'prop'
    && row.detected_account_mode != null && row.detected_account_mode !== 'unknown'
    && row.declared_account_kind !== row.detected_account_mode
  const links = Object.entries(row.social_links ?? {})
  const price = row.monthly_price_cents == null ? '\u2014' : row.monthly_price_cents === 0 ? 'Free' : `$${(row.monthly_price_cents / 100).toFixed(2)} / month`

  return (
    <li className="space-y-4 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {row.display_name ?? row.username} <span className="font-normal text-neutral-500">@{row.username}</span>
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{row.email} · {row.user_id}</p>
        </div>
        <span className={clsx(
          'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          row.status === 'pending' && 'bg-amber-100 text-amber-800',
          row.status === 'approved' && 'bg-green-100 text-green-800',
          (row.status === 'rejected' || row.status === 'suspended') && 'bg-red-100 text-red-800',
        )}>{row.status}</span>
      </div>

      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field label="Account">{row.account_label ?? '\u2014'}</Field>
        <Field label="Platform / login">{row.platform ?? '\u2014'} · {row.account_login ?? '\u2014'}</Field>
        <Field label="Connection">{row.connection_status ?? '\u2014'}</Field>
        <Field label="Last synced">{row.synced_at ? new Date(row.synced_at).toLocaleString() : '\u2014'}</Field>
        <Field label="Balance">{money(row.balance, row.currency)}</Field>
        <Field label="Equity">{money(row.equity, row.currency)}</Field>
        <Field label="Declared type">
          {row.declared_account_kind ?? '\u2014'}{row.prop_firm_name ? ` · ${row.prop_firm_name}` : ''}
        </Field>
        <Field label="Detected mode">{row.detected_account_mode ?? '\u2014'}</Field>
        <Field label="Price">{price}</Field>
        <Field label="Followers">{row.access_mode === 'open' ? 'Anyone' : 'Approval required'}</Field>
        <Field label="Submissions">{row.submit_count}</Field>
        <Field label="Submitted">{row.submitted_at ? new Date(row.submitted_at).toLocaleString() : '\u2014'}</Field>
      </dl>

      {row.bio ? <p className="rounded-lg bg-neutral-50 p-3 text-sm text-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-200">{row.bio}</p> : null}
      {links.length > 0 ? (
        <ul className="flex flex-wrap gap-3 text-xs">
          {links.map(([key, url]) => (
            <li key={key}><a href={url} target="_blank" rel="noopener noreferrer" className="font-medium text-green-600 hover:underline">{key}</a></li>
          ))}
        </ul>
      ) : null}
      {row.eligibility ? <p className="text-xs font-medium text-red-600">Account is no longer eligible: {row.eligibility}</p> : null}
      {mismatch ? <p className="text-xs font-medium text-amber-700">Declared type differs from the detected mode — confirm before approving.</p> : null}
      {row.rejection_reason ? <p className="text-xs text-neutral-600 dark:text-neutral-300">Last note: {row.rejection_reason}</p> : null}

      {row.status === 'pending' && (
        <div className="flex flex-col gap-3 border-t border-neutral-100 pt-3 dark:border-neutral-800 md:flex-row md:items-end">
          <label className="text-xs text-neutral-600 dark:text-neutral-300">
            Confirmed account type
            <select value={kind} onChange={event => setKind(event.target.value as Kind)} className="mt-1 block rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
              <option value="demo">Demo</option>
              <option value="live">Live</option>
              <option value="prop">Prop</option>
            </select>
          </label>
          <label className="flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            Rejection reason (required to reject; shown to the user)
            <input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <div className="flex gap-2">
            <button type="button" disabled={busy || row.eligibility != null} onClick={() => onDecide(row, 'approve', null, kind)} className="rounded-lg bg-green-400 px-3 py-1.5 text-sm font-semibold text-neutral-950 hover:bg-green-500 disabled:opacity-50">Approve</button>
            <button type="button" disabled={busy || !reason.trim()} onClick={() => onDecide(row, 'reject', reason, null)} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">Reject</button>
          </div>
        </div>
      )}
      {row.status === 'approved' && (
        <div className="flex flex-col gap-3 border-t border-neutral-100 pt-3 dark:border-neutral-800 md:flex-row md:items-end">
          <label className="flex-1 text-xs text-neutral-600 dark:text-neutral-300">
            Suspension note (shown to the user)
            <input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900" />
          </label>
          <button type="button" disabled={busy} onClick={() => onDecide(row, 'suspend', reason || null, null)} className="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50">Suspend provider</button>
        </div>
      )}
      {row.status === 'suspended' && (
        <div className="border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <button type="button" disabled={busy || row.eligibility != null} onClick={() => onDecide(row, 'reinstate', null, null)} className="rounded-lg bg-green-400 px-3 py-1.5 text-sm font-semibold text-neutral-950 hover:bg-green-500 disabled:opacity-50">Reinstate provider</button>
        </div>
      )}
    </li>
  )
}

export function ProviderApplicationsPage() {
  const [tab, setTab] = useState<Status>('pending')
  const [rows, setRows] = useState<ApplicationRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async (status: Status) => {
    setLoading(true)
    const { data, error: rpcError } = await supabase.rpc('admin_list_provider_applications', { p_status: status })
    if (rpcError) setError(rpcError.message)
    else { setRows((data ?? []) as ApplicationRow[]); setError('') }
    setLoading(false)
  }, [])

  useEffect(() => { void load(tab) }, [load, tab])

  const decide = useCallback(async (
    row: ApplicationRow, decision: 'approve' | 'reject' | 'suspend' | 'reinstate', reason: string | null, kind: Kind | null,
  ) => {
    const verb = decision === 'approve' ? 'Approve' : decision === 'reject' ? 'Reject' : decision === 'suspend' ? 'Suspend' : 'Reinstate'
    if (!window.confirm(`${verb} ${row.display_name ?? row.username}?`)) return
    setBusyId(row.user_id)
    const { error: rpcError } = await supabase.rpc('admin_review_provider_application', {
      p_user_id: row.user_id, p_decision: decision, p_reason: reason, p_account_kind: kind,
    })
    if (rpcError) setError(rpcError.message)
    else {
      await load(tab)
      if (decision === 'approve' || decision === 'reinstate') {
        // The decision is already saved; a failed email must not look like a failed approval.
        try { await sendProviderApprovalEmail(row.user_id, decision) }
        catch (emailError) { setError(`Approved, but the notification email failed: ${emailError instanceof Error ? emailError.message : 'unknown error'}`) }
      }
    }
    setBusyId(null)
  }, [load, tab])

  const subtitle = useMemo(() => loading ? 'Loading…' : `${rows.length} application${rows.length === 1 ? '' : 's'}`, [loading, rows.length])

  return (
    <PageShell>
      <PageHeader
        title="Provider applications"
        subtitle="Review Social Trading provider applications. Decisions are audit-logged and the applicant is notified."
      />
      <div className="flex gap-2" role="tablist">
        {TABS.map(item => (
          <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} onClick={() => setTab(item.key)}
            className={clsx('rounded-full border px-4 py-1.5 text-sm', tab === item.key ? 'border-green-400 bg-green-50 font-semibold text-neutral-900 dark:bg-green-950/30 dark:text-neutral-50' : 'border-neutral-200 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300')}>
            {item.label}
          </button>
        ))}
      </div>
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      <DataPanel title={TABS.find(item => item.key === tab)?.label ?? ''} subtitle={subtitle}>
        {loading ? (
          <p className="px-5 py-6 text-sm text-neutral-600">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-neutral-600 dark:text-neutral-300">Nothing here.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {rows.map(row => <ReviewCard key={row.user_id} row={row} busy={busyId === row.user_id} onDecide={(...args) => void decide(...args)} />)}
          </ul>
        )}
      </DataPanel>
    </PageShell>
  )
}
