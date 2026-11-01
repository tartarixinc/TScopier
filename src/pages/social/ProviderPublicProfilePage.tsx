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
import { ProviderPublicPerformance } from '../../components/social/ProviderPublicPerformance'
import {
  fetchProviderPublicPerformance,
  fetchProviderPublicProfile,
  fetchProviderPublicTrades,
  type ProviderPublicPerformance as PublicPerformance,
  type ProviderPublicProfile,
  type ProviderPublicTrade,
} from '../../lib/providerPublicProfile'
import { providerCopyLandingPath, stashPostAuthRedirect } from '../../lib/postAuthRedirect'
import { appUrl, withQuery } from '../../lib/site'
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

  const [data, setData] = useState<{
    slug: string
    performance: PublicPerformance | null
    trades: ProviderPublicTrade[]
    tradesError: string | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    let active = true
    void Promise.allSettled([
      fetchProviderPublicPerformance(supabase, slug),
      fetchProviderPublicTrades(supabase, slug, 250),
    ]).then(([performance, trades]) => {
      if (!active) return
      setData({
        slug,
        performance: performance.status === 'fulfilled' ? performance.value : null,
        trades: trades.status === 'fulfilled' ? trades.value : [],
        tradesError: trades.status === 'rejected' ? (trades.reason instanceof Error ? trades.reason.message : 'Unable to load trades.') : null,
        error: performance.status === 'rejected' ? (performance.reason instanceof Error ? performance.reason.message : 'Unable to load performance.') : null,
      })
    })
    return () => { active = false }
  }, [slug])
  const publicData = data && data.slug === slug ? data : null

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
  const landing = profile ? providerCopyLandingPath(profile.profileUserId) : null
  // Same-origin hint for the app host; the `next` param carries it across origins (marketing -> app).
  const rememberLanding = () => { if (landing) stashPostAuthRedirect(landing) }
  const authHref = (path: '/login' | '/signup') => landing ? withQuery(appUrl(path), { next: landing }) : appUrl(path)

  return (
    <div className="min-h-dvh overflow-y-auto bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-50">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5">
        <TscopierLogo className="h-9 w-auto sm:h-10" />
        <div className="flex items-center gap-3 text-sm">
          {authLoading ? null : user ? (
            <a href={appUrl('/social-trading')} className="font-medium text-green-700 hover:underline dark:text-green-400">Open Social Trading</a>
          ) : (
            <>
              <a href={authHref('/login')} onClick={rememberLanding} className="font-medium text-neutral-700 hover:underline dark:text-neutral-300">Log in</a>
              <a href={authHref('/signup')} onClick={rememberLanding} className="rounded-lg bg-green-400 px-3 py-1.5 font-medium text-neutral-950 hover:bg-green-500">Sign up</a>
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

            {!publicData ? (
              <p className="py-6 text-center text-sm text-neutral-600 dark:text-neutral-400">Loading performance…</p>
            ) : publicData.performance?.shared ? (
              <ProviderPublicPerformance performance={publicData.performance} trades={publicData.trades} tradesError={publicData.tradesError} />
            ) : (
              <section className="rounded-2xl border border-neutral-200 bg-white p-5 text-center text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
                {publicData.error ?? 'This provider has not made their trading history public.'}
              </section>
            )}

            {isOwner ? (
              <ProviderShareCard slug={profile.slug} name={profile.displayName} shareTradeHistory={publicData ? publicData.performance?.shared ?? null : null} manageHref={`/social-trading/${profile.profileUserId}`} />
            ) : (
              <section className="sticky bottom-3 rounded-2xl border border-green-200 bg-green-50 p-5 text-center shadow-sm dark:border-green-900 dark:bg-green-950/80">
                <p className="text-sm font-medium">
                  {user ? 'Copy this provider’s trades to your own account.' : 'Create a free account to follow or copy this provider.'}
                </p>
                <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
                  <a
                    href={user ? appUrl(providerCopyLandingPath(profile.profileUserId)) : authHref('/signup')}
                    onClick={user ? undefined : rememberLanding}
                    className="inline-flex rounded-lg bg-green-400 px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-green-500"
                  >
                    {user ? 'Copy this provider' : 'Sign up to copy'}
                  </a>
                  {!user && (
                    <a href={authHref('/login')} onClick={rememberLanding} className="text-sm font-medium text-neutral-800 hover:underline dark:text-neutral-200">
                      I already have an account
                    </a>
                  )}
                </div>
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
