import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { BarChart3, ChevronRight, LineChart, Star, Wallet, X } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import clsx from 'clsx'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { PageHeader } from '../../components/layout/PageHeader'
import { CopyTraderModal } from '../../components/social/CopyTraderModal'
import { PageShell } from '../../components/layout/PageShell'
import { PerformanceTradeOutcomeChart } from '../../components/performance/PerformanceTradeOutcomeChart'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useLocale, useT } from '../../context/LocaleContext'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import { useTheme } from '../../context/ThemeContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { interpolate } from '../../i18n/interpolate'
import { chartThemeColors, chartTooltipProps } from '../../lib/chartTheme'
import {
  SOCIAL_INCOMING_REQUESTS,
  SOCIAL_TRADERS,
  socialTraderById,
  socialTraderStats,
  type SocialAccess,
  type SocialCalendarDay,
  type SocialTradeSide,
  type SocialTrader,
  type SocialTraderStats,
} from '../../lib/socialTradingFixture'

const FOLLOW_KEY = 'tscopier:social-trading:following'
const ACCESS_KEY = 'tscopier:social-trading:access'
const OUTGOING_KEY = 'tscopier:social-trading:copy-requests'
const INCOMING_KEY = 'tscopier:social-trading:incoming-requests'

type OutgoingStatus = 'pending' | 'declined'
type IncomingStatus = 'pending' | 'accepted' | 'declined'
type CopyButtonState = 'follow' | 'following' | 'request' | 'requested'

type SortKey = 'roi' | 'winRate' | 'followers' | 'rating'
type DirectoryView = 'all' | 'followers' | 'following'

function initialFollowing(): Set<string> {
  try {
    const raw = sessionStorage.getItem(FOLLOW_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((id): id is string => typeof id === 'string'))
      }
    }
  } catch {
    // Fall through to the fixture.
  }
  return new Set(SOCIAL_TRADERS.filter(trader => trader.following).map(trader => trader.id))
}

function writeFollowing(ids: Set<string>) {
  try {
    sessionStorage.setItem(FOLLOW_KEY, JSON.stringify([...ids]))
  } catch {
    // Session storage can be full or blocked. The toggle still updates this view.
  }
}

function initialAccess(): SocialAccess {
  try {
    const raw = sessionStorage.getItem(ACCESS_KEY)
    if (raw === 'open' || raw === 'private') return raw
  } catch {
    // Fall through to the fixture.
  }
  return SOCIAL_TRADERS.find(trader => trader.isYou)?.access ?? 'open'
}

function writeAccess(access: SocialAccess) {
  try {
    sessionStorage.setItem(ACCESS_KEY, access)
  } catch {
    // The choice still updates this view.
  }
}

function readStatusMap<T extends string>(key: string, allowed: readonly T[]): Record<string, T> {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: Record<string, T> = {}
    for (const [id, status] of Object.entries(parsed)) {
      if (allowed.includes(status as T)) next[id] = status as T
    }
    return next
  } catch {
    return {}
  }
}

function writeStatusMap(key: string, value: Record<string, string>) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // The choice still updates this view.
  }
}

function initialOutgoing(): Record<string, OutgoingStatus> {
  return readStatusMap(OUTGOING_KEY, ['pending', 'declined'] as const)
}

function initialIncoming(): Record<string, IncomingStatus> {
  const seed: Record<string, IncomingStatus> = {}
  for (const request of SOCIAL_INCOMING_REQUESTS) seed[request.traderId] = 'pending'
  return { ...seed, ...readStatusMap(INCOMING_KEY, ['pending', 'accepted', 'declined'] as const) }
}

function copyButtonState(
  trader: SocialTrader,
  following: Set<string>,
  outgoing: Record<string, OutgoingStatus>,
): CopyButtonState {
  if (following.has(trader.id)) return 'following'
  if (trader.access === 'open') return 'follow'
  if (outgoing[trader.id] === 'pending') return 'requested'
  return 'request'
}

function applyCopyAction(
  id: string,
  following: Set<string>,
  outgoing: Record<string, OutgoingStatus>,
): { following: Set<string>; outgoing: Record<string, OutgoingStatus> } {
  const trader = socialTraderById(id)
  if (!trader || trader.isYou) return { following, outgoing }
  const state = copyButtonState(trader, following, outgoing)
  if (state === 'following') {
    const next = new Set(following)
    next.delete(id)
    return { following: next, outgoing }
  }
  if (state === 'follow') {
    const next = new Set(following)
    next.add(id)
    const requests = { ...outgoing }
    delete requests[id]
    return { following: next, outgoing: requests }
  }
  if (state === 'requested') {
    const requests = { ...outgoing }
    delete requests[id]
    return { following, outgoing: requests }
  }
  return { following, outgoing: { ...outgoing, [id]: 'pending' } }
}

function canConfigureCopy(trader: SocialTrader, following: Set<string>): boolean {
  return trader.access === 'open' || following.has(trader.id)
}

function followsYou(trader: SocialTrader, incoming: Record<string, IncomingStatus>): boolean {
  return trader.followsYou || incoming[trader.id] === 'accepted'
}

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return iso
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

function TraderRating({
  rating,
  count,
  copy,
}: {
  rating: number | null
  count: number
  copy: { noRating: string; ratingAria: string }
}) {
  if (rating == null || count <= 0) {
    return <p className="text-xs text-neutral-400 dark:text-neutral-500">{copy.noRating}</p>
  }
  const rounded = Math.round(rating * 2) / 2
  const score = rating.toFixed(1)
  return (
    <p className="flex items-center gap-1.5" aria-label={copy.ratingAria.replace('{rating}', score)}>
      <span className="inline-flex" aria-hidden="true">
        {[1, 2, 3, 4, 5].map(star => {
          const fill = rounded >= star ? 'full' : rounded >= star - 0.5 ? 'half' : 'empty'
          if (fill === 'half') {
            return (
              <span key={star} className="relative inline-flex h-3.5 w-3.5">
                <Star className="h-3.5 w-3.5 text-neutral-300 dark:text-neutral-600" />
                <Star className="absolute inset-0 h-3.5 w-3.5 fill-teal-600 text-teal-600" style={{ clipPath: 'inset(0 50% 0 0)' }} />
              </span>
            )
          }
          return (
            <Star
              key={star}
              className={clsx(
                'h-3.5 w-3.5',
                fill === 'full' ? 'fill-teal-600 text-teal-600' : 'text-neutral-300 dark:text-neutral-600',
              )}
            />
          )
        })}
      </span>
      <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">{score}</span>
      <span className="text-xs text-neutral-400 dark:text-neutral-500">({count})</span>
    </p>
  )
}

function SideLabel({ side, buy, sell }: { side: SocialTradeSide; buy: string; sell: string }) {
  const isBuy = side === 'buy'
  return (
    <span className={clsx('text-xs font-medium', isBuy ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
      {isBuy ? buy : sell}
    </span>
  )
}

export function SocialTradingPage() {
  const t = useT()
  const copy = t.socialTradingPage
  const navigate = useNavigate()
  const { formatMoney } = useFormatMoney()
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('roi')
  const [visibility, setVisibility] = useState<'all' | SocialAccess>('all')
  const [requestsOnly, setRequestsOnly] = useState(false)
  const [following, setFollowing] = useState(initialFollowing)
  const [access, setAccess] = useState(initialAccess)
  const [outgoing, setOutgoing] = useState(initialOutgoing)
  const [incoming] = useState(initialIncoming)
  const view: DirectoryView = params.get('view') === 'followers'
    ? 'followers'
    : params.get('view') === 'following'
      ? 'following'
      : 'all'

  const traders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = SOCIAL_TRADERS.filter(trader => {
      if (view === 'followers' && !followsYou(trader, incoming)) return false
      if (view === 'following' && !following.has(trader.id)) return false
      const traderAccess = trader.isYou ? access : trader.access
      if (visibility !== 'all' && traderAccess !== visibility) return false
      if (requestsOnly && outgoing[trader.id] !== 'pending') return false
      if (!needle) return true
      return trader.displayName.toLowerCase().includes(needle) || trader.username.toLowerCase().includes(needle)
    })
    const rank = (trader: SocialTrader) => {
      if (sort === 'winRate') return trader.winRate
      if (sort === 'followers') return trader.followerCount
      if (sort === 'rating') return trader.rating ?? -1
      return trader.roi
    }
    return filtered.slice().sort((a, b) => {
      if (a.isYou !== b.isYou) return a.isYou ? -1 : 1
      return rank(b) - rank(a)
    })
  }, [access, following, incoming, outgoing, query, requestsOnly, sort, view, visibility])

  const runCopyAction = (id: string) => {
    const next = applyCopyAction(id, following, outgoing)
    setFollowing(next.following)
    setOutgoing(next.outgoing)
    writeFollowing(next.following)
    writeStatusMap(OUTGOING_KEY, next.outgoing)
  }

  const chooseAccess = (value: SocialAccess) => {
    setAccess(value)
    writeAccess(value)
  }

  const heading = view === 'followers' ? copy.tabFollowers : view === 'following' ? copy.tabFollowing : copy.tabProviders
  const openCount = SOCIAL_TRADERS.filter(trader => (trader.isYou ? access : trader.access) === 'open').length
  const privateCount = SOCIAL_TRADERS.length - openCount
  const followerCount = SOCIAL_TRADERS.filter(trader => followsYou(trader, incoming)).length
  const requestCount = Object.values(outgoing).filter(status => status === 'pending').length
  const toggleVisibility = (next: SocialAccess) => {
    setVisibility(current => current === next ? 'all' : next)
  }

  return (
    <PageShell maxWidth="xl">
      <nav className="flex gap-6 overflow-x-auto border-b border-neutral-200 dark:border-neutral-800" aria-label={copy.title}>
        <DirectoryTab to="/social-trading" active={view === 'all'}>{copy.tabProviders}</DirectoryTab>
        <DirectoryTab to="/social-trading?view=followers" active={view === 'followers'}>{copy.tabFollowers}</DirectoryTab>
        <DirectoryTab to="/social-trading?view=following" active={view === 'following'}>{copy.tabFollowing}</DirectoryTab>
      </nav>
      <PageHeader title={heading} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <SummaryStat label={copy.open} value={openCount} selected={visibility === 'open'} onClick={() => toggleVisibility('open')} />
        <SummaryStat label={copy.private} value={privateCount} selected={visibility === 'private'} onClick={() => toggleVisibility('private')} />
        <SummaryStat label={copy.following} value={following.size} selected={view === 'following'} onClick={() => navigate('/social-trading?view=following')} />
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
          className="rounded-full border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
        >
          <option value="all">{copy.visibility}: {copy.visibilityAll}</option>
          <option value="open">{copy.visibility}: {copy.open}</option>
          <option value="private">{copy.visibility}: {copy.private}</option>
        </select>
        <select
          value={sort}
          onChange={event => setSort(event.target.value as SortKey)}
          className="rounded-full border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
        >
          <option value="roi">{copy.sortRoi}</option>
          <option value="winRate">{copy.sortWinRate}</option>
          <option value="followers">{copy.sortFollowers}</option>
          <option value="rating">{copy.sortRating}</option>
        </select>
      </div>
      <Card padding="none" className="overflow-hidden">
        {traders.length === 0 ? (
          <p className="px-4 py-8 text-sm text-neutral-500 dark:text-neutral-400">{copy.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="px-4 py-3">{copy.colName}</th>
                  <th className="px-3 py-3">{copy.colStatus}</th>
                  <th className="px-3 py-3">{copy.roi}</th>
                  <th className="px-3 py-3">{copy.winRate}</th>
                  <th className="px-3 py-3">{copy.followers}</th>
                  <th className="px-3 py-3">{copy.colBalance}</th>
                  <th className="px-4 py-3 text-end"><span className="sr-only">{copy.colActions}</span></th>
                </tr>
              </thead>
              <tbody>
                {traders.map(trader => {
                  const traderAccess = trader.isYou ? access : trader.access
                  const rank = SOCIAL_TRADERS.findIndex(item => item.id === trader.id) + 1
                  const name = trader.isYou ? copy.you : trader.displayName
                  return (
                    <tr
                      key={trader.id}
                      role="link"
                      tabIndex={0}
                      aria-label={name}
                      className="cursor-pointer border-t border-neutral-100 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 dark:border-neutral-800 dark:hover:bg-neutral-900"
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
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                            {name.slice(0, 1).toUpperCase()}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-neutral-900 dark:text-neutral-50">{name}</p>
                            <TraderRating rating={trader.rating} count={trader.ratingCount} copy={copy} />
                            <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">
                              #{rank} · {traderAccess === 'open' ? copy.open : copy.private}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          {copy.statusActive}
                        </span>
                      </td>
                      <td className="px-3 py-3 font-medium text-neutral-800 dark:text-neutral-100">{percent(trader.roi)}</td>
                      <td className="px-3 py-3 text-neutral-700 dark:text-neutral-200">{percent(trader.winRate)}</td>
                      <td className="px-3 py-3 text-neutral-700 dark:text-neutral-200">{trader.followerCount}</td>
                      <td className="px-3 py-3 text-neutral-700 dark:text-neutral-200">{formatMoney(trader.previewBalance)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {trader.isYou ? (
                            <AccessChoice access={access} copy={copy} onChange={chooseAccess} />
                          ) : (
                            <CopyActionButton
                              trader={trader}
                              following={following}
                              outgoing={outgoing}
                              copy={copy}
                              onToggle={runCopyAction}
                            />
                          )}
                          <ChevronRight className="h-4 w-4 text-neutral-400" aria-hidden="true" />
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
          : 'border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
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
      <span className="block text-sm text-neutral-500 dark:text-neutral-400">{label}</span>
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
          ? 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
          : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300',
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
      className="relative z-10 flex shrink-0 flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
    >
      {labelled ? <span>{copy.whoCanCopy}</span> : <span className="sr-only">{copy.whoCanCopy}</span>}
      <select
        value={access}
        aria-label={copy.whoCanCopy}
        onChange={event => onChange(event.target.value === 'private' ? 'private' : 'open')}
        className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
      >
        <option value="open">{copy.anyoneCanCopy}</option>
        <option value="private">{copy.requestsRequired}</option>
      </select>
    </label>
  )
}

function CopyActionButton({
  trader,
  following,
  outgoing,
  copy,
  onToggle,
}: {
  trader: SocialTrader
  following: Set<string>
  outgoing: Record<string, OutgoingStatus>
  copy: { follow: string; following: string; requestToCopy: string; requested: string }
  onToggle: (id: string) => void
}) {
  const state = copyButtonState(trader, following, outgoing)
  const label = state === 'following'
    ? copy.following
    : state === 'requested'
      ? copy.requested
      : state === 'request'
        ? copy.requestToCopy
        : copy.follow
  const quiet = state === 'following' || state === 'requested'
  return (
    <Button
      type="button"
      size="sm"
      variant={quiet ? 'secondary' : 'primary'}
      onClick={event => {
        event.stopPropagation()
        onToggle(trader.id)
      }}
      onKeyDown={event => event.stopPropagation()}
    >
      {label}
    </Button>
  )
}

export function SocialTraderActivityPage() {
  const t = useT()
  const copy = t.socialTradingPage
  const { formatMoney, formatSignedMoney } = useFormatMoney()
  const { locale } = useLocale()
  const { openAddTradingAccount } = useAddTradingAccount()
  const { traderId } = useParams()
  const trader = traderId ? socialTraderById(traderId) : undefined
  const [following, setFollowing] = useState(initialFollowing)
  const [access, setAccess] = useState(initialAccess)
  const [outgoing, setOutgoing] = useState(initialOutgoing)
  const [incoming, setIncoming] = useState(initialIncoming)
  const [copyModalOpen, setCopyModalOpen] = useState(false)
  const [profileTab, setProfileTab] = useState<'performance' | 'trading' | 'portfolio'>('performance')

  if (!trader) {
    return (
      <PageShell maxWidth="xl">
        <PageHeader title={copy.title} />
        <Card>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{copy.notFound}</p>
          <Link to="/social-trading" className="mt-3 inline-block text-sm font-medium text-teal-700 dark:text-teal-300">
            {copy.back}
          </Link>
        </Card>
      </PageShell>
    )
  }

  const runCopyAction = () => {
    const next = applyCopyAction(trader.id, following, outgoing)
    setFollowing(next.following)
    setOutgoing(next.outgoing)
    writeFollowing(next.following)
    writeStatusMap(OUTGOING_KEY, next.outgoing)
    if (!canConfigureCopy(trader, next.following)) setCopyModalOpen(false)
  }

  const chooseAccess = (value: SocialAccess) => {
    setAccess(value)
    writeAccess(value)
  }

  const resolveIncoming = (id: string, status: 'accepted' | 'declined') => {
    setIncoming(prev => {
      const next = { ...prev, [id]: status }
      writeStatusMap(INCOMING_KEY, next)
      return next
    })
  }

  const pendingRequests = SOCIAL_TRADERS.filter(person => incoming[person.id] === 'pending')
  const allowedToCopy = canConfigureCopy(trader, following)
  const stats = socialTraderStats(trader)
  const name = trader.isYou ? copy.you : trader.displayName
  const joined = new Date(trader.profile.joinedAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })

  return (
    <>
    <PageShell maxWidth="xl">
      <div>
        <Link to="/social-trading" className="text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300">
          {copy.back}
        </Link>
        <Card className="mt-3">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-lg font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
                {name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-xl font-semibold text-neutral-900 dark:text-neutral-50">{name}</h1>
                  <AccessTag
                    access={trader.isYou ? access : trader.access}
                    openLabel={copy.open}
                    privateLabel={copy.private}
                  />
                </div>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  #{trader.profile.rank} {copy.rank} · {copy.joined} {joined} · {trader.profile.country}
                </p>
                <div className="mt-1">
                  <TraderRating rating={trader.rating} count={trader.ratingCount} copy={copy} />
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-4 sm:gap-8">
              <HeaderStat label={copy.aum} value={formatMoney(trader.previewBalance)} />
              <HeaderStat label={copy.followers} value={String(trader.followerCount)} />
              <HeaderStat label={copy.leverage} value={trader.profile.leverage} />
            </dl>
            {trader.isYou ? (
              <AccessChoice access={access} copy={copy} onChange={chooseAccess} labelled />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <CopyActionButton
                  trader={trader}
                  following={following}
                  outgoing={outgoing}
                  copy={copy}
                  onToggle={runCopyAction}
                />
                {allowedToCopy ? (
                  <Button type="button" size="sm" onClick={() => setCopyModalOpen(true)}>
                    {copy.copySetup.action}
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </Card>
      </div>
      {trader.isYou && access === 'private' ? (
        <Card padding="none" className="overflow-hidden">
          <h2 className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
            {copy.copyRequests}
          </h2>
          {pendingRequests.length === 0 ? (
            <p className="px-4 py-3 text-sm text-neutral-500 dark:text-neutral-400">{copy.copyRequestsEmpty}</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {pendingRequests.map(person => (
                <li key={person.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">{person.displayName}</p>
                    <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">@{person.username}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button type="button" size="sm" onClick={() => resolveIncoming(person.id, 'accepted')}>
                      {copy.accept}
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => resolveIncoming(person.id, 'declined')}>
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
                      <span className="text-neutral-800 dark:text-neutral-100">{activity.symbol}</span>
                      <SideLabel side={activity.side} buy={copy.buy} sell={copy.sell} />
                      <span className="text-neutral-500 dark:text-neutral-400">{formatWhen(activity.at)}</span>
                      {activity.profit != null ? (
                        <span className={clsx('ms-auto font-medium', activity.profit >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
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
      <dt className="text-xs text-neutral-500 dark:text-neutral-400">{label}</dt>
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
          ? 'bg-teal-600 text-white'
          : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function MonthlyProfitChart({ title, data }: { title: string; data: Array<{ label: string; profit: number }> }) {
  const { formatAxisMoney } = useFormatMoney()
  const { theme } = useTheme()
  const colors = chartThemeColors(theme)
  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
      <div className="mt-4 h-64">
        <ResponsiveContainer width="100%" height={256}>
          <BarChart data={data} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: colors.tick }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: colors.tick }} axisLine={false} tickLine={false} tickFormatter={value => formatAxisMoney(Number(value))} width={48} />
            <Tooltip {...chartTooltipProps(colors)} formatter={value => formatAxisMoney(Number(value ?? 0))} />
            <Bar dataKey="profit" fill="#0d9488" radius={[4, 4, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>
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
  const growth = `${trader.roi.toFixed(2)}%`
  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.statisticsMonth}</h2>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
        <Metric label={copy.growth} value={growth} tone={trader.roi >= 0 ? 'up' : 'down'} />
        <Metric label={copy.longTrades} value={String(stats.longTrades)} />
        <Metric label={copy.maxOpenTrades} value={String(stats.maxOpenTrades)} />
        <Metric label={copy.sharpeRatio} value={stats.sharpe.toFixed(2)} />
        <Metric label={copy.avgProfit} value={formatMoney(stats.avgProfit)} />
        <Metric label={copy.shortTrades} value={String(stats.shortTrades)} />
        <Metric label={copy.avgHoldingTime} value={interpolate(copy.holdingDays, { count: stats.avgHoldingDays })} />
        <Metric label={copy.profitFactor} value={stats.profitFactor.toFixed(2)} />
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
  const weekdays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 6 + index))
    return date.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' })
  })
  const leading = new Date(Date.UTC(2026, 8, 1)).getUTCDay()
  const symbols = [...trader.openTrades, ...trader.closedPerformance].map(trade => trade.symbol)
  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.pnlCalendar}</h2>
      <div className="mt-4 grid grid-cols-7 gap-2">
        {weekdays.map(label => (
          <div key={label} className="pb-1 text-center text-[11px] font-medium text-neutral-500 dark:text-neutral-400">{label}</div>
        ))}
        {Array.from({ length: leading }, (_, index) => (
          <div key={`lead-${index}`} className="min-h-[72px] rounded-lg border border-neutral-100 px-2 py-2 text-xs text-neutral-400 dark:border-neutral-800">
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
                  ? 'border-neutral-100 text-neutral-400 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-600'
                  : up
                    ? 'border-teal-100 bg-teal-50 text-teal-800 hover:border-teal-300 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-200'
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
          symbols={symbols}
          locale={locale}
          copy={copy}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </Card>
  )
}

const DAY_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'GBPJPY', 'NAS100']

interface DayFill {
  symbol: string
  side: SocialTradeSide
  unit: number
  lots: number
  openRate: number
  closeRate: number
  openedAt: string
  closedAt: string
  profit: number
}

function dayFills(day: SocialCalendarDay, symbols: string[]): DayFill[] {
  if (day.profit == null || day.trades <= 0) return []
  let seed = day.day * 997 + Math.round(day.profit * 100)
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const weights = Array.from({ length: day.trades }, () => 0.35 + random())
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const profits = weights.map(weight => Math.round(((day.profit ?? 0) * weight / weightSum) * 100) / 100)
  const drift = Math.round(((day.profit ?? 0) - profits.reduce((sum, profit) => sum + profit, 0)) * 100) / 100
  const last = profits.length - 1
  profits[last] = Math.round(((profits[last] ?? 0) + drift) * 100) / 100
  const pool = symbols.length > 0 ? symbols : DAY_SYMBOLS
  return profits.map((profit, index) => {
    const symbol = pool[index % pool.length] ?? 'EURUSD'
    const side: SocialTradeSide = random() > 0.35 ? 'buy' : 'sell'
    const base = symbol.includes('XAU') ? 2650 : symbol.includes('JPY') ? 151 : symbol.includes('NAS') || symbol.includes('US30') ? 20100 : 1.1
    const digits = base > 100 ? 2 : 5
    const openRate = Number((base + random() * (base > 100 ? 8 : 0.02)).toFixed(digits))
    const closeRate = Number((openRate + (side === 'buy' ? 1 : -1) * (profit >= 0 ? 1 : -1) * (base > 100 ? 0.4 : 0.0002)).toFixed(digits))
    const openHour = 8 + Math.floor(random() * 8)
    const closeHour = Math.min(openHour + 1 + Math.floor(random() * 6), 22)
    const lots = Number((0.01 + Math.floor(random() * 8) * 0.01).toFixed(2))
    return {
      symbol,
      side,
      unit: Math.round(lots * 100000),
      lots,
      openRate,
      closeRate,
      openedAt: new Date(Date.UTC(2026, 8, Math.max(day.day - 1, 1), openHour, Math.floor(random() * 60), Math.floor(random() * 60))).toISOString(),
      closedAt: new Date(Date.UTC(2026, 8, day.day, closeHour, Math.floor(random() * 60), Math.floor(random() * 60))).toISOString(),
      profit,
    }
  })
}

function DayTradesModal({
  day,
  symbols,
  locale,
  copy,
  onClose,
}: {
  day: SocialCalendarDay
  symbols: string[]
  locale: string
  copy: SocialTradingPageTranslations
  onClose: () => void
}) {
  const { formatSignedMoney } = useFormatMoney()
  const fills = dayFills(day, symbols)
  const wins = fills.filter(fill => fill.profit > 0).length
  const losses = fills.filter(fill => fill.profit < 0).length
  const gross = fills.reduce((sum, fill) => sum + fill.profit, 0)
  const lots = fills.reduce((sum, fill) => sum + fill.lots, 0)
  const winRate = fills.length === 0 ? 0 : (wins / fills.length) * 100
  const heading = new Date(Date.UTC(2026, 8, day.day)).toLocaleDateString(locale, {
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
            <span className="ms-3 text-sm font-medium text-neutral-500 dark:text-neutral-400">{copy.netPnl}</span>
            <span className={clsx('ms-2 text-sm font-semibold', (day.profit ?? 0) >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
              {formatSignedMoney(day.profit ?? 0)}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800"
            aria-label={copy.copySetup.close}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {fills.length === 0 ? (
          <p className="py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">{copy.noTrades}</p>
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
                <Metric label={copy.totalLots} value={lots.toFixed(2)} />
              </dl>
            </div>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-neutral-500 dark:text-neutral-400">
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
                    <tr key={`${fill.symbol}-${index}`} className="border-t border-neutral-100 dark:border-neutral-800">
                      <td className="px-2 py-3">
                        <span className="inline-flex items-center gap-2 font-medium text-neutral-900 dark:text-neutral-50">
                          {fill.symbol}
                          <SideLabel side={fill.side} buy={copy.buy} sell={copy.sell} />
                        </span>
                      </td>
                      <td className="px-2 py-3 text-neutral-700 dark:text-neutral-200">{fill.unit}</td>
                      <td className="px-2 py-3 text-neutral-700 dark:text-neutral-200">{fill.openRate}</td>
                      <td className="px-2 py-3 text-neutral-700 dark:text-neutral-200">{fill.closeRate}</td>
                      <td className="px-2 py-3 text-neutral-600 dark:text-neutral-300">{stamp(fill.openedAt)}</td>
                      <td className="px-2 py-3 text-neutral-600 dark:text-neutral-300">{stamp(fill.closedAt)}</td>
                      <td className={clsx('px-2 py-3 text-end font-medium', fill.profit >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
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
      <polyline points={line} fill="none" className="stroke-teal-600" strokeWidth="2" />
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
          <p className={clsx('text-lg font-semibold', stats.dailyProfitPercent >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-red-600')}>
            {stats.dailyProfitPercent.toFixed(2)}%
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.dailyProfit}</p>
        </div>
        <div>
          <p className={clsx('text-lg font-semibold', stats.monthlyProfitPercent >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-red-600')}>
            {stats.monthlyProfitPercent.toFixed(2)}%
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{copy.monthlyProfit}</p>
        </div>
      </div>
      <dl className="mt-4 space-y-3 text-sm">
        <OverviewRow label={copy.growth} value={`${trader.roi.toFixed(2)}%`} tone={trader.roi >= 0 ? 'up' : 'down'} />
        <OverviewRow label={copy.drawdown} value={`${trader.maxDrawdown.toFixed(2)}%`} tone="down" />
        <div>
          <div className="flex items-center justify-between">
            <dt className="text-neutral-500 dark:text-neutral-400">{copy.winRate}</dt>
            <dd className="font-semibold text-teal-700 dark:text-teal-300">{trader.winRate.toFixed(2)}%</dd>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
            <div className="h-full rounded-full bg-teal-600" style={{ width: `${Math.min(trader.winRate, 100)}%` }} />
          </div>
        </div>
        <OverviewRow label={copy.profitableTrades} value={String(stats.profitableTrades)} />
        <OverviewRow label={copy.losingTrades} value={String(stats.losingTrades)} />
        <OverviewRow label={copy.balance} value={formatMoney(trader.previewBalance)} />
        <OverviewRow label={copy.equity} value={formatMoney(stats.equity)} />
        <OverviewRow label={copy.deposit} value={formatMoney(stats.deposit)} />
        <OverviewRow label={copy.totalTrades} value={String(trader.closedTrades + trader.openTrades.length)} />
        <OverviewRow label={copy.lastTrade} value={lastTrade ? formatWhen(lastTrade) : '—'} />
        <OverviewRow label={copy.openPosition} value={formatSignedMoney(stats.openPosition)} tone={stats.openPosition >= 0 ? 'up' : 'down'} />
        <OverviewRow label={copy.liveCopiers} value={String(trader.followerCount)} />
        <OverviewRow label={copy.bestTrade} value={`${formatSignedMoney(stats.bestTradeProfit)} · ${formatWhen(stats.bestTradeAt)}`} tone="up" />
        <OverviewRow label={copy.worstTrade} value={`${formatSignedMoney(stats.worstTradeProfit)} · ${formatWhen(stats.worstTradeAt)}`} tone="down" />
        <OverviewRow label={copy.timezone} value={trader.profile.timezone} />
        <OverviewRow label={copy.amountFollowing} value={formatMoney(stats.amountFollowing)} />
      </dl>
    </Card>
  )
}

function OverviewRow({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-neutral-100 pb-2 dark:border-neutral-800">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className={clsx('text-end font-medium text-neutral-900 dark:text-neutral-50', tone === 'up' && 'text-teal-700 dark:text-teal-300', tone === 'down' && 'text-red-600 dark:text-red-400')}>{value}</dd>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className={clsx('mt-1 text-sm font-semibold text-neutral-900 dark:text-neutral-50', tone === 'up' && 'text-teal-700 dark:text-teal-300', tone === 'down' && 'text-red-600 dark:text-red-400')}>{value}</dd>
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
            <tr className="text-left text-xs font-medium text-neutral-500 dark:text-neutral-400">
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
                <td className="px-3 py-3 text-neutral-600 dark:text-neutral-300">{row.when}</td>
                <td className={clsx('px-4 py-3 text-end font-medium', row.result == null ? 'text-neutral-400' : row.result >= 0 ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400')}>
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
