import clsx from 'clsx'
import { Button } from '../ui/Button'
import type { BrokerActiveSignalTrade } from '../../lib/brokerStats'
import type { DashboardBrokerStatsTranslations } from '../../i18n/locales/types'

type ActiveSignalTradesSectionProps = {
  rows: BrokerActiveSignalTrade[]
  bs: DashboardBrokerStatsTranslations
  formatSignedMoney: (value: number) => string
  pnlColor: (value: number) => string
  canClose: boolean
  closeBusy: boolean
  showHeader?: boolean
  showCloseAll?: boolean
  closingAll?: boolean
  onCloseAll?: () => void
  isClosingChannel: (channelId: string) => boolean
  onCloseChannel: (row: BrokerActiveSignalTrade) => void
}

export function ActiveSignalTradesSection({
  rows,
  bs,
  formatSignedMoney,
  pnlColor,
  canClose,
  closeBusy,
  showHeader = true,
  showCloseAll = true,
  closingAll = false,
  onCloseAll,
  isClosingChannel,
  onCloseChannel,
}: ActiveSignalTradesSectionProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-neutral-400 dark:text-neutral-500">{bs.noActiveSignalTrade}</p>
    )
  }

  return (
    <>
      {showHeader ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{bs.activeSignalTrade}</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{bs.activeSignalTradeHint}</p>
          </div>
          {showCloseAll && onCloseAll ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={closingAll}
              disabled={!canClose || closeBusy}
              title={!canClose ? bs.closeDisconnected : undefined}
              onClick={onCloseAll}
              className="shrink-0"
            >
              {closingAll ? bs.closing : bs.closeAllChannels}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ul
        className={clsx(
          'divide-y divide-neutral-100 dark:divide-neutral-800 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden',
          showHeader ? 'mt-3' : '',
        )}
      >
        {rows.map(row => (
          <li
            key={row.channelId}
            className="flex items-center justify-between gap-3 px-4 py-3 bg-white dark:bg-neutral-900"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">
                {row.channelLabel}
              </p>
              <p className="text-xs text-neutral-400 mt-0.5 tabular-nums">
                {row.totalLots > 0 ? `${row.totalLots.toFixed(2)} ${bs.lots}` : '—'}
              </p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wide text-neutral-400">{bs.openPnl}</p>
                <p className={clsx('text-sm font-semibold tabular-nums', pnlColor(row.pnl))}>
                  {formatSignedMoney(row.pnl)}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={isClosingChannel(row.channelId)}
                disabled={!canClose || closeBusy}
                title={!canClose ? bs.closeDisconnected : undefined}
                onClick={() => { onCloseChannel(row) }}
              >
                {isClosingChannel(row.channelId) ? bs.closing : bs.closeChannel}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
