import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { AccountGrowthChart } from '../../components/dashboard/AccountGrowthChart'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { PerformanceTradeOutcomeChart } from '../../components/performance/PerformanceTradeOutcomeChart'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Toggle } from '../../components/ui/Toggle'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import {
  SOCIAL_TRADERS,
  socialTraderById,
  type SocialTradeSide,
  type SocialTrader,
} from '../../lib/socialTradingFixture'

const FOLLOW_KEY = 'tscopier:social-trading:following'
const ALLOW_KEY = 'tscopier:social-trading:allow-following'

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

function initialAllowFollowing(): boolean {
  try {
    const raw = sessionStorage.getItem(ALLOW_KEY)
    if (raw === '0') return false
    if (raw === '1') return true
  } catch {
    // Fall through to the fixture.
  }
  return SOCIAL_TRADERS.find(trader => trader.isYou)?.allowFollowing ?? false
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
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('roi')
  const [following, setFollowing] = useState(initialFollowing)
  const [allowFollowing, setAllowFollowing] = useState(initialAllowFollowing)
  const view: DirectoryView = params.get('view') === 'followers'
    ? 'followers'
    : params.get('view') === 'following'
      ? 'following'
      : 'all'

  const traders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = SOCIAL_TRADERS.filter(trader => {
      if (view === 'followers' && !trader.followsYou) return false
      if (view === 'following' && !following.has(trader.id)) return false
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
  }, [following, query, sort, view])

  const toggleFollow = (id: string) => {
    setFollowing(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeFollowing(next)
      return next
    })
  }

  const heading = view === 'followers' ? copy.viewFollowers : view === 'following' ? copy.viewFollowing : copy.title

  return (
    <PageShell maxWidth="xl">
      <PageHeader title={heading} />
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{copy.sampleNote}</p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={copy.searchPlaceholder}
          className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-50 sm:max-w-xs"
        />
        <select
          value={sort}
          onChange={event => setSort(event.target.value as SortKey)}
          className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
        >
          <option value="roi">{copy.sortRoi}</option>
          <option value="winRate">{copy.sortWinRate}</option>
          <option value="followers">{copy.sortFollowers}</option>
        </select>
        {view !== 'all' ? (
          <Link to="/social-trading" className="text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300">
            {copy.viewAll}
          </Link>
        ) : null}
      </div>
      {traders.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{copy.empty}</p>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {traders.map(trader => (
            <Card
              key={trader.id}
              padding="sm"
              role="link"
              tabIndex={0}
              aria-label={trader.isYou ? copy.you : trader.displayName}
              className="flex cursor-pointer flex-col gap-4 transition-colors hover:border-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:hover:border-teal-700"
              onClick={() => navigate(`/social-trading/${trader.id}`)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  navigate(`/social-trading/${trader.id}`)
                }
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {trader.isYou ? copy.you : trader.displayName}
                  </p>
                  <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">@{trader.username}</p>
                </div>
                {trader.isYou ? (
                  <label
                    className="relative z-10 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                  >
                    <span>{copy.allowFollowing}</span>
                    <Toggle
                      checked={allowFollowing}
                      onChange={checked => {
                        setAllowFollowing(checked)
                        try {
                          sessionStorage.setItem(ALLOW_KEY, checked ? '1' : '0')
                        } catch {
                          // The switch still updates this view.
                        }
                      }}
                    />
                  </label>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant={following.has(trader.id) ? 'secondary' : 'primary'}
                    onClick={event => {
                      event.stopPropagation()
                      toggleFollow(trader.id)
                    }}
                    onKeyDown={event => event.stopPropagation()}
                  >
                    {following.has(trader.id) ? copy.following : copy.follow}
                  </Button>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat label={copy.roi} value={percent(trader.roi)} />
                <Stat label={copy.winRate} value={percent(trader.winRate)} />
                <Stat label={copy.maxDrawdown} value={percent(trader.maxDrawdown)} />
                <Stat label={copy.followers} value={String(trader.followerCount)} />
              </dl>
            </Card>
          ))}
        </div>
      )}
    </PageShell>
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
  const { traderId } = useParams()
  const trader = traderId ? socialTraderById(traderId) : undefined
  const [following, setFollowing] = useState(initialFollowing)

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

  const toggleFollow = () => {
    setFollowing(prev => {
      const next = new Set(prev)
      if (next.has(trader.id)) next.delete(trader.id)
      else next.add(trader.id)
      writeFollowing(next)
      return next
    })
  }

  return (
    <PageShell maxWidth="xl">
      <div>
        <Link to="/social-trading" className="text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-300">
          {copy.back}
        </Link>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <PageHeader title={trader.isYou ? copy.you : trader.displayName} />
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">@{trader.username}</p>
          </div>
          {trader.isYou ? null : (
            <Button
              type="button"
              size="sm"
              variant={following.has(trader.id) ? 'secondary' : 'primary'}
              onClick={toggleFollow}
            >
              {following.has(trader.id) ? copy.following : copy.follow}
            </Button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={copy.roi} value={percent(trader.roi)} />
        <Stat label={copy.winRate} value={percent(trader.winRate)} />
        <Stat label={copy.maxDrawdown} value={percent(trader.maxDrawdown)} />
        <Stat label={copy.closedTrades} value={String(trader.closedTrades)} />
      </dl>
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
