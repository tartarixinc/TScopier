import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { PageHeader } from '../../components/layout/PageHeader'
import { CopyTraderModal } from '../../components/social/CopyTraderModal'
import { PageShell } from '../../components/layout/PageShell'
import { PerformanceTradeOutcomeChart } from '../../components/performance/PerformanceTradeOutcomeChart'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import {
  SOCIAL_INCOMING_REQUESTS,
  SOCIAL_TRADERS,
  socialTraderById,
  type SocialAccess,
  type SocialTradeSide,
  type SocialTrader,
} from '../../lib/socialTradingFixture'

const FOLLOW_KEY = 'tscopier:social-trading:following'
const ACCESS_KEY = 'tscopier:social-trading:access'
const OUTGOING_KEY = 'tscopier:social-trading:copy-requests'
const INCOMING_KEY = 'tscopier:social-trading:incoming-requests'

type OutgoingStatus = 'pending' | 'declined'
type IncomingStatus = 'pending' | 'accepted' | 'declined'
type CopyButtonState = 'follow' | 'following' | 'request' | 'requested'

type SortKey = 'roi' | 'winRate' | 'followers'
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="mt-1 font-semibold text-neutral-900 dark:text-neutral-50">{value}</dd>
    </div>
  )
}

export function SocialTraderActivityPage() {
  const t = useT()
  const copy = t.socialTradingPage
  const { formatSignedMoney } = useFormatMoney()
  const { openAddTradingAccount } = useAddTradingAccount()
  const { traderId } = useParams()
  const trader = traderId ? socialTraderById(traderId) : undefined
  const [following, setFollowing] = useState(initialFollowing)
  const [access, setAccess] = useState(initialAccess)
  const [outgoing, setOutgoing] = useState(initialOutgoing)
  const [incoming, setIncoming] = useState(initialIncoming)
  const [copyModalOpen, setCopyModalOpen] = useState(false)

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

  return (
    <>
    <PageShell maxWidth="xl">
      <div>
        <Link to="/social-trading" className="text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300">
          {copy.back}
        </Link>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <PageHeader
              title={(
                <span className="inline-flex flex-wrap items-center gap-2">
                  {trader.isYou ? copy.you : trader.displayName}
                  <AccessTag
                    access={trader.isYou ? access : trader.access}
                    openLabel={copy.open}
                    privateLabel={copy.private}
                  />
                </span>
              )}
            />
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">@{trader.username}</p>
          </div>
          {trader.isYou ? (
            <AccessChoice access={access} copy={copy} onChange={chooseAccess} labelled />
          ) : (
            <div className="flex items-center gap-2">
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
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={copy.roi} value={percent(trader.roi)} />
        <Stat label={copy.winRate} value={percent(trader.winRate)} />
        <Stat label={copy.maxDrawdown} value={percent(trader.maxDrawdown)} />
        <Stat label={copy.closedTrades} value={String(trader.closedTrades)} />
      </dl>
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
      <div className="grid gap-4 xl:grid-cols-2">
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
