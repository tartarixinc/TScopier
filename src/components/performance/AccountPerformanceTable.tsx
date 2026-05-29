import { Link } from 'react-router-dom'
import type { BrokerAccount } from '../../types/database'
import type { LinkedAccountPerformance } from '../../lib/dashboardTradeStats'
import { inferBrokerLabelFromServer } from '../../lib/brokerFromServer'
import { useFormatMoney } from '../../hooks/useFormatMoney'

interface AccountPerformanceTableProps {
  accounts: BrokerAccount[]
  performance: Record<string, LinkedAccountPerformance>
  equityByAccountId: Record<string, number>
  labels: {
    account: string
    broker: string
    equity: string
    roi: string
    winRate: string
    maxDrawdown: string
    configure: string
    empty: string
  }
}

function formatPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function formatRoi(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(1)}%`
}

export function AccountPerformanceTable({
  accounts,
  performance,
  equityByAccountId,
  labels,
}: AccountPerformanceTableProps) {
  const { formatMoney } = useFormatMoney()
  if (accounts.length === 0) {
    return (
      <p className="px-4 py-10 text-center text-sm text-neutral-500 dark:text-neutral-400">{labels.empty}</p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <th className="px-4 py-3">{labels.account}</th>
            <th className="px-4 py-3">{labels.broker}</th>
            <th className="px-4 py-3 text-right">{labels.equity}</th>
            <th className="px-4 py-3 text-right">{labels.roi}</th>
            <th className="px-4 py-3 text-right">{labels.winRate}</th>
            <th className="px-4 py-3 text-right">{labels.maxDrawdown}</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const perf = performance[account.id]
            const equity = equityByAccountId[account.id] ?? account.last_equity ?? account.last_balance
            const roi = perf?.roi ?? null
            const winRate = perf?.winRate ?? null
            const maxDd = perf?.maxDrawdownPct ?? null
            const broker =
              account.broker_name?.trim() ||
              inferBrokerLabelFromServer(account.broker_server ?? '') ||
              '—'
            return (
              <tr
                key={account.id}
                className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/80 dark:hover:bg-neutral-800/40"
              >
                <td className="px-4 py-3 font-medium text-neutral-900 dark:text-neutral-50">
                  {account.label || 'Unnamed'}
                  <span className="ml-2 text-[10px] font-semibold uppercase text-teal-600 dark:text-teal-400">
                    {account.platform}
                  </span>
                </td>
                <td className="px-4 py-3 text-neutral-600 dark:text-neutral-400">{broker}</td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMoney(equity)}</td>
                <td
                  className={`px-4 py-3 text-right font-semibold tabular-nums ${
                    roi == null ? '' : roi > 0 ? 'text-teal-600' : roi < 0 ? 'text-neutral-600 dark:text-neutral-400' : ''
                  }`}
                >
                  {formatRoi(roi)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{formatPct(winRate, 0)}</td>
                <td
                  className={`px-4 py-3 text-right tabular-nums ${
                    maxDd != null && maxDd > 0 ? 'text-neutral-600 dark:text-neutral-400' : ''
                  }`}
                >
                  {formatPct(maxDd)}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to="/account-configuration"
                    className="text-xs font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400"
                  >
                    {labels.configure}
                  </Link>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
