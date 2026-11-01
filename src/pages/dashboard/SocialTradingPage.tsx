import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BarChart3, ChevronRight, LineChart, Wallet, X } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import clsx from 'clsx'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { PageHeader } from '../../components/layout/PageHeader'
import { CopyTraderModal } from '../../components/social/CopyTraderModal'
import { TraderReviews } from '../../components/social/TraderReviews'
import { SocialProfileLinks } from '../../components/social/SocialProfileLinks'
import { PageShell } from '../../components/layout/PageShell'
import { PerformanceTradeOutcomeChart } from '../../components/performance/PerformanceTradeOutcomeChart'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Alert } from '../../components/ui/Alert'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useAuth } from '../../context/AuthContext'
import { useLocale, useT } from '../../context/LocaleContext'
import { useUserProfile } from '../../context/UserProfileContext'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import { useTheme } from '../../context/ThemeContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useSocialTradingPreview } from '../../hooks/useSocialTradingPreview'
import { useOwnSocialAccountView } from '../../hooks/useOwnSocialAccountView'
import { interpolate } from '../../i18n/interpolate'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'
import { copyPriceOfferLabel } from '../../lib/socialCopyPrice'
import { canOpenCopyTrader, copyTraderUnavailableReason } from '../../lib/socialCopyAvailability'
import { OwnAccountSelector } from '../../components/social/OwnAccountSelector'

import { resolveUserAvatarUrl } from '../../lib/userAvatar'
import {
  socialTraderStats,
  type SocialAccess,
  type SocialCalendarDay,
  type SocialTradeSide,
  type SocialTrader,
  type SocialTraderStats,
} from '../../lib/socialTradingFixture'

type SortKey = 'roi' | 'winRate' | 'followers' | 'rating'
type DirectoryView = 'all' | 'followers' | 'following'

function useOwnAvatarUrl(): string | null {
  const { user } = useAuth()
  const { profile } = useUserProfile()
  return resolveUserAvatarUrl(user, profile)
}

function TraderAvatar({
  name,
  src,
  size,
}: {
  name: string
  src?: string | null
  size: 'row' | 'profile'
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showPhoto = Boolean(src && failedSrc !== src)

  return (
    <span
      className={clsx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-100 font-semibold text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50',
        size === 'profile' ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-sm',
      )}
    >
      {showPhoto ? (
        <img
          src={src!}
          alt=""
          className="h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setFailedSrc(src ?? null)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  )
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function percent(value: number | null): string {
  return value == null ? 'Unavailable' : `${value.toFixed(1)}%`
}

function SideLabel({ side, buy, sell }: { side: SocialTradeSide; buy: string; sell: string }) {
  const isBuy = side === 'buy'
  return (
    <span className={clsx('text-xs font-medium', isBuy ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
      {isBuy ? buy : sell}
    </span>
  )
}

export function SocialTradingPage() {
  const t = useT()
  const copy = t.socialTradingPage
  const navigate = useNavigate()
  const { formatMoney } = useFormatMoney()
  const { openAddTradingAccount } = useAddTradingAccount()
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('roi')
  const [visibility, setVisibility] = useState<'all' | SocialAccess>('all')
  const [requestsOnly, setRequestsOnly] = useState(false)
  const social = useSocialTradingPreview()
  const [setupTrader, setSetupTrader] = useState<SocialTrader | null>(null)
  const ownAvatarUrl = useOwnAvatarUrl()
  const view: DirectoryView = params.get('view') === 'followers'
    ? 'followers'
    : params.get('view') === 'following'
      ? 'following'
      : 'all'

  const access = social.currentProfile?.access ?? 'open'
  const traders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = social.traders.filter(trader => {
      const relationship = social.profiles.find(profile => profile.profileUserId === trader.id)
      if (view === 'followers' && relationship?.followsViewerStatus !== 'accepted') return false
      if (view === 'following' && relationship?.viewerRelationshipStatus !== 'accepted') return false
      if (visibility !== 'all' && trader.access !== visibility) return false
      if (requestsOnly && relationship?.viewerRelationshipStatus !== 'pending') return false
      if (!needle) return true
      return trader.displayName.toLowerCase().includes(needle) || trader.username.toLowerCase().includes(needle)
    })
    const rank = (trader: SocialTrader) => {
      if (sort === 'winRate') return trader.winRate ?? -1
      if (sort === 'followers') return trader.followerCount
      if (sort === 'rating') return trader.rating ?? -1
      return trader.roi ?? -1
    }
    return filtered.slice().sort((a, b) => {
      if (a.isYou !== b.isYou) return a.isYou ? -1 : 1
      return rank(b) - rank(a)
    })
  }, [query, requestsOnly, social.profiles, social.traders, sort, view, visibility])

  const chooseAccess = (value: SocialAccess) => {
    void social.setAccess(value)
  }

  const heading = view === 'followers' ? copy.tabFollowers : view === 'following' ? copy.tabFollowing : copy.tabProviders
  const openCount = social.traders.filter(trader => trader.access === 'open').length
  const privateCount = social.traders.length - openCount
  const followerCount = social.currentProfile?.followerCount ?? 0
  const requestCount = social.profiles.filter(profile => profile.viewerRelationshipStatus === 'pending').length
  const toggleVisibility = (next: SocialAccess) => {
    setVisibility(current => current === next ? 'all' : next)
  }

  const priceLabel = (cents: number | null) => cents == null ? 'Unavailable' : copyPriceOfferLabel(cents, formatMoney, {
    free: copy.priceFree,
    paid: copy.pricePerMonth,
  })

  return (
    <>
    <PageShell maxWidth="xl">
      <nav className="flex gap-6 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800" aria-label={copy.title}>
        <DirectoryTab to="/social-trading" active={view === 'all'}>{copy.tabProviders}</DirectoryTab>
        <DirectoryTab to="/social-trading?view=followers" active={view === 'followers'}>{copy.tabFollowers}</DirectoryTab>
        <DirectoryTab to="/social-trading?view=following" active={view === 'following'}>{copy.tabFollowing}</DirectoryTab>
      </nav>
      <PageHeader title={heading} />
      {!social.loading && !social.currentProfile ? (
        <Card>
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.joinTitle}</h2>
          <p className="mt-1 text-sm text-neutral-900 dark:text-neutral-50">{copy.joinBody}</p>
          <Button type="button" size="sm" className="mt-3" disabled={social.pendingKeys.has('register')} onClick={() => void social.register()}>{copy.joinAction}</Button>
        </Card>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <SummaryStat label={copy.open} value={openCount} selected={visibility === 'open'} onClick={() => toggleVisibility('open')} />
        <SummaryStat label={copy.private} value={privateCount} selected={visibility === 'private'} onClick={() => toggleVisibility('private')} />
        <SummaryStat label={copy.following} value={social.profiles.filter(profile => profile.viewerRelationshipStatus === 'accepted').length} selected={view === 'following'} onClick={() => navigate('/social-trading?view=following')} />
        <SummaryStat label={copy.followers} value={followerCount} selected={view === 'followers'} onClick={() => navigate('/social-trading?view=followers')} />
        <SummaryStat label={copy.requests} value={requestCount} selected={requestsOnly} onClick={() => setRequestsOnly(current => !current)} />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50 sm:max-w-xs"
        />
        <select
          value={visibility}
          aria-label={copy.visibility}
          onChange={event => setVisibility(event.target.value === 'open' || event.target.value === 'private' ? event.target.value : 'all')}
          className="rounded-full border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50"
        >
          <option value="all">{copy.visibility}: {copy.visibilityAll}</option>
          <option value="open">{copy.visibility}: {copy.open}</option>
          <option value="private">{copy.visibility}: {copy.private}</option>
        </select>
        <select
          value={sort}
          onChange={event => setSort(event.target.value as SortKey)}
          className="rounded-full border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50"
        >
          <option value="roi">{copy.sortRoi}</option>
          <option value="winRate">{copy.sortWinRate}</option>
          <option value="followers">{copy.sortFollowers}</option>
          <option value="rating">{copy.sortRating}</option>
        </select>
      </div>
      <Card padding="none" className="overflow-hidden">
        {traders.length === 0 ? (
          <p className="px-4 py-8 text-sm text-neutral-900 dark:text-neutral-50">{copy.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-xs font-medium text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
                  <th className="px-4 py-3">{copy.colName}</th>
                  <th className="px-3 py-3">{copy.colStatus}</th>
                  <th className="px-3 py-3">{copy.roi}</th>
                  <th className="px-3 py-3">{copy.winRate}</th>
                  <th className="px-3 py-3">{copy.followers}</th>
                  <th className="px-3 py-3">{copy.colBalance}</th>
                  <th className="px-3 py-3">{copy.colPrice}</th>
                  <th className="px-4 py-3 text-end"><span className="sr-only">{copy.colActions}</span></th>
                </tr>
              </thead>
              <tbody>
                {traders.map(trader => {
                  const traderAccess = trader.isYou ? access : trader.access
                  const rank = trader.profile.rank ?? '—'
                  const name = trader.isYou ? copy.you : trader.displayName
                  return (
                    <tr
                      key={trader.id}
                      role="link"
                      tabIndex={0}
                      aria-label={name}
                      className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-400 dark:border-neutral-800 dark:hover:bg-neutral-900"
                      onClick={() => navigate(`/social-trading/${trader.id}`)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          navigate(`/social-trading/${trader.id}`)
                        }
                      }}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <TraderAvatar name={name} src={trader.isYou ? ownAvatarUrl : null} size="row" />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-neutral-900 dark:text-neutral-50">{name}</p>{trader.syntheticDemo ? <span className="ms-2 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">Synthetic demo</span> : null}
                            <TraderReviews traderUserId={trader.id} traderName={trader.displayName} isSelf={trader.isYou} averageRating={trader.rating} reviewCount={trader.ratingCount} />
                            <p className="truncate text-xs text-neutral-900 dark:text-neutral-50">
                              #{rank} · {traderAccess === 'open' ? copy.open : copy.private}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          {trader.syntheticDemo ? 'Synthetic demo' : trader.performanceStatus === 'available' ? copy.statusActive : 'Unavailable'}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-medium text-neutral-900 dark:text-neutral-100">{percent(trader.roi)}</td>
                      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">{percent(trader.winRate)}</td>
                      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">{trader.followerCount}</td>
                      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">{trader.previewBalance == null ? 'Unavailable' : formatMoney(trader.previewBalance)}</td>
                      <td className="px-3 py-3 font-medium text-neutral-900 dark:text-neutral-100">
                        {priceLabel(trader.monthlyCopyPriceCents)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {trader.isYou ? (
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <AccessChoice access={access} copy={copy} onChange={chooseAccess} />
                           </div>
                          ) : (
                            <CopyActionButton
                              disabled={!canOpenCopyTrader(trader)}
                              disabledReason={copyTraderUnavailableReason(trader) ?? undefined}
                              copyLabel={copy.copySetup.action}
                              onOpenSetup={() => setSetupTrader(trader)}
                            />
                          )}
                          <ChevronRight className="h-4 w-4 text-neutral-900 dark:text-neutral-50" aria-hidden="true" />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </PageShell>
    {setupTrader ? (
      <CopyTraderModal
        trader={setupTrader}
        copy={copy}
        onClose={() => setSetupTrader(null)}
        onConnectBroker={() => {
          setSetupTrader(null)
          openAddTradingAccount({ asDestination: true })
        }}
      />
    ) : null}
    </>
  )
}

function DirectoryTab({ to, active, children }: { to: string; active: boolean; children: string }) {
  return (
    <Link
      to={to}
      className={clsx(
        '-mb-px shrink-0 border-b-2 pb-3 text-sm font-medium',
        active
          ? 'border-neutral-900 text-neutral-900 dark:border-neutral-50 dark:text-neutral-50'
          : 'border-transparent text-neutral-900 hover:text-neutral-900 dark:text-neutral-50 dark:hover:text-neutral-50',
      )}
    >
      {children}
    </Link>
  )
}

function SummaryStat({
  label,
  value,
  selected,
  onClick,
}: {
  label: string
  value: number
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'rounded-xl border bg-white px-4 py-3 text-left transition-colors dark:bg-neutral-950',
        selected
          ? 'border-neutral-900 dark:border-neutral-100'
          : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700',
      )}
    >
      <span className="block text-sm text-neutral-900 dark:text-neutral-50">{label}</span>
      <span className="mt-2 block text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{value}</span>
    </button>
  )
}

function AccessTag({
  access,
  openLabel,
  privateLabel,
}: {
  access: SocialAccess
  openLabel: string
  privateLabel: string
}) {
  const isOpen = access === 'open'
  return (
    <span
      className={clsx(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        isOpen
          ? 'bg-teal-50 text-green-500 dark:bg-teal-950/50 dark:text-teal-300'
          : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-50',
      )}
    >
      {isOpen ? openLabel : privateLabel}
    </span>
  )
}

function AccessChoice({
  access,
  copy,
  onChange,
  labelled = false,
}: {
  access: SocialAccess
  copy: { whoCanCopy: string; anyoneCanCopy: string; requestsRequired: string }
  onChange: (access: SocialAccess) => void
  labelled?: boolean
}) {
  return (
    <label
      className="relative z-10 flex shrink-0 flex-col gap-1 text-xs text-neutral-900 dark:text-neutral-50"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      {labelled ? <span>{copy.whoCanCopy}</span> : <span className="sr-only">{copy.whoCanCopy}</span>}
      <select
        value={access}
        aria-label={copy.whoCanCopy}
        onChange={event => onChange(event.target.value === 'private' ? 'private' : 'open')}
        className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50"
      >
        <option value="open">{copy.anyoneCanCopy}</option>
        <option value="private">{copy.requestsRequired}</option>
      </select>
    </label>
  )
}

function CopyActionButton({
  copyLabel,
  disabled = false,
  disabledReason,
  onOpenSetup,
}: {
  copyLabel: string
  disabled?: boolean
  disabledReason?: string
  onOpenSetup: () => void
}) {
  return (
    <div className={'flex flex-col items-end gap-1'}>
    <Button
      type="button"
      size="sm"
      variant="primary"
      disabled={disabled}
      title={disabledReason}
      onClick={event => {
        event.stopPropagation()
        onOpenSetup()
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      {copyLabel}
    </Button>
    <p className={'max-w-64 text-right text-xs leading-4 text-neutral-500'} role={'status'}>{disabledReason}</p>
    </div>
  )
}

function PerformanceNotice({ loading, trader }: { loading: boolean, trader: SocialTrader }) {
  if (loading) return <Alert variant={'warning'}>Loading source-scoped performance and trade history...</Alert>
  if (trader.performanceError) return <Alert variant={'error'}>{trader.performanceError}</Alert>
  if (trader.performanceStatus === 'no_history') return <Alert variant={'warning'}>Verified source history contains no trades yet.</Alert>
  if (trader.performanceStatus === 'pending') return <Alert variant={'warning'}>Source history synchronization has not completed yet. Statistics remain unavailable.</Alert>
  if (trader.performanceStatus === 'incomplete') return <Alert variant={'warning'}>Source history is incomplete. Known trades are shown, but historical totals remain unavailable.</Alert>
  if (trader.performanceStatus === 'unavailable') return <Alert variant={'warning'}>Source performance is unavailable.</Alert>
  if (trader.performanceStatus === 'stale') return <Alert variant={'warning'}>Source history is stale. Historical values are shown and copying remains unavailable until synchronization succeeds.</Alert>
  return null
}

export function SocialTraderActivityPage() {
  const t = useT()
  const copy = t.socialTradingPage
  const { formatMoney, formatSignedMoney } = useFormatMoney()
  const { locale } = useLocale()
  const { openAddTradingAccount } = useAddTradingAccount()
  const { traderId } = useParams()
  const social = useSocialTradingPreview()
  const directoryTrader = traderId ? social.traders.find(item => item.id === traderId) : undefined
  const [selectedOwnAccountId, setSelectedOwnAccountId] = useState('')
  const ownAccountView = useOwnSocialAccountView(directoryTrader, selectedOwnAccountId)
  const trader = ownAccountView.trader
  const ownAvatarUrl = useOwnAvatarUrl()
  const [copyModalOpen, setCopyModalOpen] = useState(false)
  const [profileTab, setProfileTab] = useState<'performance' | 'trading' | 'portfolio'>('performance')
  const access = social.currentProfile?.access ?? trader?.access ?? 'open'

  if (social.loading && !trader) {
    return <PageShell maxWidth="xl"><Card><p className="text-sm text-neutral-900 dark:text-neutral-50">{copy.loadingDirectory}</p></Card></PageShell>
  }

  if (!trader) {
    return (
      <PageShell maxWidth="xl">
        <PageHeader title={copy.title} />
        <Card>
          <p className="text-sm text-neutral-900 dark:text-neutral-50">{copy.notFound}</p>
          <Link to="/social-trading" className="mt-3 inline-block text-sm font-medium text-green-500 dark:text-teal-300">
            {copy.back}
          </Link>
        </Card>
      </PageShell>
    )
  }

  const chooseAccess = (value: SocialAccess) => {
    void social.setAccess(value)
  }

  const pendingRequests = social.profiles
    .filter(profile => profile.followsViewerStatus === 'pending')
    .map(profile => social.traders.find(person => person.id === profile.profileUserId))
    .filter((person): person is SocialTrader => Boolean(person))
  const stats = socialTraderStats(trader)
  const name = trader.isYou ? copy.you : trader.displayName
  const joined = trader.profile.joinedAt
    ? new Date(trader.profile.joinedAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Unavailable'

  return (
    <>
    <PageShell maxWidth="xl">
      <div>
        <Link to="/social-trading" className="text-sm font-medium text-green-500 hover:text-teal-800 dark:text-teal-300">
          {copy.back}
        </Link>
        <Card className="mt-3">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <TraderAvatar name={name} src={trader.isYou ? ownAvatarUrl : null} size="profile" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-semibold text-neutral-900 dark:text-neutral-50">{name}</h1>{trader.syntheticDemo ? <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">Synthetic demo · simulated copying</span> : null}
                  <AccessTag
                    access={trader.isYou ? access : trader.access}
                    openLabel={copy.open}
                    privateLabel={copy.private}
                  />
                </div>
                <p className="mt-1 text-sm text-neutral-900 dark:text-neutral-50">
                  #{trader.profile.rank ?? '—'} {copy.rank} · {copy.joined} {joined} · {trader.profile.country}
                </p>
                <div className="mt-1">
                  <TraderReviews traderUserId={trader.id} traderName={trader.displayName} isSelf={trader.isYou} averageRating={trader.rating} reviewCount={trader.ratingCount} />
                  <SocialProfileLinks links={trader.socialLinks ?? {}} />
                  <p className="mt-2 text-xs text-neutral-500">
                    Source: {trader.sourceLabel
                      ? [trader.sourceLabel, trader.sourcePlatform, trader.sourceAccountMode].filter(Boolean).join(' · ')
                      : 'Unavailable'}
                  </p>
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-4 sm:gap-8">
              <HeaderStat label={copy.aum} value="Unavailable" />
              <HeaderStat label={copy.followers} value={String(trader.followerCount)} />
              <HeaderStat label={copy.leverage} value={trader.profile.leverage ?? 'Unavailable'} />
            </dl>
            {trader.isYou ? (
              <div className="flex flex-wrap items-end gap-3">
                <AccessChoice access={access} copy={copy} onChange={chooseAccess} labelled />
             </div>
            ) : (
              <CopyActionButton
                disabled={!canOpenCopyTrader(trader)}
                disabledReason={copyTraderUnavailableReason(trader) ?? undefined}
                copyLabel={copy.copySetup.action}
                onOpenSetup={() => setCopyModalOpen(true)}
              />
            )}
          </div>
        </Card>
      </div>
      {trader.isYou ? (
        <OwnAccountSelector
          selectedAccountId={selectedOwnAccountId}
          onChange={setSelectedOwnAccountId}
          loading={ownAccountView.loading}
          error={ownAccountView.error}
        />
      ) : null}
      {trader.isYou && access === 'private' ? (
        <Card padding="none" className="overflow-hidden">
          <h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
            {copy.copyRequests}
          </h2>
          {pendingRequests.length === 0 ? (
            <p className="px-4 py-3 text-sm text-neutral-900 dark:text-neutral-50">{copy.copyRequestsEmpty}</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {pendingRequests.map(person => (
                <li key={person.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">{person.displayName}</p>
                    <p className="truncate text-sm text-neutral-900 dark:text-neutral-50">@{person.username}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" onClick={() => void social.resolve(person.id, 'accepted')}>
                      {copy.accept}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => void social.resolve(person.id, 'declined')}>
                      {copy.decline}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-4">
          <div className="flex gap-2 overflow-x-auto">
            <ProfileTab icon={<BarChart3 className="h-4 w-4" />} active={profileTab === 'performance'} onClick={() => setProfileTab('performance')}>{copy.tabPerformance}</ProfileTab>
            <ProfileTab icon={<LineChart className="h-4 w-4" />} active={profileTab === 'trading'} onClick={() => setProfileTab('trading')}>{copy.tabTrading}</ProfileTab>
            <ProfileTab icon={<Wallet className="h-4 w-4" />} active={profileTab === 'portfolio'} onClick={() => setProfileTab('portfolio')}>{copy.tabPortfolio}</ProfileTab>
          </div>
          <PerformanceNotice loading={social.performanceLoading} trader={trader} />
          {profileTab === 'performance' ? (
            <>
              <MonthlyProfitChart title={copy.monthlyStatistics} data={stats.monthly} />
              <StatisticsGrid trader={trader} stats={stats} copy={copy} formatMoney={formatMoney} />
              <PnlCalendar trader={trader} days={stats.calendar} locale={locale} copy={copy} formatSignedMoney={formatSignedMoney} />
            </>
          ) : null}
          {profileTab === 'trading' ? (
            <>
              <TradeTable
                title={copy.openTrades}
                whenLabel={copy.opened}
                rows={trader.openTrades.map(trade => ({
                  id: trade.id,
                  symbol: trade.symbol,
                  side: trade.side,
                  when: formatWhen(trade.openedAt),
                  result: null,
                }))}
                copy={copy}
                formatSignedMoney={formatSignedMoney}
              />
              <TradeTable
                title={copy.closedPerformance}
                whenLabel={copy.closed}
                rows={trader.closedPerformance.map(trade => ({
                  id: trade.id,
                  symbol: trade.symbol,
                  side: trade.side,
                  when: formatWhen(trade.closedAt),
                  result: trade.profit,
                }))}
                copy={copy}
                formatSignedMoney={formatSignedMoney}
              />
              <Card padding="none" className="overflow-hidden">
                <h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
                  {copy.lastActivities}
                </h2>
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {trader.activities.map(activity => (
                    <li key={activity.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                      <span className="font-medium text-neutral-900 dark:text-neutral-50">
                        {activity.kind === 'open' ? copy.opened : copy.closed}
                      </span>
                      <span className="text-neutral-900 dark:text-neutral-100">{activity.symbol}</span>
                      <SideLabel side={activity.side} buy={copy.buy} sell={copy.sell} />
                      <span className="text-neutral-900 dark:text-neutral-50">{formatWhen(activity.at)}</span>
                      {activity.profit != null ? (
                        <span className={clsx('ms-auto font-medium', activity.profit >= 0 ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
                          {formatSignedMoney(activity.profit)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          ) : null}
          {profileTab === 'portfolio' ? (
            <div className="grid gap-4">
              <AccountGrowthChart data={trader.chart.growth} series={trader.chart.series} />
              <PerformanceTradeOutcomeChart
                data={trader.chart.outcome}
                title={copy.closedPerformance}
                subtitle={t.performance.outcomeSubtitle}
                emptyLabel={t.performance.outcomeEmpty}
                profitLabel={t.dashboard.chartProfit}
                lossLabel={t.dashboard.chartLoss}
              />
            </div>
          ) : null}
        </div>
        <OverviewPanel
          trader={trader}
          stats={stats}
          copy={copy}
          formatMoney={formatMoney}
          formatSignedMoney={formatSignedMoney}
        />
      </div>
    </PageShell>
    {copyModalOpen ? (
      <CopyTraderModal
        trader={trader}
        copy={copy}
        onClose={() => setCopyModalOpen(false)}
        onConnectBroker={() => {
          setCopyModalOpen(false)
          openAddTradingAccount({ asDestination: true })
        }}
      />
    ) : null}
    </>
  )
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-900 dark:text-neutral-50">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50">{value}</dd>
    </div>
  )
}

function ProfileTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  children: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium',
        active
          ? 'bg-green-400 text-neutral-950'
          : 'text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function MonthlyProfitChart({ title, data }: { title: string; data: SocialTraderStats['monthly'] }) {
  const { formatAxisMoney } = useFormatMoney()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  const hasKnownPerformance = data.some(month => month.profit != null)
  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
      {!hasKnownPerformance ? <div className="mt-4 flex h-64 items-center justify-center rounded-lg border border-dashed border-neutral-200 px-6 text-center text-sm text-neutral-500 dark:border-neutral-700">Monthly performance is unavailable until complete verified history covers this period.</div> : <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height={256}>
          <BarChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: colors.tick }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: colors.tick }} axisLine={false} tickLine={false} tickFormatter={value => formatAxisMoney(Number(value))} width={48} />
            <Tooltip {...chartTooltipProps(colors)} formatter={(value, _name, item) => { const month = item.payload as SocialTraderStats['monthly'][number]; return value == null || month.profit == null ? ['Unavailable', 'Performance'] : [formatAxisMoney(Number(value)), month.state === 'no_activity' ? 'Verified no activity' : month.state === 'incomplete' ? 'Partial P/L' : 'P/L'] }} />
            <Bar dataKey="profit" fill="#4ade80" radius={[4, 4, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>}
      {hasKnownPerformance && data.some(month => month.state === 'incomplete' || month.state === 'unavailable') ? <p className="mt-2 text-xs text-neutral-500">Blank months are unavailable or outside complete verified history; they are not zero-performance months.</p> : null}
    </Card>
  )
}

function StatisticsGrid({
  trader,
  stats,
  copy,
  formatMoney,
}: {
  trader: SocialTrader
  stats: SocialTraderStats
  copy: SocialTradingPageTranslations
  formatMoney: (value: number) => string
}) {
  const growth = trader.roi == null ? 'Unavailable' : `${trader.roi.toFixed(2)}%`
  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.statisticsMonth}</h2>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
        <Metric label={copy.growth} value={growth} tone={trader.roi == null ? undefined : trader.roi >= 0 ? 'up' : 'down'} />
        <Metric label={copy.longTrades} value={stats.longTrades == null ? 'Unavailable' : String(stats.longTrades)} />
        <Metric label={copy.maxOpenTrades} value={stats.maxOpenTrades == null ? 'Unavailable' : String(stats.maxOpenTrades)} />
        <Metric label={copy.sharpeRatio} value={stats.sharpe == null ? 'Unavailable' : stats.sharpe.toFixed(2)} />
        <Metric label={copy.avgProfit} value={stats.avgProfit == null ? 'Unavailable' : formatMoney(stats.avgProfit)} />
        <Metric label={copy.shortTrades} value={stats.shortTrades == null ? 'Unavailable' : String(stats.shortTrades)} />
        <Metric label={copy.avgHoldingTime} value={stats.avgHoldingDays == null ? 'Unavailable' : interpolate(copy.holdingDays, { count: stats.avgHoldingDays })} />
        <Metric label={copy.profitFactor} value={stats.profitFactor == null ? 'Unavailable' : stats.profitFactor.toFixed(2)} />
      </dl>
    </Card>
  )
}

function PnlCalendar({
  trader,
  days,
  locale,
  copy,
  formatSignedMoney,
}: {
  trader: SocialTrader
  days: SocialCalendarDay[]
  locale: string
  copy: SocialTradingPageTranslations
  formatSignedMoney: (value: number) => string
}) {
  const [selected, setSelected] = useState<SocialCalendarDay | null>(null)
  const latestClose = trader.closedPerformance.reduce<Date | null>((pick, trade) => {
    const date = new Date(trade.closedAt)
    return Number.isNaN(date.getTime()) || (pick && pick >= date) ? pick : date
  }, null)
  const anchor = latestClose ?? new Date()
  const calendarYear = anchor.getUTCFullYear()
  const calendarMonth = anchor.getUTCMonth()
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 6 + index))
    return date.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })
  })
  const leading = new Date(Date.UTC(calendarYear, calendarMonth, 1)).getUTCDay()
  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.pnlCalendar}</h2>
      <div className="mt-4 grid grid-cols-7 gap-2">
        {weekdays.map(label => (
          <div key={label} className="pb-1 text-center text-[11px] font-medium text-neutral-900 dark:text-neutral-50">{label}</div>
        ))}
        {Array.from({ length: leading }, (_, index) => (
          <div key={`lead-${index}`} className="min-h-[72px] rounded-lg border border-neutral-100 px-2 py-2 text-xs text-neutral-900 dark:text-neutral-50 dark:border-neutral-800">
            <span>{32 - leading + index}</span>
            <p className="mt-2 text-[11px]">{copy.noTrades}</p>
          </div>
        ))}
        {days.map(day => {
          const quiet = day.profit == null
          const up = (day.profit ?? 0) >= 0
          return (
            <button
              key={day.day}
              type="button"
              onClick={() => setSelected(day)}
              className={clsx(
                'min-h-[72px] rounded-lg border px-2 py-2 text-start text-xs transition-colors',
                quiet
                  ? 'border-neutral-100 text-neutral-900 dark:text-neutral-50 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-600'
                  : up
                    ? 'border-green-200 bg-green-100 text-green-800 hover:border-green-400 dark:border-green-800 dark:bg-green-400/15 dark:text-green-200'
                    : 'border-red-100 bg-red-50 text-red-700 hover:border-red-300 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
              )}
            >
              <span className="text-[11px]">{String(day.day).padStart(2, '0')}</span>
              {quiet ? (
                <p className="mt-2 text-[11px]">{copy.noTrades}</p>
              ) : (
                <>
                  <p className="mt-1 font-semibold">{formatSignedMoney(day.profit ?? 0)}</p>
                  <p className="text-[11px] opacity-80">{interpolate(copy.tradeCount, { count: day.trades })}</p>
                </>
              )}
            </button>
          )
        })}
      </div>
      {selected ? (
        <DayTradesModal
          day={selected}
          trades={trader.closedPerformance}
          year={calendarYear}
          month={calendarMonth}
          locale={locale}
          copy={copy}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Card>
  )
}

interface DayFill {
  id: string
  symbol: string
  side: SocialTradeSide
  unit: number | null
  lots: number | null
  openRate: number | null
  closeRate: number | null
  openedAt: string
  closedAt: string
  profit: number
}

function dayFills(day: SocialCalendarDay, trades: SocialTrader['closedPerformance'], year: number, month: number): DayFill[] {
  return trades.filter(trade => {
    const closed = new Date(trade.closedAt)
    return closed.getUTCFullYear() === year && closed.getUTCMonth() === month && closed.getUTCDate() === day.day
  }).map(trade => ({
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    unit: null,
    lots: null,
    openRate: null,
    closeRate: null,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    profit: trade.profit,
  }))
}
function DayTradesModal({
  day,
  trades,
  year,
  month,
  locale,
  copy,
  onClose,
}: {
  day: SocialCalendarDay
  trades: SocialTrader['closedPerformance']
  year: number
  month: number
  locale: string
  copy: SocialTradingPageTranslations
  onClose: () => void
}) {
  const { formatSignedMoney } = useFormatMoney()
  const fills = dayFills(day, trades, year, month)
  const wins = fills.filter(fill => fill.profit > 0).length
  const losses = fills.filter(fill => fill.profit < 0).length
  const gross = fills.reduce((sum, fill) => sum + fill.profit, 0)
  const winRate = fills.length === 0 ? 0 : (wins / fills.length) * 100
  const heading = new Date(Date.UTC(year, month, day.day)).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const curve = fills.reduce<number[]>((points, fill) => {
    points.push((points[points.length - 1] ?? 0) + fill.profit)
    return points
  }, [0])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const stamp = (iso: string) => new Date(iso).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-neutral-900/40 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl dark:bg-neutral-950 sm:rounded-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {heading}
            <span className="ms-3 text-sm font-medium text-neutral-900 dark:text-neutral-50">{copy.netPnl}</span>
            <span className={clsx('ms-2 text-sm font-semibold', (day.profit ?? 0) >= 0 ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
              {formatSignedMoney(day.profit ?? 0)}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={copy.copySetup.close}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {fills.length === 0 ? (
          <p className="py-10 text-center text-sm text-neutral-900 dark:text-neutral-50">{copy.noTrades}</p>
        ) : (
          <>
            <div className="mt-5 grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-center">
              <DaySparkline values={curve} />
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Metric label={copy.totalTrades} value={String(fills.length)} />
                <Metric label={copy.winningTrades} value={String(wins)} />
                <Metric label={copy.grossPnl} value={formatSignedMoney(gross)} tone={gross >= 0 ? 'up' : 'down'} />
                <Metric label={copy.winRate} value={`${winRate.toFixed(2)}%`} />
                <Metric label={copy.losingTrades} value={String(losses)} />
                <Metric label={copy.totalLots} value={'Unavailable'} />
              </dl>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-neutral-900 dark:text-neutral-50">
                    <th className="px-2 py-2">{copy.asset} ({fills.length})</th>
                    <th className="px-2 py-2">{copy.unit}</th>
                    <th className="px-2 py-2">{copy.openRate}</th>
                    <th className="px-2 py-2">{copy.closeRate}</th>
                    <th className="px-2 py-2">{copy.openDateTime}</th>
                    <th className="px-2 py-2">{copy.closeDateTime}</th>
                    <th className="px-2 py-2 text-end">{copy.pnl}</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((fill, index) => (
                    <tr key={fill.id || `${fill.symbol}-${index}`} className="border-t border-neutral-100 dark:border-neutral-800">
                      <td className="px-2 py-3">
                        <span className="inline-flex items-center gap-2 font-medium text-neutral-900 dark:text-neutral-50">
                          {fill.symbol}
                          <SideLabel side={fill.side} buy={copy.buy} sell={copy.sell} />
                        </span>
                      </td>
                      <td className="px-2 py-3 text-neutral-900 dark:text-neutral-50">{fill.unit ?? 'Unavailable'}</td>
                      <td className="px-2 py-3 text-neutral-900 dark:text-neutral-50">{fill.openRate ?? 'Unavailable'}</td>
                      <td className="px-2 py-3 text-neutral-900 dark:text-neutral-50">{fill.closeRate ?? 'Unavailable'}</td>
                      <td className="px-2 py-3 text-neutral-900 dark:text-neutral-50">{stamp(fill.openedAt)}</td>
                      <td className="px-2 py-3 text-neutral-900 dark:text-neutral-50">{stamp(fill.closedAt)}</td>
                      <td className={clsx('px-2 py-3 text-end font-medium', fill.profit >= 0 ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
                        {formatSignedMoney(fill.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function DaySparkline({ values }: { values: number[] }) {
  const width = 140
  const height = 64
  const min = Math.min(...values, 0)
  const max = Math.max(...values, 0)
  const span = max - min || 1
  const coords = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width
    const y = height - 6 - ((value - min) / span) * (height - 12)
    return { x, y }
  })
  const line = coords.map(point => `${point.x},${point.y}`).join(' ')
  const area = `${line} ${width},${height} 0,${height}`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-16 w-36" aria-hidden="true">
      <polygon points={area} className="fill-teal-100 dark:fill-teal-900" />
      <polyline points={line} fill="none" className="stroke-green-400" strokeWidth="2" />
    </svg>
  )
}

function OverviewPanel({
  trader,
  stats,
  copy,
  formatMoney,
  formatSignedMoney,
}: {
  trader: SocialTrader
  stats: SocialTraderStats
  copy: SocialTradingPageTranslations
  formatMoney: (value: number) => string
  formatSignedMoney: (value: number) => string
}) {
  const lastTrade = trader.activities.reduce((latest, item) => item.at > latest ? item.at : latest, trader.activities[0]?.at ?? '')
  return (
    <Card className="xl:sticky xl:top-4">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.overview}</h2>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <p className={clsx('text-lg font-semibold', stats.dailyProfitPercent == null ? 'text-neutral-900 dark:text-neutral-50' : stats.dailyProfitPercent >= 0 ? 'text-green-500 dark:text-teal-300' : 'text-red-600')}>
            {stats.dailyProfitPercent == null ? 'Unavailable' : stats.dailyProfitPercent.toFixed(2) + '%'}
          </p>
          <p className="text-xs text-neutral-900 dark:text-neutral-50">{copy.dailyProfit}</p>
        </div>
        <div>
          <p className={clsx('text-lg font-semibold', stats.monthlyProfitPercent == null ? 'text-neutral-900 dark:text-neutral-50' : stats.monthlyProfitPercent >= 0 ? 'text-green-500 dark:text-teal-300' : 'text-red-600')}>
            {stats.monthlyProfitPercent == null ? 'Unavailable' : stats.monthlyProfitPercent.toFixed(2) + '%'}
          </p>
          <p className="text-xs text-neutral-900 dark:text-neutral-50">{copy.monthlyProfit}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-3 text-sm">
        <OverviewRow label={copy.growth} value={trader.roi == null ? 'Unavailable' : trader.roi.toFixed(2) + '%'} tone={trader.roi == null ? undefined : trader.roi >= 0 ? 'up' : 'down'} />
        <OverviewRow label={copy.drawdown} value={trader.maxDrawdown == null ? 'Unavailable' : trader.maxDrawdown.toFixed(2) + '%'} tone="down" />
        <div>
          <div className="flex items-center justify-between">
            <dt className="text-neutral-900 dark:text-neutral-50">{copy.winRate}</dt>
            <dd className="font-semibold text-green-500 dark:text-teal-300">{trader.winRate == null ? 'Unavailable' : trader.winRate.toFixed(2) + '%'}</dd>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            {trader.winRate != null ? <div className="h-full rounded-full bg-green-400" style={{ width: Math.min(trader.winRate, 100) + '%' }} /> : null}
          </div>
        </div>
        <OverviewRow label={copy.profitableTrades} value={stats.profitableTrades == null ? 'Unavailable' : String(stats.profitableTrades)} />
        <OverviewRow label={copy.losingTrades} value={stats.losingTrades == null ? 'Unavailable' : String(stats.losingTrades)} />
        <OverviewRow label={copy.balance} value={trader.previewBalance == null ? 'Unavailable' : formatMoney(trader.previewBalance)} />
        <OverviewRow label={copy.equity} value={stats.equity == null ? 'Unavailable' : formatMoney(stats.equity)} />
        <OverviewRow label={copy.deposit} value={stats.deposit == null ? 'Unavailable' : formatMoney(stats.deposit)} />
        <OverviewRow label={copy.totalTrades} value={!trader.historyComplete || trader.closedTrades == null || trader.openTradeCount == null ? 'Unavailable' : String(trader.closedTrades + trader.openTradeCount)} />
        <OverviewRow label={copy.openTrades} value={!trader.historyComplete || trader.openTradeCount == null ? 'Unavailable' : String(trader.openTradeCount)} />
        <OverviewRow label={copy.lastTrade} value={!trader.historyComplete ? 'Unavailable' : lastTrade ? formatWhen(lastTrade) : trader.historyAvailable ? '—' : 'Unavailable'} />
        <OverviewRow label={copy.openPosition} value={stats.openPosition == null ? 'Unavailable' : formatSignedMoney(stats.openPosition)} tone={stats.openPosition == null ? undefined : stats.openPosition >= 0 ? 'up' : 'down'} />
        <OverviewRow label={copy.liveCopiers} value={trader.liveCopiers == null ? 'Unavailable' : String(trader.liveCopiers)} />
<OverviewRow label={copy.bestTrade} value={stats.bestTradeProfit == null || !stats.bestTradeAt ? 'Unavailable' : formatSignedMoney(stats.bestTradeProfit) + ' / ' + formatWhen(stats.bestTradeAt)} tone="up" />
<OverviewRow label={copy.worstTrade} value={stats.worstTradeProfit == null || !stats.worstTradeAt ? 'Unavailable' : formatSignedMoney(stats.worstTradeProfit) + ' / ' + formatWhen(stats.worstTradeAt)} tone="down" />
        <OverviewRow label={copy.timezone} value={trader.profile.timezone ?? 'Unavailable'} />
        <OverviewRow label={copy.amountFollowing} value={stats.amountFollowing == null ? 'Unavailable' : formatMoney(stats.amountFollowing)} />
      </dl>
    </Card>
  )
}

function OverviewRow({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-neutral-100 pb-2 dark:border-neutral-800">
      <dt className="text-neutral-900 dark:text-neutral-50">{label}</dt>
      <dd className={clsx('text-end font-medium text-neutral-900 dark:text-neutral-50', tone === 'up' && 'text-green-500 dark:text-teal-300', tone === 'down' && 'text-red-600 dark:text-red-400')}>{value}</dd>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <dt className="text-xs text-neutral-900 dark:text-neutral-50">{label}</dt>
      <dd className={clsx('mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50', tone === 'up' && 'text-green-500 dark:text-teal-300', tone === 'down' && 'text-red-600 dark:text-red-400')}>{value}</dd>
    </div>
  )
}

function TradeTable({
  title,
  whenLabel,
  rows,
  copy,
  formatSignedMoney,
}: {
  title: string
  whenLabel: string
  rows: Array<{ id: string; symbol: string; side: SocialTradeSide; when: string; result: number | null }>
  copy: {
    symbol: string
    buy: string
    sell: string
    result: string
  }
  formatSignedMoney: (value: number) => string
}) {
  return (
    <Card padding="none" className="overflow-hidden">
      <h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
        {title}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-neutral-900 dark:text-neutral-50">
              <th className="px-4 py-2">{copy.symbol}</th>
              <th className="px-3 py-2">{copy.buy}/{copy.sell}</th>
              <th className="px-3 py-2">{whenLabel}</th>
              <th className="px-4 py-2 text-end">{copy.result}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-50">{row.symbol}</td>
                <td className="px-3 py-3">
                  <SideLabel side={row.side} buy={copy.buy} sell={copy.sell} />
                </td>
                <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">{row.when}</td>
                <td className={clsx('px-4 py-3 text-end font-medium', row.result == null ? 'text-neutral-900 dark:text-neutral-50' : row.result >= 0 ? 'text-green-500 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
                  {row.result == null ? '—' : formatSignedMoney(row.result)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
