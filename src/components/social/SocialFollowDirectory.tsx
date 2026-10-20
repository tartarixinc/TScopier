import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSocialFollow } from '../../hooks/useSocialFollow'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import { fetchSocialCopySources, type SocialCopySource } from '../../lib/socialCopy'
import type { SocialDirectoryProfile, SocialFollowErrorKind } from '../../lib/socialFollow'
import {
  fetchSocialProviderPerformance,
  fetchSocialTradeHistoryAccess,
  type SocialProviderPerformance,
} from '../../lib/socialTradeHistory'
import { supabase } from '../../lib/supabase'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { SocialCopyPanel } from './SocialCopyPanel'
import { SocialTradeHistoryPanel } from './SocialTradeHistoryPanel'
import { TraderReviews } from './TraderReviews'

function socialErrorMessage(kind: SocialFollowErrorKind, copy: SocialTradingPageTranslations): string {
  if (kind === 'verification_required') return copy.socialErrorVerification
  if (kind === 'profile_required') return copy.socialErrorProfileRequired
  if (kind === 'profile_incomplete') return copy.socialErrorProfileIncomplete
  if (kind === 'profile_unavailable') return copy.socialErrorProfileUnavailable
  if (kind === 'not_authorized') return copy.socialErrorUnauthorized
  if (kind === 'invalid_request') return copy.socialErrorInvalid
  if (kind === 'conflict') return copy.socialErrorConflict
  if (kind === 'backend_unavailable') return copy.socialErrorBackend
  return copy.socialErrorUnknown
}

function relationshipLabel(profile: SocialDirectoryProfile, copy: SocialTradingPageTranslations): string {
  if (profile.viewerRelationshipStatus === 'accepted') return copy.following
  if (profile.viewerRelationshipStatus === 'pending') return copy.requested
  return profile.access === 'private' ? copy.requestToFollow : copy.follow
}

function FollowButton({ profile, copy, pending, eligible, onFollow, onRemove }: {
  profile: SocialDirectoryProfile
  copy: SocialTradingPageTranslations
  pending: boolean
  eligible: boolean
  onFollow: () => void
  onRemove: () => void
}) {
  const active = profile.viewerRelationshipStatus === 'accepted' || profile.viewerRelationshipStatus === 'pending'
  return <Button type="button" size="sm" variant={active ? 'secondary' : 'primary'} disabled={pending || (!eligible && !active)} onClick={active ? onRemove : onFollow}>{relationshipLabel(profile, copy)}</Button>
}

function AccessSelect({ profile, copy, pending, onChange }: {
  profile: SocialDirectoryProfile
  copy: SocialTradingPageTranslations
  pending: boolean
  onChange: (access: 'open' | 'private') => void
}) {
  return <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
    <span>{copy.followAccess}</span>
    <select value={profile.access} disabled={pending} onChange={event => onChange(event.target.value as 'open' | 'private')} className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      <option value="open">{copy.anyoneCanFollow}</option><option value="private">{copy.requestsRequired}</option>
    </select>
  </label>
}

function AccountModeBadge({ mode }: { mode: SocialProviderPerformance['accountMode'] }) {
  const label = mode === 'demo' ? 'DEMO' : mode === 'live' ? 'LIVE' : 'UNKNOWN'
  const tone = mode === 'demo'
    ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
    : mode === 'live'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${tone}`}>{label}</span>
}

function PerformanceCells({ profile }: { profile: SocialDirectoryProfile }) {
  const [performance, setPerformance] = useState<SocialProviderPerformance | null>(null)
  const [source, setSource] = useState<SocialCopySource | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [access, sources] = await Promise.all([
          fetchSocialTradeHistoryAccess(supabase, profile.profileUserId),
          fetchSocialCopySources(supabase, profile.profileUserId),
        ])
        if (active) setSource(sources[0] ?? null)
        if (!access.canView) return
        const rows = await fetchSocialProviderPerformance(supabase, profile.profileUserId)
        if (active) setPerformance(rows.find(row => row.sourceStatus === 'published') ?? null)
      } catch {
        if (active) setPerformance(null)
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [profile.profileUserId])

  const missing = loading ? '…' : '—'
  const pnl = performance?.realizedProfit
  const status = performance?.performanceStatus
  const statusLabel = loading ? 'Loading' : status === 'available' ? 'Current' : status === 'stale' ? 'Stale' : status === 'incomplete' ? 'Incomplete' : status === 'pending' ? 'Pending' : status === 'no_history' ? 'No history' : status === 'failed' ? 'Failed' : 'Unavailable'
  const tone = status === 'available'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    : status === 'stale' || status === 'pending' || status === 'incomplete' || status === 'no_history'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
      : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
  return <>
    <td className="px-3 py-3"><span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{statusLabel}</span></td>
    <td className={pnl == null ? 'px-3 py-3 text-neutral-500' : pnl >= 0 ? 'px-3 py-3 font-medium text-green-600 dark:text-green-400' : 'px-3 py-3 font-medium text-red-600 dark:text-red-400'}>{pnl == null ? missing : `${pnl.toLocaleString()}${performance?.currency ? ` ${performance.currency}` : ''}`}</td>
    <td className="px-3 py-3">{performance?.winRate == null ? missing : `${performance.winRate.toFixed(2)}%`}</td>
    <td className="px-3 py-3">{performance ? performance.closedTradeCount : missing}</td>
    <td className="px-3 py-3">{performance?.profitFactor == null ? missing : performance.profitFactor.toFixed(2)}</td>
    <td className="px-3 py-3">{performance || source ? <AccountModeBadge mode={performance?.accountMode ?? source?.accountMode ?? 'unknown'} /> : missing}</td>
  </>
}

export function SocialFollowDirectory({ copy }: { copy: SocialTradingPageTranslations }) {
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const social = useSocialFollow()
  const view = params.get('view') === 'followers' ? 'followers' : params.get('view') === 'following' ? 'following' : 'all'
  const visibleProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return social.profiles.filter(profile => {
      if (profile.isSelf) return view === 'all'
      if (view === 'followers' && profile.followsViewerStatus !== 'accepted') return false
      if (view === 'following' && profile.viewerRelationshipStatus !== 'accepted') return false
      return !needle || profile.displayName.toLowerCase().includes(needle) || profile.username.toLowerCase().includes(needle)
    })
  }, [query, social.profiles, view])
  const incoming = social.profiles.filter(profile => !profile.isSelf && profile.followsViewerStatus === 'pending')
  const outgoingPending = social.profiles.filter(profile => profile.viewerRelationshipStatus === 'pending').length
  const self = social.currentProfile
  const openCount = social.profiles.filter(profile => profile.access === 'open').length
  const privateCount = social.profiles.filter(profile => profile.access === 'private').length

  return <section className="space-y-4" aria-labelledby="live-social-directory-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 id="live-social-directory-heading" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{copy.liveDirectory}</h2><p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Performance is calculated only from each trader's selected source account.</p></div>{social.error && !social.loading ? <Button type="button" size="sm" variant="secondary" onClick={() => void social.refresh()}>{copy.retry}</Button> : null}</div>
    {social.error ? <Alert variant="error">{socialErrorMessage(social.error.kind, copy)}</Alert> : null}
    {social.success ? <Alert variant="success">Social directory updated.</Alert> : null}
    {!social.loading && !self ? <Card><h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.joinTitle}</h3><p className="mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400">{copy.joinBody}</p><Button type="button" size="sm" className="mt-3" disabled={social.pendingKeys.has('register')} onClick={() => void social.register()}>{copy.joinAction}</Button></Card> : null}
    {self ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">{[[copy.open, openCount], [copy.private, privateCount], [copy.following, self.followingCount], [copy.followers, self.followerCount], [copy.requests, outgoingPending]].map(([label, value]) => <Card key={String(label)} padding="sm"><p className="text-sm text-neutral-500 dark:text-neutral-400">{label}</p><p className="mt-2 text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</p></Card>)}</div> : null}
    {self && incoming.length > 0 ? <Card padding="none" className="overflow-hidden"><h3 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">{copy.followRequests}</h3><ul className="divide-y divide-neutral-100 dark:divide-neutral-800">{incoming.map(profile => { const pending = social.pendingKeys.has(`incoming:${profile.profileUserId}`); return <li key={profile.profileUserId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><p className="text-sm font-medium">{profile.displayName}</p><p className="text-xs text-neutral-500">@{profile.username}</p></div><div className="flex gap-2"><Button type="button" size="sm" disabled={pending} onClick={() => void social.resolve(profile.profileUserId, 'accepted')}>{copy.accept}</Button><Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => void social.resolve(profile.profileUserId, 'declined')}>{copy.decline}</Button></div></li> })}</ul></Card> : null}
    <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy.searchPlaceholder} className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950 sm:max-w-xs" />
    <Card padding="none" className="overflow-hidden">{social.loading ? <p className="px-4 py-8 text-sm text-neutral-500">{copy.loadingDirectory}</p> : visibleProfiles.length === 0 ? <p className="px-4 py-8 text-sm text-neutral-500">{copy.empty}</p> : <div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-sm"><thead><tr className="border-b border-neutral-100 text-left text-xs text-neutral-500 dark:border-neutral-800"><th className="px-4 py-3">{copy.colName}</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Realized P/L</th><th className="px-3 py-3">{copy.winRate}</th><th className="px-3 py-3">Closed trades</th><th className="px-3 py-3">{copy.profitFactor}</th><th className="px-3 py-3">Account</th><th className="px-3 py-3">{copy.followers}</th><th className="px-4 py-3 text-end">{copy.colActions}</th></tr></thead><tbody>{visibleProfiles.map(profile => { const pending = social.pendingKeys.has(`outgoing:${profile.profileUserId}`); const name = profile.isSelf ? copy.you : profile.displayName; return <tr key={profile.profileUserId} className="border-t border-neutral-100 transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900/60"><td className="px-4 py-3"><div className="flex items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">{name.slice(0, 1).toUpperCase()}</span><div><Link className="font-medium text-neutral-900 hover:text-teal-700 dark:text-neutral-50" to={`/social-trading/${profile.profileUserId}`}>{name}</Link><p className="text-xs text-neutral-500">@{profile.username}{profile.country ? ` · ${profile.country}` : ''} · {profile.access === 'open' ? copy.open : copy.private}</p></div></div></td><PerformanceCells profile={profile} /><td className="px-3 py-3">{profile.followerCount}</td><td className="px-4 py-3 text-end">{profile.isSelf ? <AccessSelect profile={profile} copy={copy} pending={social.pendingKeys.has('access')} onChange={access => void social.setAccess(access)} /> : <div className="flex items-center justify-end gap-2"><TraderReviews traderUserId={profile.profileUserId} traderName={profile.displayName} isSelf={false} averageRating={profile.averageRating} reviewCount={profile.reviewCount} /><FollowButton profile={profile} copy={copy} pending={pending} eligible={Boolean(self)} onFollow={() => void social.follow(profile.profileUserId)} onRemove={() => void social.remove(profile.profileUserId)} /></div>}</td></tr> })}</tbody></table></div>}</Card>
  </section>
}

export function SocialFollowProfile({ profileUserId, copy }: { profileUserId: string; copy: SocialTradingPageTranslations }) {
  const social = useSocialFollow()
  const profile = social.profiles.find(item => item.profileUserId === profileUserId) ?? null
  if (social.loading) return <Card><p className="text-sm text-neutral-500">{copy.loadingDirectory}</p></Card>
  if (!profile) return <Card><p className="text-sm text-neutral-500">{copy.notFound}</p></Card>
  const outgoingPending = social.pendingKeys.has(`outgoing:${profile.profileUserId}`)
  const name = profile.isSelf ? copy.you : profile.displayName
  return <div className="space-y-4">
    {social.error ? <Alert variant="error">{socialErrorMessage(social.error.kind, copy)}</Alert> : null}
    {social.success ? <Alert variant="success">Social directory updated.</Alert> : null}
    {!social.currentProfile && !profile.isSelf ? <Card><h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.joinTitle}</h2><p className="mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400">{copy.joinBody}</p><Button type="button" size="sm" className="mt-3" disabled={social.pendingKeys.has('register')} onClick={() => void social.register()}>{copy.joinAction}</Button></Card> : null}
    <Card><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div className="flex min-w-0 items-start gap-3"><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-lg font-semibold text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">{name.slice(0, 1).toUpperCase()}</span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h1 className="truncate text-xl font-semibold text-neutral-900 dark:text-neutral-50">{name}</h1><span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">{profile.access === 'open' ? copy.open : copy.private}</span></div><p className="mt-1 text-sm text-neutral-500">@{profile.username}{profile.country ? ` · ${profile.country}` : ''}</p><p className="mt-1 text-xs text-neutral-500">{profile.averageRating == null ? copy.noRating : `${profile.averageRating.toFixed(1)} / 5 · ${profile.reviewCount} reviews`}</p></div></div><dl className="grid grid-cols-2 gap-6"><div><dt className="text-xs text-neutral-500">{copy.followers}</dt><dd className="mt-1 text-sm font-semibold">{profile.followerCount}</dd></div><div><dt className="text-xs text-neutral-500">{copy.following}</dt><dd className="mt-1 text-sm font-semibold">{profile.followingCount}</dd></div></dl>{profile.isSelf ? <AccessSelect profile={profile} copy={copy} pending={social.pendingKeys.has('access')} onChange={access => void social.setAccess(access)} /> : <FollowButton profile={profile} copy={copy} pending={outgoingPending} eligible={Boolean(social.currentProfile)} onFollow={() => void social.follow(profile.profileUserId)} onRemove={() => void social.remove(profile.profileUserId)} />}</div></Card>
    <SocialTradeHistoryPanel traderUserId={profile.profileUserId} isSelf={profile.isSelf} />
    <TraderReviews traderUserId={profile.profileUserId} traderName={profile.displayName} isSelf={profile.isSelf} averageRating={profile.averageRating} reviewCount={profile.reviewCount} expanded />
    <SocialCopyPanel traderUserId={profile.profileUserId} isSelf={profile.isSelf} />
  </div>
}
