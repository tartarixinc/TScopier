import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Star } from 'lucide-react'
import { AccountKindBadge } from '../../components/social/AccountKindBadge'
import { ProviderShareCard } from '../../components/social/ProviderShareCard'
import { SocialProfileLinks } from '../../components/social/SocialProfileLinks'
import { TscopierLogo } from '../../components/ui/TscopierLogo'
import { useAuth } from '../../context/AuthContext'
import { platformIconSrc } from '../../lib/activityRoute'
import { formatAccountAmount, snapshotFreshness } from '../../lib/providerApplication'
import { fetchProviderPublicProfile, type ProviderPublicProfile } from '../../lib/providerPublicProfile'
import { normalizeCopyPriceCents } from '../../lib/socialCopyPrice'
import { supabase } from '../../lib/supabase'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <dt className="text-xs text-neutral-600 dark:text-neutral-400">{label}</dt>
      <dd className="mt-1 text-base font-semibold text-neutral-900 dark:text-neutral-50">{children}</dd>
    </div>
  )
}

export function ProviderPublicProfilePage() {
  const { slug = '' } = useParams()
  const { user, loading: authLoading } = useAuth()
  const [result, setResult] = useState<{ slug: string; profile: ProviderPublicProfile | null; error: string | null } | null>(null)

  useEffect(() => {
    let active = true
    fetchProviderPublicProfile(supabase, slug)
      .then(profile => { if (active) setResult({ slug, profile, error: null }) })
      .catch(cause => { if (active) setResult({ slug, profile: null, error: cause instanceof Error ? cause.message : 'Unable to load this provider.' }) })
    return () => { active = false }
  }, [slug])

  const state = result && result.slug === slug ? { loading: false, ...result } : { loading: true, profile: null as ProviderPublicProfile | null, error: null as string | null }
  const { profile } = state
  useEffect(() => {
    if (!profile) return undefined
    const previous = document.title
    document.title = `${profile.displayName} — Copy trading on TScopier`
    return () => { document.title = previous }
  }, [profile])

  const isOwner = user?.id != null && profile?.profileUserId === user.id
  const price = profile?.monthlyCopyPriceCents == null ? null : normalizeCopyPriceCents(profile.monthlyCopyPriceCents)
  const freshness = snapshotFreshness(profile?.snapshotAt)
  const icon = profile?.platform ? platformIconSrc(profile.platform) : null

  return (
    <div className="min-h-dvh overflow-y-auto bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-50">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5">
        <TscopierLogo />
        <div className="flex items-center gap-3 text-sm">
          {authLoading ? null : user ? (
            <Link to="/social-trading" className="font-medium text-green-700 hover:underline dark:text-green-400">Open Social Trading</Link>
          ) : (
            <>
              <Link to="/login" className="font-medium text-neutral-700 hover:underline dark:text-neutral-300">Log in</Link>
              <Link to="/signup" className="rounded-lg bg-green-400 px-3 py-1.5 font-medium text-neutral-950 hover:bg-green-500">Sign up</Link>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 pb-16">
        {state.loading ? (
          <p className="py-16 text-center text-sm text-neutral-600 dark:text-neutral-400">Loading provider…</p>
        ) : state.error ? (
          <p role="alert" className="py-16 text-center text-sm text-error-600">{state.error}</p>
        ) : !profile ? (
          <div className="py-16 text-center">
            <h1 className="text-lg font-semibold">Provider not found</h1>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">This profile does not exist or is not public.</p>
            <Link to="/" className="mt-4 inline-block text-sm font-medium text-green-700 hover:underline dark:text-green-400">Go to TScopier</Link>
          </div>
        ) : (
          <>
            <section className="rounded-2xl border border-neutral-200 bg-white p-6 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-green-100 text-xl font-semibold text-green-800 dark:bg-green-950/50 dark:text-green-300" aria-hidden="true">
                  {profile.displayName.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-xl font-semibold">{profile.displayName}</h1>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {profile.username ? `@${profile.username}` : ''}{profile.country ? ` · ${profile.country}` : ''}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <AccountKindBadge kind={profile.accountKind} />
                    {profile.platform && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">
                        {icon && <img src={icon} alt="" className="h-4 w-4 object-contain" />}{profile.platform}
                      </span>
                    )}
                    {profile.access === 'private' && (
                      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200">Approval required</span>
                    )}
                  </div>
                  <SocialProfileLinks links={profile.socialLinks} />
                </div>
              </div>
              {profile.bio && <p className="mt-4 whitespace-pre-line text-sm text-neutral-800 dark:text-neutral-200">{profile.bio}</p>}
            </section>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Balance">{formatAccountAmount(profile.balance, profile.currency)}</Stat>
              <Stat label="Equity">{formatAccountAmount(profile.equity, profile.currency)}</Stat>
              <Stat label="Price">{price == null ? '\u2014' : price === 0 ? 'Free' : `$${(price / 100).toFixed(2)} / month`}</Stat>
              <Stat label="Followers">{profile.followerCount.toLocaleString()}</Stat>
              <Stat label="Rating">
                {profile.averageRating == null ? '\u2014' : (
                  <span className="inline-flex items-center gap-1"><Star className="h-4 w-4 fill-current text-amber-400" aria-hidden="true" />{profile.averageRating.toFixed(1)} <span className="text-xs font-normal text-neutral-600 dark:text-neutral-400">({profile.reviewCount})</span></span>
                )}
              </Stat>
              <Stat label="Data">
                <span className="text-sm">{freshness === 'fresh' ? 'Up to date' : freshness === 'stale' ? 'Stale' : 'Unavailable'}</span>
              </Stat>
            </dl>

            {isOwner ? (
              <ProviderShareCard slug={profile.slug} name={profile.displayName} />
            ) : (
              <section className="rounded-2xl border border-green-200 bg-green-50 p-5 text-center dark:border-green-900 dark:bg-green-950/20">
                <p className="text-sm font-medium">
                  {user ? 'See the full trading history and copy this provider.' : 'Create a free account to follow or copy this provider.'}
                </p>
                <Link
                  to={user ? `/social-trading/${profile.profileUserId}` : '/signup'}
                  className="mt-3 inline-flex rounded-lg bg-green-400 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-green-500"
                >
                  {user ? 'View full profile' : 'Sign up to follow'}
                </Link>
              </section>
            )}
            <p className="text-center text-xs text-neutral-600 dark:text-neutral-400">
              Past performance does not guarantee future results. Copy trading carries risk of loss.
            </p>
          </>
        )}
      </main>
    </div>
  )
}
