import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { BrokerAccount } from '../types/database'
import { metatraderApi } from '../lib/metatraderapi'
import { brokerCanReconnect, brokerNeedsPasswordForReconnect } from '../lib/brokerReconnect'
import { classifyBrokerConnectError } from '../lib/brokerConnectError'

const SILENT_RECONNECT_INTERVAL_MS = 45_000

type ReconnectResult = Awaited<ReturnType<typeof metatraderApi.reconnect>>

export interface BrokerPasswordPromptResult {
  password: string
  rememberPassword: boolean
}

export interface UseBrokerReconnectOptions {
  brokers: BrokerAccount[]
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>
  autoReconnect?: boolean
  autoReconnectActiveOnly?: boolean
  autoReconnectPaused?: boolean
  onError?: (message: string) => void
  onClearError?: () => void
  reconnectFailedLabel: string
  requestPassword?: (brokerId: string) => Promise<BrokerPasswordPromptResult | null>
  onReconnectSuccess?: (brokerId: string) => void
}

/** Stored password exists but the broker rejected it — user must type a new one. */
const STORED_PASSWORD_REJECTED_KINDS = new Set([
  'wrong_password',
  'credentials_rejected',
  'investor_password',
])

function shouldPromptForPassword(args: {
  hasStoredPassword: boolean
  message: string | undefined
  kind?: string | null
}): boolean {
  if (args.hasStoredPassword) {
    // Auto-reconnect already retried with the saved password. Only ask the
    // user again when that password was rejected, not on transient drops.
    const kind = args.kind ?? classifyBrokerConnectError(args.message)
    return STORED_PASSWORD_REJECTED_KINDS.has(kind)
  }
  return brokerNeedsPasswordForReconnect(args.message)
}

async function reconnectWithOptionalPassword(
  brokerId: string,
  options: {
    allowPasswordPrompt: boolean
    hasStoredPassword: boolean
    requestPassword?: (brokerId: string) => Promise<BrokerPasswordPromptResult | null>
    reconnectFailedLabel: string
    onError?: (message: string) => void
  },
): Promise<{ result: ReconnectResult; rememberPassword?: boolean }> {
  try {
    let result = await metatraderApi.reconnect(brokerId)
    const needsPassword =
      options.allowPasswordPrompt
      && result.connection_status !== 'connected'
      && shouldPromptForPassword({
        hasStoredPassword: options.hasStoredPassword,
        message: result.message,
        kind: result.connection_error_kind,
      })
    if (needsPassword && options.requestPassword) {
      const entered = await options.requestPassword(brokerId)
      if (!entered?.password.trim()) {
        options.onError?.(result.message ?? options.reconnectFailedLabel)
        return { result }
      }
      result = await metatraderApi.reconnect(brokerId, {
        password: entered.password.trim(),
        rememberPassword: entered.rememberPassword,
      })
      return { result, rememberPassword: entered.rememberPassword }
    }
    return { result }
  } catch (e) {
    const msg = e instanceof Error ? e.message : options.reconnectFailedLabel
    if (
      options.allowPasswordPrompt
      && shouldPromptForPassword({ hasStoredPassword: options.hasStoredPassword, message: msg })
      && options.requestPassword
    ) {
      const entered = await options.requestPassword(brokerId)
      if (entered?.password.trim()) {
        try {
          const result = await metatraderApi.reconnect(brokerId, {
            password: entered.password.trim(),
            rememberPassword: entered.rememberPassword,
          })
          return { result, rememberPassword: entered.rememberPassword }
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : options.reconnectFailedLabel
          options.onError?.(retryMsg)
          return {
            result: { ok: false, connection_status: 'error', message: retryMsg },
          }
        }
      }
    }
    options.onError?.(msg)
    return {
      result: { ok: false, connection_status: 'error', message: msg },
    }
  }
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
    result: ReconnectResult,
  ) => {
    opts.setBrokers(prev =>
      prev.map(b => {
        if (b.id !== brokerId) return b
        if (result.connection_status !== 'connected' || !result.summary) {
          return {
            ...b,
            connection_status: 'error' as const,
            ...(result.message
              ? {
                  connection_error_message: result.message,
                  connection_error_kind: result.connection_error_kind
                    ?? classifyBrokerConnectError(result.message),
                }
              : {}),
          }
        }
        return {
          ...b,
          connection_status: 'connected' as const,
          connection_error_kind: null,
          connection_error_message: null,
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
    }
    if (result.message) {
      opts.onError?.(result.message)
    }
  }, [opts])

  const reconnectBroker = useCallback(async (
    brokerId: string,
    options?: { allowPasswordPrompt?: boolean },
  ) => {
    const allowPasswordPrompt = options?.allowPasswordPrompt !== false
    const hasStoredPassword =
      opts.brokers.find(b => b.id === brokerId)?.auto_reconnect_enabled === true
    setReconnectingBrokerIds(prev => new Set(prev).add(brokerId))
    opts.onClearError?.()
    try {
      const { result } = await reconnectWithOptionalPassword(brokerId, {
        allowPasswordPrompt,
        hasStoredPassword,
        requestPassword: opts.requestPassword,
        reconnectFailedLabel: opts.reconnectFailedLabel,
        onError: opts.onError,
      })
      applyReconnectResult(brokerId, result)
      return result
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
