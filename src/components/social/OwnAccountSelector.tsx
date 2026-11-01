import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { resolveAccountLogin } from '../../lib/brokerFromServer'
import { brokerConnectionLabel, maskBrokerAccountIdentifier, resolveSocialAccountMode, socialBrokerDisplayLabel } from '../../lib/socialAccount'
import { AccountModeBadge } from './AccountModeBadge'
import { Alert } from '../ui/Alert'

export function OwnAccountSelector({
  selectedAccountId,
  onChange,
  loading,
  error,
}: {
  selectedAccountId: string
  onChange: (accountId: string) => void
  loading: boolean
  error: string | null
}) {
  const { brokers, loading: accountsLoading, loadError } = useBrokerAccounts()
  const [expanded, setExpanded] = useState(false)
  const selected = brokers.find(account => account.id === selectedAccountId) ?? null

  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200/65 bg-white dark:border-neutral-800/55 dark:bg-neutral-950" aria-labelledby="your-account-heading">
      <button type="button" className="flex w-full items-center justify-between gap-4 px-4 py-3 text-start sm:px-5" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className="min-w-0">
          <span id="your-account-heading" className="block text-sm font-semibold text-neutral-900 dark:text-neutral-50">You</span>
          <span className="mt-0.5 block truncate text-xs text-neutral-600 dark:text-neutral-300">
            {selected ? `${socialBrokerDisplayLabel(selected)} / ${maskBrokerAccountIdentifier(resolveAccountLogin(selected))}` : 'Select an account to view account-specific performance'}
          </span>
        </span>
        <span className="flex items-center gap-2">
          {selected ? <AccountModeBadge mode={resolveSocialAccountMode(selected)} /> : null}
          <ChevronDown className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden />
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-neutral-100 px-4 py-4 dark:border-neutral-800 sm:px-5">
          {loadError || error ? <Alert variant="error">{loadError ?? error}</Alert> : null}
          {accountsLoading ? <p className="text-sm text-neutral-600 dark:text-neutral-300">Loading accounts…</p> : brokers.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-300">No connected broker accounts are available.</p>
          ) : (
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-200">
              Broker account
              <select
                value={selectedAccountId}
                onChange={event => onChange(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2.5 text-sm text-neutral-900 focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-green-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
              >
                <option value="" disabled>Select an account</option>
                {brokers.map(account => (
                  <option key={account.id} value={account.id}>
                    {socialBrokerDisplayLabel(account)} / {account.platform.toUpperCase()} / {maskBrokerAccountIdentifier(resolveAccountLogin(account))} / {brokerConnectionLabel(account)} / {resolveSocialAccountMode(account).toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          )}
          {selectedAccountId && !selected ? <div className="mt-3"><Alert variant="warning">The previously selected account is no longer available. Select another account to load its data.</Alert></div> : null}
          {loading ? <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">Refreshing trades and performance for this account…</p> : null}
          <p className="mt-2 text-xs leading-5 text-neutral-500 dark:text-neutral-400">This changes only the account being viewed. It does not share the account or modify any copy subscription.</p>
        </div>
      ) : null}
    </section>
  )
}
