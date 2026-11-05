import { useEffect, useState } from 'react'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import { resolveProvider, type BrokerProvider } from '../lib/brokerLink'
import {
  describeLiveFetchError,
  liveOpenPnlFromMtTrades,
  liveOpenPnlFromOpenedOrders,
  liveOpenPnlFromSummary,
  preferLiveOpenPnl,
} from '../lib/liveOpenPnl'

const MTAPI_POLL_MS = 15_000
const DEFAULT_POLL_MS = 10_000

type Live = { accountId: string; openPnl: number | null; error: string | null }

async function fetchPositionOpenPnl(brokerId: string, provider: BrokerProvider): Promise<number | null> {
  if (provider === 'ctrader' || provider === 'binance' || provider === 'bybit' || provider === 'kucoin') {
    const { trades } = await fxsocketBroker.trades({
      brokerId,
      scope: 'open',
      historyProfile: 'dashboard',
      provider,
    })
    return liveOpenPnlFromMtTrades(trades)
  }
  const orders = await fxsocketBroker.openedOrders(brokerId, provider)
  return liveOpenPnlFromOpenedOrders(orders)
}

/**
 * Fetches floating open P/L live from the trading account while a social profile is open.
 * Uses account summary plus open positions so equity≈balance snapshots do not show $0.00.
 */
export function useLiveOwnOpenPnl(accountId: string, openCount: number, enabled: boolean) {
  const { brokers, upsertBroker } = useBrokerAccounts()
  const broker = brokers.find(item => item.id === accountId) ?? null
  const brokerId = broker?.id ?? ''
  const provider = broker ? resolveProvider(broker) : null
  const [live, setLive] = useState<Live | null>(null)

  useEffect(() => {
    if (!enabled || !brokerId || !provider) return undefined
    let cancelled = false
    const poll = async () => {
      try {
        let summary
        let serverError: string | undefined
        if (provider === 'mtapi') {
          const refreshed = await fxsocketBroker.refreshSummary(brokerId, 'mtapi')
          if (!cancelled && refreshed.account) upsertBroker(refreshed.account)
          summary = refreshed.pending ? undefined : refreshed.summary
          serverError = refreshed.error
        } else {
          summary = (await fxsocketBroker.liveSnapshot(brokerId, provider)).summary
        }
        if (cancelled) return

        const summaryOpen = typeof summary?.open_trades === 'number' && Number.isFinite(summary.open_trades)
          ? summary.open_trades
          : openCount
        const fromSummary = liveOpenPnlFromSummary(summary, summaryOpen)

        let fromPositions: number | null = null
        const needsPositions = summaryOpen > 0 || openCount > 0 || fromSummary == null || Math.abs(fromSummary) < 0.005
        if (needsPositions) {
          try {
            fromPositions = await fetchPositionOpenPnl(brokerId, provider)
          } catch {
            fromPositions = null
          }
        }
        if (cancelled) return

        const openPnl = preferLiveOpenPnl({
          fromSummary,
          fromPositions,
          openCount: Math.max(summaryOpen, openCount),
        })

        setLive(prev => ({
          accountId: brokerId,
          openPnl: openPnl ?? (prev?.accountId === brokerId ? prev.openPnl : null),
          error: openPnl == null ? describeLiveFetchError(serverError) : null,
        }))
      } catch (cause) {
        if (!cancelled) {
          setLive(prev => ({
            accountId: brokerId,
            openPnl: prev?.accountId === brokerId ? prev.openPnl : null,
            error: describeLiveFetchError(cause instanceof Error ? cause.message : 'Live fetch failed.'),
          }))
        }
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), provider === 'mtapi' ? MTAPI_POLL_MS : DEFAULT_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // openCount only tunes heuristics; do not restart polling when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, brokerId, provider, upsertBroker])

  const current = live && live.accountId === brokerId ? live : null
  return { openPnl: current?.openPnl ?? null, error: current?.error ?? null }
}
