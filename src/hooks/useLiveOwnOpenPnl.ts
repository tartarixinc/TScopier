import { useEffect, useState } from 'react'
import { useBrokerAccounts } from '../context/BrokerAccountsContext'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import { resolveProvider } from '../lib/brokerLink'
import { describeLiveFetchError, liveOpenPnlFromSummary } from '../lib/liveOpenPnl'

const MTAPI_POLL_MS = 60_000
const DEFAULT_POLL_MS = 15_000

type Live = { accountId: string; openPnl: number | null; error: string | null }

/**
 * Fetches the real floating P/L straight from the trading account (not the saved snapshot) while
 * the "You" page is open. Also writes the refreshed balance/equity back into the broker list.
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
        const openPnl = liveOpenPnlFromSummary(summary, openCount)
        // A failed poll must not wipe the last good value, or the page flips between a number and an em dash.
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
    // openCount only tunes the 0-P/L heuristic; do not restart polling when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, brokerId, provider, upsertBroker])

  const current = live && live.accountId === brokerId ? live : null
  return { openPnl: current?.openPnl ?? null, error: current?.error ?? null }
}
