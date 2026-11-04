import { Search, Star } from 'lucide-react'
import clsx from 'clsx'
import { useT } from '../../../context/LocaleContext'
import {
  AppPreviewWindow,
  PREVIEW_CARD,
  PreviewBadge,
  PreviewPageHeader,
} from './AppPreviewWindow'

type Trader = {
  name: string
  rating: number
  roi: string
  winRate: string
  trades: number
  balance: string
  price: string | null
  following: boolean
}

const TRADERS: readonly Trader[] = [
  { name: 'Amira Hassan', rating: 4.8, roi: '+34.2%', winRate: '68.0%', trades: 128, balance: '$26,720', price: '$50', following: true },
  { name: 'Nora Okonkwo', rating: 4.6, roi: '+27.8%', winRate: '63.0%', trades: 89, balance: '$15,720', price: null, following: false },
  { name: 'Leo Berg', rating: 4.3, roi: '+12.6%', winRate: '54.0%', trades: 47, balance: '$8,150', price: '$25', following: true },
  { name: 'Kenji Sato', rating: 4.0, roi: '+9.1%', winRate: '57.0%', trades: 21, balance: '$12,140', price: '$100', following: false },
  { name: 'Sofia Reyes', rating: 4.5, roi: '+18.4%', winRate: '61.0%', trades: 64, balance: '$19,300', price: null, following: false },
]

function initials(name: string) {
  return name
    .split(' ')
    .map(part => part[0])
    .join('')
    .slice(0, 2)
}

export function SocialTradingPreview() {
  const t = useT()
  const sp = t.socialTradingPage
  const labels = t.landing.nav.productMenu.labels

  return (
    <AppPreviewWindow activeRoute="/social-trading">
      <PreviewPageHeader title={sp.title} />
      <div className="mb-4 flex items-center gap-2">
        {[sp.tabProviders, sp.tabFollowers, sp.tabFollowing].map((tab, index) => (
          <span
            key={tab}
            className={clsx(
              'rounded-full px-4 py-1.5 text-sm font-medium',
              index === 0
                ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-950'
                : 'bg-white text-neutral-900 ring-1 ring-neutral-200 dark:bg-neutral-900 dark:text-neutral-50 dark:ring-neutral-700',
            )}
          >
            {tab}
          </span>
        ))}
        <div className="ms-auto flex h-9 w-60 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50">
          <Search className="h-4 w-4" />
          <span className="truncate">{sp.searchPlaceholder}</span>
        </div>
      </div>
      <div className={PREVIEW_CARD}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-100 text-left text-xs font-medium text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
              <th className="px-4 py-3">{sp.colName}</th>
              <th className="px-3 py-3">{sp.colStatus}</th>
              <th className="px-3 py-3">{sp.sortRoi}</th>
              <th className="px-3 py-3">{sp.winRate}</th>
              <th className="px-3 py-3">{sp.closedTrades}</th>
              <th className="px-3 py-3">{sp.colBalance}</th>
              <th className="px-3 py-3">{sp.colPrice}</th>
              <th className="px-4 py-3 text-end">{sp.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {TRADERS.map(trader => (
              <tr key={trader.name} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-green-100 text-xs font-semibold text-neutral-950">
                      {initials(trader.name)}
                    </span>
                    <div>
                      <p className="font-medium text-neutral-900 dark:text-neutral-50">{trader.name}</p>
                      <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-neutral-900 dark:text-neutral-50">
                        <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                        {trader.rating.toFixed(1)}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3">
                  <PreviewBadge>{sp.statusActive}</PreviewBadge>
                </td>
                <td className="px-3 py-3 font-medium text-green-600 dark:text-green-400">{trader.roi}</td>
                <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{trader.winRate}</td>
                <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{trader.trades}</td>
                <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">{trader.balance}</td>
                <td className="px-3 py-3 text-neutral-900 dark:text-neutral-100">
                  {trader.price ? sp.pricePerMonth.replace('{amount}', trader.price) : sp.priceFree}
                </td>
                <td className="px-4 py-3 text-end">
                  <span
                    className={clsx(
                      'inline-block rounded-lg px-3 py-1.5 text-xs font-medium',
                      trader.following
                        ? 'border border-neutral-200 text-neutral-900 dark:border-neutral-700 dark:text-neutral-50'
                        : 'bg-green-400 text-neutral-950',
                    )}
                  >
                    {trader.following ? labels.following : labels.copyTrader}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppPreviewWindow>
  )
}
