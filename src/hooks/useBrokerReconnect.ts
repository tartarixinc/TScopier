import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BrokerAccount } from '../types/database'
import { metatraderApi } from '../lib/metatraderapi'
import { brokerCanReconnect, brokerNeedsPasswordForReconnect } from '../lib/brokerReconnect'

export interface UseBrokerReconnectOptions {
  brokers: BrokerAccount[]
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>
  autoReconnect?: boolean
  autoReconnectActiveOnly?: boolean
  onError?: (message: string) => void
  onClearError?: () => void
  reconnectFailedLabel: string
  passwordPrompt?: string
  onReconnectSuccess?: (brokerId: string) => void
}

export function useBrokerReconnect(opts: UseBrokerReconnectOptions) {
  const [reconnectingBrokerIds, setReconnectingBrokerIds] = useState<Set<string>>(() => new Set())
  const autoAttemptedRef = useRef(new Set<string>())

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

  useEffect(() => {
    for (const b of opts.brokers) {
      if (b.connection_status === 'connected') {
        autoAttemptedRef.current.delete(b.id)
      }
    }
  }, [opts.brokers])

  useEffect(() => {
    if (!opts.autoReconnect) return
    const activeOnly = opts.autoReconnectActiveOnly !== false
    for (const b of opts.brokers) {
      if (activeOnly && !b.is_active) continue
      if (!brokerCanReconnect(b)) continue
      if (autoAttemptedRef.current.has(b.id)) continue
      autoAttemptedRef.current.add(b.id)
      void reconnectBroker(b.id, { allowPasswordPrompt: false })
    }
  }, [opts.autoReconnect, opts.autoReconnectActiveOnly, opts.brokers, reconnectBroker])

  return {
    reconnectBroker,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting: (brokerId: string) => reconnectingBrokerIds.has(brokerId),
  }
}
