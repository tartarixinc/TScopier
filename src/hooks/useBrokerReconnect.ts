import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BrokerAccount } from '../types/database'
import { metatraderApi } from '../lib/metatraderapi'
import { brokerCanReconnect, brokerNeedsPasswordForReconnect } from '../lib/brokerReconnect'

const SILENT_RECONNECT_INTERVAL_MS = 45_000

export interface UseBrokerReconnectOptions {
  brokers: BrokerAccount[]
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>
  autoReconnect?: boolean
  autoReconnectActiveOnly?: boolean
  autoReconnectPaused?: boolean
  onError?: (message: string) => void
  onClearError?: () => void
  reconnectFailedLabel: string
  passwordPrompt?: string
  onReconnectSuccess?: (brokerId: string) => void
}

export function useBrokerReconnect(opts: UseBrokerReconnectOptions) {
  const [reconnectingBrokerIds, setReconnectingBrokerIds] = useState<Set<string>>(() => new Set())
  const silentReconnectingRef = useRef(new Set<string>())

  const brokersNeedingReconnect = useMemo(
    () => opts.brokers.filter(brokerCanReconnect),
    [opts.brokers],
  )

  const applyReconnectResult = useCallback((
    brokerId: string,
    result: Awaited<ReturnType<typeof metatraderApi.reconnect>>,
  ) => {
    opts.setBrokers(prev =>
      prev.map(b => {
        if (b.id !== brokerId) return b
        if (result.connection_status !== 'connected' || !result.summary) {
          return { ...b, connection_status: 'error' as const }
        }
        return {
          ...b,
          connection_status: 'connected' as const,
          last_synced_at: new Date().toISOString(),
          ...(result.summary
            ? {
                last_balance: result.summary.balance ?? b.last_balance,
                last_equity: result.summary.equity ?? b.last_equity,
                last_currency: result.summary.currency ?? b.last_currency,
              }
            : {}),
        }
      }),
    )
    if (result.connection_status === 'connected' && result.summary) {
      opts.onReconnectSuccess?.(brokerId)
    } else if (result.message) {
      opts.onError?.(result.message)
    }
  }, [opts])

  const reconnectBroker = useCallback(async (
    brokerId: string,
    options?: { allowPasswordPrompt?: boolean },
  ) => {
    const allowPasswordPrompt = options?.allowPasswordPrompt !== false
    setReconnectingBrokerIds(prev => new Set(prev).add(brokerId))
    opts.onClearError?.()
    try {
      let result = await metatraderApi.reconnect(brokerId)
      const needsPassword =
        allowPasswordPrompt
        && result.connection_status !== 'connected'
        && brokerNeedsPasswordForReconnect(result.message)
      if (needsPassword && opts.passwordPrompt) {
        const entered = window.prompt(opts.passwordPrompt)
        if (!entered?.trim()) {
          opts.onError?.(result.message ?? opts.reconnectFailedLabel)
          applyReconnectResult(brokerId, result)
          return result
        }
        result = await metatraderApi.reconnect(brokerId, entered.trim())
      }
      applyReconnectResult(brokerId, result)
      if (
        allowPasswordPrompt
        && result.connection_status !== 'connected'
        && result.message
      ) {
        opts.onError?.(result.message)
      }
      return result
    } catch (e) {
      opts.onError?.(e instanceof Error ? e.message : opts.reconnectFailedLabel)
      throw e
    } finally {
      setReconnectingBrokerIds(prev => {
        const next = new Set(prev)
        next.delete(brokerId)
        return next
      })
    }
  }, [applyReconnectResult, opts])

  const silentReconnectBroker = useCallback(async (brokerId: string) => {
    if (silentReconnectingRef.current.has(brokerId)) return
    silentReconnectingRef.current.add(brokerId)
    try {
      const result = await metatraderApi.reconnect(brokerId)
      if (result.connection_status === 'connected') {
        opts.setBrokers(prev =>
          prev.map(b => {
            if (b.id !== brokerId) return b
            return {
              ...b,
              connection_status: 'connected' as const,
              last_synced_at: new Date().toISOString(),
              ...(result.summary
                ? {
                    last_balance: result.summary.balance ?? b.last_balance,
                    last_equity: result.summary.equity ?? b.last_equity,
                    last_currency: result.summary.currency ?? b.last_currency,
                  }
                : {}),
            }
          }),
        )
      }
    } catch {
      // Silent — no user-facing error
    } finally {
      silentReconnectingRef.current.delete(brokerId)
    }
  }, [opts])

  // Initial auto-reconnect on mount
  useEffect(() => {
    if (!opts.autoReconnect || opts.autoReconnectPaused) return
    const activeOnly = opts.autoReconnectActiveOnly !== false
    for (const b of opts.brokers) {
      if (activeOnly && !b.is_active) continue
      if (!brokerCanReconnect(b)) continue
      void silentReconnectBroker(b.id)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Periodic silent reconnect loop for disconnected brokers
  useEffect(() => {
    if (!opts.autoReconnect || opts.autoReconnectPaused) return
    const activeOnly = opts.autoReconnectActiveOnly !== false

    const runSilentSweep = () => {
      if (opts.autoReconnectPaused || document.visibilityState !== 'visible') return
      for (const b of opts.brokers) {
        if (activeOnly && !b.is_active) continue
        if (!brokerCanReconnect(b)) continue
        void silentReconnectBroker(b.id)
      }
    }

    const timer = setInterval(runSilentSweep, SILENT_RECONNECT_INTERVAL_MS)

    const onVisible = () => {
      if (document.visibilityState === 'visible') runSilentSweep()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [opts.autoReconnect, opts.autoReconnectActiveOnly, opts.autoReconnectPaused, opts.brokers, silentReconnectBroker])

  return {
    reconnectBroker,
    silentReconnectBroker,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting: (brokerId: string) => reconnectingBrokerIds.has(brokerId),
  }
}
