import { useEffect, useMemo, useRef, useState } from 'react'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import {
  hasLinkedBrokerForUi,
  isFxsocketLinkedBroker,
  resolveProvider,
  type BrokerProvider,
} from '../lib/brokerLink'
import {
  mergePositionRowIntoBook,
  rebuildPositionBookFromPayload,
  snapshotFromPositionBook,
  type FxsocketPositionBook,
} from '../lib/fxsocketLivePositionBook'
import {
  isFxsocketMarketPositionRow,
  resolveFxsocketFloatingOpenPnl,
  unwrapFxsocketPositionsPayload,
} from '../lib/fxsocketStreamParse'
import { useFxsocketStream } from './useFxsocketStream'
import {
  describeLiveFetchError,
  liveOpenPnlFromMtTrades,
  liveOpenPnlFromOpenedOrders,
  liveOpenPnlFromSummary,
  preferLiveOpenPnl,
} from '../lib/liveOpenPnl'

/** Match Dashboard MTAPI cadence — avoid thrashing the shared trade session. */
const MTAPI_POLL_MS = 45_000
const DEFAULT_POLL_MS = 4_000

type Live = { accountId: string; openPnl: number | null; openTrades: number; error: string | null }

/**
 * Live floating open P/L for the published social source account.
 * Uses the same FxSocket account + positions stream as Linked Accounts, with REST
 * summary/open-orders as bootstrap (and the only live path for MTAPI).
 */
export function useLiveOwnOpenPnl(accountId: string, openCount: number, enabled: boolean) {
  const { brokers, upsertBroker } = useBrokerAccounts()
  const broker = brokers.find(item => item.id === accountId) ?? null
  const brokerId = broker?.id ?? ''
  const provider = broker ? resolveProvider(broker) : null
  const [live, setLive] = useState<Live | null>(null)
  const openTradesRef = useRef(0)
  const positionBookRef = useRef<FxsocketPositionBook>(new Map())
  const lastWsTickRef = useRef(0)

  const streamBrokers = useMemo(
    () => (broker && enabled && isFxsocketLinkedBroker(broker) ? [broker] : []),
    [broker, enabled],
  )

  const commit = (next: Partial<Live> & { accountId: string }) => {
    setLive(prev => {
      const openPnl = next.openPnl !== undefined
        ? next.openPnl
        : prev?.accountId === next.accountId
          ? prev.openPnl
          : null
      const openTrades = next.openTrades ?? (prev?.accountId === next.accountId ? prev.openTrades : 0)
      openTradesRef.current = openTrades
      return {
        accountId: next.accountId,
        openPnl,
        openTrades,
        error: next.error !== undefined
          ? next.error
          : openPnl == null
            ? (prev?.accountId === next.accountId ? prev.error : null)
            : null,
      }
    })
  }

  useFxsocketStream(streamBrokers, {
    onAccount: (id, snap) => {
      if (id !== brokerId) return
      lastWsTickRef.current = Date.now()
      const openPnl = resolveFxsocketFloatingOpenPnl(snap, openTradesRef.current)
      if (openPnl == null || !Number.isFinite(openPnl)) return
      // Do not overwrite a live positions-book mark with a flat/partial account tick.
      setLive(prev => {
        if (prev?.accountId === id && prev.openPnl != null && Math.abs(openPnl) < 0.005 && openTradesRef.current > 0) {
          return prev
        }
        openTradesRef.current = prev?.accountId === id ? prev.openTrades : openTradesRef.current
        return {
          accountId: id,
          openPnl: Math.round(openPnl * 100) / 100,
          openTrades: openTradesRef.current,
          error: null,
        }
      })
    },
    onPositions: (id, snapshot, rawData) => {
      if (id !== brokerId) return
      lastWsTickRef.current = Date.now()
      const rows = unwrapFxsocketPositionsPayload(rawData)
      if (rows.length === 0) {
        positionBookRef.current = new Map()
      } else if (rows.length === 1 && isFxsocketMarketPositionRow(rows[0])) {
        const book = positionBookRef.current
        mergePositionRowIntoBook(book, rows[0])
        positionBookRef.current = book
      } else {
        positionBookRef.current = rebuildPositionBookFromPayload(rawData)
      }
      const bookSnap = snapshotFromPositionBook(positionBookRef.current)
      const openPnl = bookSnap.openPnl ?? snapshot.openPnl
      commit({
        accountId: id,
        openTrades: bookSnap.openTrades || snapshot.openTrades,
        ...(openPnl != null && Number.isFinite(openPnl) ? { openPnl } : {}),
        error: null,
      })
    },
    onTrade: (id, data) => {
      if (id !== brokerId) return
      lastWsTickRef.current = Date.now()
      const book = positionBookRef.current
      mergePositionRowIntoBook(book, data)
      positionBookRef.current = book
      const snap = snapshotFromPositionBook(book)
      commit({
        accountId: id,
        openTrades: snap.openTrades,
        ...(snap.openPnl != null ? { openPnl: snap.openPnl } : {}),
        error: null,
      })
    },
  }, streamBrokers.length > 0)

  useEffect(() => {
    if (!enabled || !brokerId || !provider || !broker) return undefined
    if (!hasLinkedBrokerForUi(broker)) return undefined
    let cancelled = false
    positionBookRef.current = new Map()
    openTradesRef.current = Math.max(0, openCount)

    const poll = async () => {
      try {
        // Skip REST while the WS positions stream is actively ticking (same gate as Dashboard).
        if (
          provider !== 'mtapi'
          && Date.now() - lastWsTickRef.current < 2_500
        ) {
          return
        }

        let fromSummary: number | null = null
        let summaryOpen = openCount
        let serverError: string | undefined

        if (provider === 'ctrader' || provider === 'binance' || provider === 'bybit' || provider === 'kucoin') {
          const { trades } = await fxsocketBroker.trades({
            brokerId,
            scope: 'open',
            historyProfile: 'dashboard',
            provider,
          })
          if (cancelled) return
          fromSummary = liveOpenPnlFromMtTrades(trades)
          summaryOpen = trades.filter(trade => trade.status !== 'closed').length
        } else {
          let summary
          if (provider === 'mtapi') {
            const refreshed = await fxsocketBroker.refreshSummary(brokerId, 'mtapi')
            if (!cancelled && refreshed.account) upsertBroker(refreshed.account)
            summary = refreshed.pending ? undefined : refreshed.summary
            serverError = refreshed.error
          } else {
            summary = (await fxsocketBroker.liveSnapshot(brokerId, provider as BrokerProvider)).summary
          }
          if (cancelled) return
          summaryOpen = typeof summary?.open_trades === 'number' && Number.isFinite(summary.open_trades)
            ? summary.open_trades
            : openCount
          fromSummary = liveOpenPnlFromSummary(summary, summaryOpen)
        }

        let fromPositions: number | null = null
        const needsPositions = summaryOpen > 0 || openCount > 0 || fromSummary == null || Math.abs(fromSummary) < 0.005
        if (needsPositions && provider !== 'ctrader' && provider !== 'binance' && provider !== 'bybit' && provider !== 'kucoin') {
          try {
            fromPositions = liveOpenPnlFromOpenedOrders(
              await fxsocketBroker.openedOrders(brokerId, provider),
            )
          } catch {
            fromPositions = null
          }
        }
        if (cancelled) return

        // When the WS book is actively ticking, keep it — REST is only for bootstrap / MTAPI.
        if (Date.now() - lastWsTickRef.current < 2_500) return

        const openPnl = preferLiveOpenPnl({
          fromSummary,
          fromPositions,
          openCount: Math.max(summaryOpen, openCount),
        })
        // Keep the previous mark on a failed/partial MTAPI poll — wiping it makes
        // the Social profile flash dashes even though we already have a value.
        commit({
          accountId: brokerId,
          ...(openPnl != null ? { openPnl } : {}),
          openTrades: Math.max(summaryOpen, openCount),
          error: openPnl == null ? describeLiveFetchError(serverError) : null,
        })
      } catch (cause) {
        if (!cancelled) {
          commit({
            accountId: brokerId,
            error: describeLiveFetchError(cause instanceof Error ? cause.message : 'Live fetch failed.'),
          })
        }
      }
    }

    void poll()
    const timer = window.setInterval(
      () => void poll(),
      provider === 'mtapi' ? MTAPI_POLL_MS : DEFAULT_POLL_MS,
    )
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // openCount only seeds heuristics; live WS ticks must not restart the poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, brokerId, provider, upsertBroker])

  const current = live && live.accountId === brokerId ? live : null
  return { openPnl: current?.openPnl ?? null, error: current?.error ?? null }
}
