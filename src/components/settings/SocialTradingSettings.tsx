import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSocialFollow } from '../../hooks/useSocialFollow'
import { providerEntryLabel, useProviderStatus } from '../../hooks/useProviderStatus'
import { resolveAccountLogin } from '../../lib/brokerFromServer'
import {
  fetchOwnSocialCopySources,
  fetchSocialCopySources,
  publishSocialCopySource,
  setSocialCopySourceStatus,
  type OwnSocialCopySource,
  type SocialCopySource,
} from '../../lib/socialCopy'
import { publishingEligibilityDiagnostics } from '../../lib/socialEligibility'
import {
  brokerConnectionLabel,
  isSocialDestinationEligible,
  maskBrokerAccountIdentifier,
  resolveSocialAccountMode,
  socialBrokerDisplayLabel,
} from '../../lib/socialAccount'
import { supabase } from '../../lib/supabase'
import { AccountModeBadge } from '../social/AccountModeBadge'
import { SocialEligibilityDiagnostics } from '../social/SocialEligibilityDiagnostics'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'

export function SocialTradingSettings() {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const { brokers, loading: accountsLoading, loadError, refreshBrokers } = useBrokerAccounts()
  const social = useSocialFollow()
  const provider = useProviderStatus()
  const [sources, setSources] = useState<OwnSocialCopySource[]>([])
  const [detailedSources, setDetailedSources] = useState<SocialCopySource[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [pendingBrokerId, setPendingBrokerId] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const refreshSources = useCallback(async () => {
    if (!userId) {
      setSources([])
      setDetailedSources([])
      setSourcesLoading(false)
      return
    }
    setSourcesLoading(true)
    try {
      const [own, detailed] = await Promise.all([
        fetchOwnSocialCopySources(supabase, userId),
        fetchSocialCopySources(supabase, userId),
      ])
      setSources(own)
      setDetailedSources(detailed)
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Unable to load account sharing.' })
    } finally {
      setSourcesLoading(false)
    }
  }, [userId])

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSources(), 0)
    return () => window.clearTimeout(timer)
  }, [refreshSources])

  const sourceByBroker = useMemo(
    () => new Map(sources.map(source => [source.brokerAccountId, source])),
    [sources],
  )
  const detailedSourceByBroker = useMemo(
    () => new Map(sources.map(source => [source.brokerAccountId, detailedSources.find(item => item.sourceId === source.sourceId)])),
    [detailedSources, sources],
  )

  const changeSharing = async (brokerId: string, shared: boolean) => {
    if (pendingBrokerId) return
    setPendingBrokerId(brokerId)
    setMessage(null)
    try {
      const account = brokers.find(item => item.id === brokerId)
      const existing = sourceByBroker.get(brokerId)
      if (shared) {
        const safeLabel = account?.label?.trim() || account?.broker_name?.trim()
          || `${account?.platform.toUpperCase() ?? 'Broker'} ${maskBrokerAccountIdentifier(account ? resolveAccountLogin(account) : null)}`
        await publishSocialCopySource(supabase, brokerId, safeLabel)
      } else if (existing) {
        await setSocialCopySourceStatus(supabase, existing.sourceId, 'paused')
      }
      await refreshSources()
      setMessage({
        type: 'success',
        text: shared
          ? 'This account is now shared. Copying remains subject to backend eligibility checks.'
          : 'Sharing was revoked. New copies are blocked and current subscriptions were sent through the normal pause workflow.',
      })
    } catch (cause) {
      setMessage({ type: 'error', text: cause instanceof Error ? cause.message : 'Unable to update account sharing.' })
    } finally {
      setPendingBrokerId(null)
    }
  }

  const profile = social.currentProfile
  const isApprovedProvider = provider.status === 'approved'
  const publicPath = isApprovedProvider && profile?.slug
    ? `/p/${profile.slug}`
    : user?.id ? `/social-trading/${user.id}` : '/social-trading'

  return (
    <div className="space-y-4">
      {message ? <Alert variant={message.type}>{message.text}</Alert> : null}

      <section className="overflow-hidden rounded-2xl border border-neutral-200/65 bg-white dark:border-neutral-800/55 dark:bg-neutral-950">
        <div className="border-b border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:px-6">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">My provider profile</h2>
          <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-300">Profile visibility and account sharing are separate controls.</p>
        </div>
        <div className="space-y-4 p-5 sm:p-6">
          {social.loading ? <p className="text-sm text-neutral-600 dark:text-neutral-300">Loading provider profile…</p> : !profile ? (
            <div>
              <p className="text-sm text-neutral-700 dark:text-neutral-200">
                {provider.status === 'pending'
                  ? 'Your provider application is under review.'
                  : 'You have not published a Social Trading provider profile. Apply to become a provider — an administrator reviews every application.'}
              </p>
              <Link className="mt-3 inline-flex items-center rounded-lg bg-green-400 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-green-500" to="/social-trading/provider">
                {providerEntryLabel(provider.status)}
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-neutral-900 dark:text-neutral-50">@{profile.username}</p>
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">Published</span>
                  <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">{profile.access}</span>
                </div>
                <Link className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-green-600 hover:text-teal-700 dark:text-teal-300" to={publicPath}>
                  View public profile <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
                {!isApprovedProvider && !provider.loading ? (
                  <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
                    Sharing an account for copying requires an approved provider application.{' '}
                    <Link className="font-medium text-green-600 dark:text-teal-300" to="/social-trading/provider">{providerEntryLabel(provider.status)}</Link>
                  </p>
                ) : null}
              </div>
              <label className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                Who can follow
                <select
                  className="mt-1 block rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                  value={profile.access}
                  disabled={social.pendingKeys.has('access')}
                  onChange={event => void social.setAccess(event.target.value as 'open' | 'private')}
                >
                  <option value="open">Open</option>
                  <option value="private">Approval required</option>
                </select>
              </label>
            </div>
          )}
          <div className="flex flex-wrap gap-3 border-t border-neutral-100 pt-4 text-sm dark:border-neutral-800">
            <Link className="font-medium text-green-600 hover:text-teal-700 dark:text-teal-300" to="/social-trading">Provider settings</Link>
            <Link className="font-medium text-green-600 hover:text-teal-700 dark:text-teal-300" to="/brokers">Manage broker connections</Link>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-neutral-200/65 bg-white dark:border-neutral-800/55 dark:bg-neutral-950">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800 sm:px-6">
          <div>
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">My broker accounts</h2>
            <p className="mt-0.5 text-sm text-neutral-600 dark:text-neutral-300">Share accounts individually. No credentials or broker secrets are exposed.</p>
          </div>
          <Button size="sm" variant="secondary" disabled={accountsLoading || sourcesLoading} onClick={() => void Promise.all([refreshBrokers(), refreshSources()])}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
        </div>
        {loadError ? <div className="p-5 sm:p-6"><Alert variant="error">{loadError}</Alert></div> : accountsLoading || sourcesLoading ? (
          <p className="px-5 py-8 text-sm text-neutral-600 dark:text-neutral-300 sm:px-6">Loading broker accounts…</p>
        ) : brokers.length === 0 ? (
          <div className="px-5 py-8 sm:px-6">
            <p className="text-sm text-neutral-700 dark:text-neutral-200">No connected broker accounts yet.</p>
            <Link className="mt-2 inline-block text-sm font-medium text-green-600 dark:text-teal-300" to="/brokers">Connect an account</Link>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {brokers.map(account => {
              const source = sourceByBroker.get(account.id)
              const shared = source?.status === 'published'
              const mode = resolveSocialAccountMode(account)
              const connection = brokerConnectionLabel(account)
              const diagnostics = publishingEligibilityDiagnostics(account, detailedSourceByBroker.get(account.id)?.eligibilityDiagnostics)
              return (
                <li key={account.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:px-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{socialBrokerDisplayLabel(account)}</p>
                      <AccountModeBadge mode={mode} />
                      {!account.is_active ? <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">Inactive</span> : null}
                    </div>
                    <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
                      {account.platform.toUpperCase()} · {maskBrokerAccountIdentifier(resolveAccountLogin(account))} · {connection}
                    </p>
                    {shared && !isSocialDestinationEligible(account) ? (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Shared, but unavailable to new copiers until its mode is known and it meets the connection, provider, sync, and history rules.</p>
                    ) : null}
                    <p className="mt-2 text-xs text-neutral-500">Publishing authorization is checked separately from eligibility and includes your identity, Social directory membership, and account ownership.</p>
                    <div className="mt-2"><SocialEligibilityDiagnostics diagnostics={diagnostics} title={shared ? 'Published source eligibility' : 'Pre-publication account checks'} /></div>
                  </div>
                  <label className="flex items-center justify-between gap-3 text-sm font-medium text-neutral-800 dark:text-neutral-100 sm:justify-end">
                    <span>Share for Copying</span>
                    <Toggle
                      checked={shared}
                      disabled={!profile || !isApprovedProvider || pendingBrokerId === account.id || (!shared && !isSocialDestinationEligible(account))}
                      onChange={checked => void changeSharing(account.id, checked)}
                    />
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
