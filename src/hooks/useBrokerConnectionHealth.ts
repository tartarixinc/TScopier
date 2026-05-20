import { useEffect, useMemo, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { BrokerAccount } from '../types/database'
import { isMtSessionUuid } from '../lib/brokerLink'
import { brokerHealthPollIntervalMs, isTransientBrokerHealthError } from '../lib/brokerHealthCheck'
import { metatraderApi } from '../lib/metatraderapi'

const FAILURES_BEFORE_DISCONNECT = 2

/**
 * Periodically verify brokers marked "connected" can actually reach trading APIs.
 * Ignores auth/platform blips and requires consecutive failures before marking error.
 */
export function useBrokerConnectionHealth(
  brokers: BrokerAccount[],
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>,
  baseIntervalMs = 20_000,
): void {
  const failCountsRef = useRef(new Map<string, number>())

  const connectedIds = useMemo(
    () =>
      brokers
        .filter(b => b.connection_status === 'connected' && isMtSessionUuid(b.metaapi_account_id))
        .map(b => b.id),
    [brokers],
  )
  const connectedKey = connectedIds.join(',')
  const pollIntervalMs = brokerHealthPollIntervalMs(connectedIds.length, baseIntervalMs)

  useEffect(() => {
    if (!connectedKey) return

    let cancelled = false
    const activeIds = new Set(connectedIds)

    const verifyAll = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      for (const id of connectedIds) {
        if (cancelled) return
        try {
          await metatraderApi.check(id)
          failCountsRef.current.delete(id)
        } catch (err) {
          if (cancelled) return
          const msg = err instanceof Error ? err.message : String(err)
          if (isTransientBrokerHealthError(msg)) continue

          const prevFails = failCountsRef.current.get(id) ?? 0
          const nextFails = prevFails + 1
          failCountsRef.current.set(id, nextFails)
          if (nextFails < FAILURES_BEFORE_DISCONNECT) continue

          setBrokers(prev =>
            prev.map(b => (b.id === id ? { ...b, connection_status: 'error' as const } : b)),
          )
        }
        await new Promise(r => setTimeout(r, 800))
      }
    }

    for (const id of [...failCountsRef.current.keys()]) {
      if (!activeIds.has(id)) failCountsRef.current.delete(id)
    }

    void verifyAll()
    const timer = window.setInterval(() => {
      void verifyAll()
    }, pollIntervalMs)

    const onVisible = () => {
      if (document.visibilityState === 'visible') void verifyAll()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [connectedKey, connectedIds, pollIntervalMs, setBrokers])
}
