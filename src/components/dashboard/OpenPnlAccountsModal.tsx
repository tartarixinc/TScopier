import { useEffect } from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { interpolate } from '../../i18n/interpolate'
import { useForceCloseSignalTrades } from '../../hooks/useForceCloseSignalTrades'
import { CloseSignalTradesConfirmModal } from './CloseSignalTradesConfirmModal'
import type { PortfolioBrokerActiveSignals } from '../../lib/brokerStats'
import { ActiveSignalTradesSection } from './ActiveSignalTradesSection'
import { Button } from '../ui/Button'

type OpenPnlAccountsModalProps = {
  open: boolean
  groups: PortfolioBrokerActiveSignals[]
  totalOpenPnl: number
  accountCount: number
  onClose: () => void
  onRefresh?: () => void | Promise<void>
}

export function OpenPnlAccountsModal({
  open,
  groups,
  totalOpenPnl,
  accountCount,
  onClose,
  onRefresh,
}: OpenPnlAccountsModalProps) {
  const t = useT()
  const d = t.dashboard
  const { formatSignedMoney } = useFormatMoney()
  const {
    bs,
    closeBusy,
    closingAllBrokers,
    toastMessage,
    pendingConfirm,
    confirmingClose,
    dismissCloseConfirm,
    confirmPendingClose,
    closeChannel,
    closeBroker,
    closeAllBrokers,
    isClosingChannel,
    isClosingBroker,
  } = useForceCloseSignalTrades({ onRefresh })

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  const pnlColor = (n: number) =>
    n > 0 ? 'text-teal-600' : n < 0 ? 'text-error-600' : 'text-neutral-900 dark:text-neutral-50'

  const connectedBrokerIds = groups.filter(g => g.connected).map(g => g.brokerId)
  const canCloseAny = connectedBrokerIds.length > 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-pnl-accounts-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={bs.close}
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="min-w-0">
            <h2 id="open-pnl-accounts-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {d.openPnlModalTitle}
            </h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {interpolate(d.openPnlModalSubtitle, {
                count: String(accountCount),
                pnl: formatSignedMoney(totalOpenPnl),
              })}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {groups.length > 0 ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={closingAllBrokers}
                disabled={!canCloseAny || closeBusy}
                title={!canCloseAny ? bs.closeDisconnected : undefined}
                onClick={() => {
                  closeAllBrokers(connectedBrokerIds, { groups })
                }}
              >
                {closingAllBrokers ? bs.closing : d.closeAllAccounts}
              </Button>
            ) : null}
            <button
              type="button"
              className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label={bs.close}
              onClick={onClose}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 space-y-4">
          {groups.length === 0 ? (
            <p className="text-sm text-neutral-400 dark:text-neutral-500">{d.openPnlModalEmpty}</p>
          ) : (
            groups.map(group => (
              <section
                key={group.brokerId}
                className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-4"
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 truncate">
                      {group.accountLabel}
                    </p>
                    <p className="text-xs text-primary-600 font-medium uppercase tabular-nums">{group.platformLine}</p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">{group.brokerLabel}</p>
                  </div>
                  <div className="text-right shrink-0">
                    {group.brokerOpenPnl != null ? (
                      <>
                        <p className="text-[10px] uppercase tracking-wide text-neutral-400">{bs.openPnl}</p>
                        <p className={clsx('text-sm font-semibold tabular-nums', pnlColor(group.brokerOpenPnl))}>
                          {formatSignedMoney(group.brokerOpenPnl)}
                        </p>
                      </>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      loading={isClosingBroker(group.brokerId)}
                      disabled={!group.connected || closeBusy}
                      title={!group.connected ? bs.closeDisconnected : undefined}
                      onClick={() => {
                        closeBroker(group.brokerId, {
                          accountLabel: group.accountLabel,
                          activeSignalTrades: group.activeSignalTrades,
                        })
                      }}
                      className="mt-2"
                    >
                      {isClosingBroker(group.brokerId) ? bs.closing : bs.closeAllChannels}
                    </Button>
                  </div>
                </div>
                <ActiveSignalTradesSection
                  rows={group.activeSignalTrades}
                  bs={bs}
                  formatSignedMoney={formatSignedMoney}
                  pnlColor={pnlColor}
                  canClose={group.connected}
                  closeBusy={closeBusy}
                  showHeader={false}
                  showCloseAll={false}
                  isClosingChannel={channelId => isClosingChannel(group.brokerId, channelId)}
                  onCloseChannel={(row) => {
                    closeChannel(group.brokerId, row.channelId, {
                      channelLabel: row.channelLabel,
                      accountLabel: group.accountLabel,
                      totalLots: row.totalLots,
                      pnl: row.pnl,
                      positionCount: row.positionCount,
                    })
                  }}
                />
              </section>
            ))
          )}
        </div>
      </div>

      {pendingConfirm ? (
        <CloseSignalTradesConfirmModal
          request={pendingConfirm}
          formatSignedMoney={formatSignedMoney}
          confirming={confirmingClose}
          onCancel={dismissCloseConfirm}
          onConfirm={() => { void confirmPendingClose() }}
        />
      ) : null}

      {toastMessage ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-md px-4 py-3 rounded-xl bg-neutral-900 text-white text-sm shadow-lg dark:bg-neutral-100 dark:text-neutral-900"
        >
          {toastMessage}
        </div>
      ) : null}
    </div>
  )
}
