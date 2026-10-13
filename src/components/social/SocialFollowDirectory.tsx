import { Link, useSearchParams } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { useSocialFollow } from '../../hooks/useSocialFollow'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import type { SocialDirectoryProfile, SocialFollowErrorKind } from '../../lib/socialFollow'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

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

function FollowButton({
  profile,
  copy,
  pending,
  eligible,
  onFollow,
  onRemove,
}: {
  profile: SocialDirectoryProfile
  copy: SocialTradingPageTranslations
  pending: boolean
  eligible: boolean
  onFollow: () => void
  onRemove: () => void
}) {
  const active = profile.viewerRelationshipStatus === 'accepted' || profile.viewerRelationshipStatus === 'pending'
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'secondary' : 'primary'}
      disabled={pending || (!eligible && !active)}
      onClick={active ? onRemove : onFollow}
    >
      {relationshipLabel(profile, copy)}
    </Button>
  )
}

function AccessSelect({
  profile,
  copy,
  pending,
  onChange,
}: {
  profile: SocialDirectoryProfile
  copy: SocialTradingPageTranslations
  pending: boolean
  onChange: (access: 'open' | 'private') => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
      <span>{copy.followAccess}</span>
      <select
        value={profile.access}
        disabled={pending}
        onChange={event => onChange(event.target.value as 'open' | 'private')}
        className="rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-sm text-neutral-800 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
      >
        <option value="open">{copy.anyoneCanFollow}</option>
        <option value="private">{copy.requestsRequired}</option>
      </select>
    </label>
  )
}

export function SocialFollowDirectory({ copy }: { copy: SocialTradingPageTranslations }) {
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const social = useSocialFollow()
  const view = params.get('view') === 'followers'
    ? 'followers'
    : params.get('view') === 'following'
      ? 'following'
      : 'all'

  const visibleProfiles = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return social.profiles.filter(profile => {
      if (profile.isSelf) return view === 'all'
      if (view === 'followers' && profile.followsViewerStatus !== 'accepted') return false
      if (view === 'following' && profile.viewerRelationshipStatus !== 'accepted') return false
      if (!needle) return true
      return profile.displayName.toLowerCase().includes(needle) || profile.username.toLowerCase().includes(needle)
    })
  }, [query, social.profiles, view])

  const incoming = social.profiles.filter(profile => !profile.isSelf && profile.followsViewerStatus === 'pending')
  const outgoingPending = social.profiles.filter(profile => profile.viewerRelationshipStatus === 'pending').length
  const self = social.currentProfile

  return (
    <section className="space-y-4" aria-labelledby="live-social-directory-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="live-social-directory-heading" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{copy.liveDirectory}</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{copy.performanceUnavailable}</p>
        </div>
        {social.error && !social.loading ? (
          <Button type="button" size="sm" variant="secondary" onClick={() => void social.refresh()}>{copy.retry}</Button>
        ) : null}
      </div>

      {social.error ? <Alert variant="error">{socialErrorMessage(social.error.kind, copy)}</Alert> : null}

      {!social.loading && !self ? (
        <Card>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.joinTitle}</h3>
          <p className="mt-1 text-sm leading-6 text-neutral-500 dark:text-neutral-400">{copy.joinBody}</p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            disabled={social.pendingKeys.has('register')}
            onClick={() => void social.register()}
          >
            {copy.joinAction}
          </Button>
        </Card>
      ) : null}

      {self ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card><p className="text-xs text-neutral-500">{copy.following}</p><p className="mt-1 text-xl font-semibold">{self.followingCount}</p></Card>
          <Card><p className="text-xs text-neutral-500">{copy.followers}</p><p className="mt-1 text-xl font-semibold">{self.followerCount}</p></Card>
          <Card><p className="text-xs text-neutral-500">{copy.requests}</p><p className="mt-1 text-xl font-semibold">{outgoingPending}</p></Card>
          <Card>
            <AccessSelect
              profile={self}
              copy={copy}
              pending={social.pendingKeys.has('access')}
              onChange={access => void social.setAccess(access)}
            />
          </Card>
        </div>
      ) : null}

      {self && incoming.length > 0 ? (
        <Card padding="none" className="overflow-hidden">
          <h3 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold dark:border-neutral-800">{copy.followRequests}</h3>
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {incoming.map(profile => {
              const pending = social.pendingKeys.has(`incoming:${profile.profileUserId}`)
              return (
                <li key={profile.profileUserId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div><p className="text-sm font-medium">{profile.displayName}</p><p className="text-xs text-neutral-500">@{profile.username}</p></div>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={pending} onClick={() => void social.resolve(profile.profileUserId, 'accepted')}>{copy.accept}</Button>
                    <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => void social.resolve(profile.profileUserId, 'declined')}>{copy.decline}</Button>
                  </div>
                </li>
              )
            })}
          </ul>
        </Card>
      ) : null}

      <input
        type="search"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder={copy.searchPlaceholder}
        className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950 sm:max-w-xs"
      />

      <Card padding="none" className="overflow-hidden">
        {social.loading ? (
          <p className="px-4 py-8 text-sm text-neutral-500">{copy.loadingDirectory}</p>
        ) : visibleProfiles.length === 0 ? (
          <p className="px-4 py-8 text-sm text-neutral-500">{copy.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead><tr className="border-b border-neutral-100 text-left text-xs text-neutral-500 dark:border-neutral-800"><th className="px-4 py-3">{copy.colName}</th><th className="px-3 py-3">{copy.visibility}</th><th className="px-3 py-3">{copy.followers}</th><th className="px-3 py-3">{copy.following}</th><th className="px-4 py-3 text-end">{copy.colActions}</th></tr></thead>
              <tbody>
                {visibleProfiles.map(profile => {
                  const pending = social.pendingKeys.has(`outgoing:${profile.profileUserId}`)
                  return (
                    <tr key={profile.profileUserId} className="border-t border-neutral-100 dark:border-neutral-800">
                      <td className="px-4 py-3"><Link className="font-medium text-neutral-900 hover:text-teal-700 dark:text-neutral-50" to={`/social-trading/${profile.profileUserId}`}>{profile.isSelf ? copy.you : profile.displayName}</Link><p className="text-xs text-neutral-500">@{profile.username}{profile.country ? ` Â· ${profile.country}` : ''}</p></td>
                      <td className="px-3 py-3">{profile.access === 'open' ? copy.open : copy.private}</td>
                      <td className="px-3 py-3">{profile.followerCount}</td>
                      <td className="px-3 py-3">{profile.followingCount}</td>
                      <td className="px-4 py-3 text-end">
                        {profile.isSelf ? (
                          <AccessSelect profile={profile} copy={copy} pending={social.pendingKeys.has('access')} onChange={access => void social.setAccess(access)} />
                        ) : (
                          <FollowButton profile={profile} copy={copy} pending={pending} eligible={Boolean(self)} onFollow={() => void social.follow(profile.profileUserId)} onRemove={() => void social.remove(profile.profileUserId)} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  )
}

export function SocialFollowProfile({ profileUserId, copy }: { profileUserId: string; copy: SocialTradingPageTranslations }) {
  const social = useSocialFollow()
  const profile = social.profiles.find(item => item.profileUserId === profileUserId) ?? null

  if (social.loading) return <Card><p className="text-sm text-neutral-500">{copy.loadingDirectory}</p></Card>
  if (social.error) return <Alert variant="error">{socialErrorMessage(social.error.kind, copy)}</Alert>
  if (!profile) return <Card><p className="text-sm text-neutral-500">{copy.notFound}</p></Card>

  const outgoingPending = social.pendingKeys.has(`outgoing:${profile.profileUserId}`)
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">{profile.isSelf ? copy.you : profile.displayName}</h1>
            <p className="mt-1 text-sm text-neutral-500">@{profile.username}{profile.country ? ` Â· ${profile.country}` : ''}</p>
            <p className="mt-3 text-sm text-neutral-500">{copy.performanceUnavailable}</p>
          </div>
          {profile.isSelf ? (
            <AccessSelect profile={profile} copy={copy} pending={social.pendingKeys.has('access')} onChange={access => void social.setAccess(access)} />
          ) : (
            <FollowButton profile={profile} copy={copy} pending={outgoingPending} eligible={Boolean(social.currentProfile)} onFollow={() => void social.follow(profile.profileUserId)} onRemove={() => void social.remove(profile.profileUserId)} />
          )}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3">
        <Card><p className="text-xs text-neutral-500">{copy.followers}</p><p className="mt-1 text-xl font-semibold">{profile.followerCount}</p></Card>
        <Card><p className="text-xs text-neutral-500">{copy.following}</p><p className="mt-1 text-xl font-semibold">{profile.followingCount}</p></Card>
      </div>
    </div>
  )
}

