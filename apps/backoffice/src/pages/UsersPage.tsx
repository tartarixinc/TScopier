import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { adminQuery } from '../lib/adminApi'
import { useAdminRealtime } from '../hooks/useAdminRealtime'
import { PageShell } from '../components/layout/PageShell'
import { PageHeader } from '../components/layout/PageHeader'
import { DataPanel } from '../components/ui/DataPanel'
import { formatAdminUntil, formatJoinedDate, formatMoney } from '../lib/format'

type UserRow = {
  user_id: string
  name: string
  email: string
  created_at: string
  total_balance: number
  base_currency: string
  subscription_status: string | null
  is_admin: boolean
  admin_until: string | null
  admin_active: boolean
}

export function UsersPage() {
  const navigate = useNavigate()
  const [rows, setRows] = useState<UserRow[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await adminQuery<{ users: UserRow[] }>('users_list', { search })
      setRows(res.users)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    void load()
  }, [load])
  useAdminRealtime(() => void load())

  return (
    <PageShell>
      <PageHeader
        title="Users"
        subtitle="Search and open user profiles to manage admin access."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, email, or user ID"
          className="w-full max-w-md rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      {error ? <p className="text-sm text-red-500">{error}</p> : null}

      <DataPanel title="All users" subtitle={loading ? 'Loading…' : `${rows.length} users`}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-xs font-medium uppercase tracking-wide text-neutral-400 dark:border-neutral-800">
                <th className="px-4 py-3 sm:px-5">Name</th>
                <th className="px-4 py-3 sm:px-5">Email</th>
                <th className="px-4 py-3 sm:px-5">Joined</th>
                <th className="px-4 py-3 sm:px-5">Balance</th>
                <th className="px-4 py-3 sm:px-5">Role</th>
                <th className="px-4 py-3 sm:px-5">Until</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {rows.map(row => (
                <tr
                  key={row.user_id}
                  className="cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                  onClick={() => navigate(`/users/${row.user_id}`)}
                >
                  <td className="px-4 py-3 font-medium sm:px-5">
                    <Link to={`/users/${row.user_id}`} className="hover:text-teal-600">
                      {row.name}
                    </Link>
                    {row.admin_active ? (
                      <span className="ml-2 rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                        Admin
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-neutral-600 dark:text-neutral-300 sm:px-5">{row.email || '—'}</td>
                  <td className="px-4 py-3 sm:px-5">{formatJoinedDate(row.created_at)}</td>
                  <td className="px-4 py-3 sm:px-5">{formatMoney(row.total_balance, row.base_currency)}</td>
                  <td className="px-4 py-3 sm:px-5">{row.admin_active ? 'Admin' : 'Free'}</td>
                  <td className="px-4 py-3 sm:px-5" title={row.admin_until ?? undefined}>
                    {formatAdminUntil(row.admin_active, row.admin_until)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataPanel>
    </PageShell>
  )
}
