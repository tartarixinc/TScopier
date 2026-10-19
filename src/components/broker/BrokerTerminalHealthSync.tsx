import { useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { brokerAccountHealthPatchFromMtStatus } from '../../lib/brokerHealth'
import { BrokerHealthCheckUnsupportedError, fxsocketBroker } from '../../lib/fxsocketBroker'
import { hasLinkedBrokerForUi, resolveProvider } from '../../lib/brokerLink'
import { routeNeedsLiveBrokerConnectivity } from '../../lib/liveBrokerRoutes'

const HEALTH_POLL_INTERVAL_MS = 45_000

/** Poll terminal health for linked FxSocket, MTAPI, cTrader, Binance, Bybit, KuCoin, and DXtrade accounts on live dashboard routes. */
export function BrokerTerminalHealthSync() {
  const { user } = useAuth()
  const location = useLocation()
  const { brokers, upsertBroker, healthPollingPaused } = useBrokerAccounts()

  const brokerIdsKey = useMemo(
    () => brokers
      .filter(b => {
        if (!hasLinkedBrokerForUi(b)) return false
        if (b.connection_status === 'pending') return false
        if (b.fxsocket_status === 'connecting' || b.mtapi_status === 'connecting' || b.ctrader_status === 'connecting' || b.binance_status === 'connecting' || b.bybit_status === 'connecting' || b.kucoin_status === 'connecting' || b.dxtrade_status === 'connecting') return false
        return true
      })
      .map(b => `${b.id}:${resolveProvider(b)}`)
      .sort()
      .join(','),
    [brokers],
  )

  const shouldPoll = Boolean(
    user?.id
    && brokerIdsKey
    && routeNeedsLiveBrokerConnectivity(location.pathname)
    && !healthPollingPaused,
  )
  const terminalHealthSupportedRef = useRef(true)

  useEffect(() => {
    if (!shouldPoll || !terminalHealthSupportedRef.current) return

    let cancelled = false

    const syncHealth = async () => {
      for (const token of brokerIdsKey.split(',')) {
        if (cancelled || !token || !terminalHealthSupportedRef.current) continue
        const splitAt = token.lastIndexOf(':')
        const id = token.slice(0, splitAt)
        const suffix = token.slice(splitAt + 1)
        const provider = suffix === 'mtapi' ? 'mtapi' as const : suffix === 'ctrader' ? 'ctrader' as const : suffix === 'binance' ? 'binance' as const : suffix === 'bybit' ? 'bybit' as const : suffix === 'kucoin' ? 'kucoin' as const : suffix === 'dxtrade' ? 'dxtrade' as const : 'fxsocket' as const
        if (!id) continue
        try {
          const { account, status } = await fxsocketBroker.checkStatus(id, provider)
          if (cancelled) return
          upsertBroker({
            ...account,
            ...brokerAccountHealthPatchFromMtStatus(status),
          })
        } catch (err) {
          if (err instanceof BrokerHealthCheckUnsupportedError) {
            terminalHealthSupportedRef.current = false
            return
          }
          const msg = err instanceof Error ? err.message : String(err)
          if (/throttl|rate limit|expected available in/i.test(msg)) {
            // Back off the whole poll cycle; do not treat throttle as unhealthy.
            return
          }
          // Next interval retries for transient errors.
        }
        await new Promise(r => setTimeout(r, 750))
      }
    }

    void syncHealth()
    const timer = window.setInterval(() => void syncHealth(), HEALTH_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [brokerIdsKey, shouldPoll, upsertBroker])

  return null
}
