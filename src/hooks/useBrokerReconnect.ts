import { useCallback, useMemo, useRef, useState } from 'react'
import type { BrokerAccount } from '../types/database'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import { brokerCanReconnect } from '../lib/brokerReconnect'
import {
  brokerReconnectBlockedReason,
  BROKER_RECONNECT_MIN_GAP_MS,
  endBrokerReconnect,
  tryBeginBrokerReconnect,
} from '../lib/brokerReconnectCoordinator'
import { classifyBrokerConnectError } from '../lib/brokerConnectError'

export interface BrokerPasswordPromptResult {
  password: string
  rememberPassword: boolean
}

type PasswordRequest = {
  brokerId: string
  resolve: (value: BrokerPasswordPromptResult | null) => void
}

/**
 * Manual FxSocket password reconnect for dropped broker sessions.
 * Opens a password prompt, calls edge `reconnect`, then polls until connected.
 */
export function useBrokerReconnect(opts: {
  brokers: BrokerAccount[]
  upsertBroker: (broker: BrokerAccount) => void
  reconnectFailedLabel: string
  onError?: (message: string) => void
  onSuccess?: (brokerId: string) => void
}) {
  const [reconnectingBrokerIds, setReconnectingBrokerIds] = useState<Set<string>>(() => new Set())
  const [passwordPromptBrokerId, setPasswordPromptBrokerId] = useState<string | null>(null)
  const passwordRequestRef = useRef<PasswordRequest | null>(null)
  const onErrorRef = useRef(opts.onError)
  const onSuccessRef = useRef(opts.onSuccess)
  const upsertBrokerRef = useRef(opts.upsertBroker)
  const reconnectFailedLabelRef = useRef(opts.reconnectFailedLabel)
  onErrorRef.current = opts.onError
  onSuccessRef.current = opts.onSuccess
  upsertBrokerRef.current = opts.upsertBroker
  reconnectFailedLabelRef.current = opts.reconnectFailedLabel

  const brokersNeedingReconnect = useMemo(
    () => opts.brokers.filter(brokerCanReconnect),
    [opts.brokers],
  )

  const passwordPromptBroker = useMemo(
    () => opts.brokers.find(b => b.id === passwordPromptBrokerId) ?? null,
    [opts.brokers, passwordPromptBrokerId],
  )

  const requestPassword = useCallback((brokerId: string) => {
    return new Promise<BrokerPasswordPromptResult | null>((resolve) => {
      if (passwordRequestRef.current) {
        passwordRequestRef.current.resolve(null)
      }
      passwordRequestRef.current = { brokerId, resolve }
      setPasswordPromptBrokerId(brokerId)
    })
  }, [])

  const resolvePasswordPrompt = useCallback((result: BrokerPasswordPromptResult | null) => {
    const pending = passwordRequestRef.current
    passwordRequestRef.current = null
    setPasswordPromptBrokerId(null)
    pending?.resolve(result)
  }, [])

  const cancelPasswordPrompt = useCallback(() => {
    resolvePasswordPrompt(null)
  }, [resolvePasswordPrompt])

  const submitPasswordPrompt = useCallback((payload: BrokerPasswordPromptResult) => {
    resolvePasswordPrompt(payload)
  }, [resolvePasswordPrompt])

  const reconnectBroker = useCallback(async (brokerId: string) => {
    if (!tryBeginBrokerReconnect(brokerId, { bypassGap: true })) {
      const blocked = brokerReconnectBlockedReason(brokerId, { bypassGap: true })
      const message = blocked === 'in_flight'
        ? 'Reconnect already in progress. Please wait a moment and try again.'
        : `Please wait ${Math.ceil(BROKER_RECONNECT_MIN_GAP_MS / 1000)} seconds before retrying.`
      onErrorRef.current?.(message)
      return
    }

    setReconnectingBrokerIds(prev => new Set(prev).add(brokerId))
    try {
      const entered = await requestPassword(brokerId)
      if (!entered?.password.trim()) {
        return
      }

      const { account } = await fxsocketBroker.reconnect({
        accountId: brokerId,
        password: entered.password.trim(),
        provider: opts.brokers.find(b => b.id === brokerId)?.provider as 'fxsocket' | 'mtapi' | undefined,
      })
      upsertBrokerRef.current(account)

      const result = await fxsocketBroker.waitUntilConnected(account.id, {
        provider: opts.brokers.find(b => b.id === brokerId)?.provider as 'fxsocket' | 'mtapi' | undefined,
        onProgress: (progress) => {
          upsertBrokerRef.current(progress.account)
        },
      })
      upsertBrokerRef.current(result.account)
      onSuccessRef.current?.(brokerId)
    } catch (e) {
      const raw = e instanceof Error ? e.message : reconnectFailedLabelRef.current
      void classifyBrokerConnectError(raw, { credentialConnect: true })
      onErrorRef.current?.(raw || reconnectFailedLabelRef.current)
    } finally {
      endBrokerReconnect(brokerId)
      setReconnectingBrokerIds(prev => {
        const next = new Set(prev)
        next.delete(brokerId)
        return next
      })
    }
  }, [requestPassword])

  const isReconnecting = useCallback(
    (brokerId: string) => reconnectingBrokerIds.has(brokerId),
    [reconnectingBrokerIds],
  )

  return {
    reconnectBroker,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting,
    passwordPromptBroker,
    submitPasswordPrompt,
    cancelPasswordPrompt,
  }
}
