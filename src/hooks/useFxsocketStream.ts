import { useEffect, useMemo, useRef } from 'react'
import { openFxsocketStream, type FxsocketStreamMessage } from '../lib/fxsocketStream'
import {
  parseFxsocketAccountStreamData,
  parseFxsocketPositionsStreamData,
  type FxsocketAccountStreamSnapshot,
  type FxsocketPositionsStreamSnapshot,
} from '../lib/fxsocketStreamParse'
import { isFxsocketLinkedBroker } from '../lib/brokerLink'
import type { BrokerAccount } from '../types/database'

export interface FxsocketStreamHandlers {
  onAccount?: (brokerAccountId: string, data: FxsocketAccountStreamSnapshot) => void
  onPositions?: (
    brokerAccountId: string,
    snapshot: FxsocketPositionsStreamSnapshot,
    rawData: unknown,
  ) => void
  onTerminal?: (brokerAccountId: string, data: Record<string, unknown>) => void
  onTrade?: (brokerAccountId: string, data: Record<string, unknown>) => void
}

/** Stable key from linked broker row ids only — balance patches must not reconnect streams. */
export function fxsocketStreamBrokerIdsKey(brokers: BrokerAccount[]): string {
  return brokers
    .filter(isFxsocketLinkedBroker)
    .map(b => b.id)
    .sort()
    .join(',')
}

export function useFxsocketStream(
  brokers: BrokerAccount[],
  handlers: FxsocketStreamHandlers,
  enabled = true,
): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const brokerIdsKey = useMemo(
    () => fxsocketStreamBrokerIdsKey(brokers),
    [brokers.map(b => b.id).sort().join(',')],
  )

  useEffect(() => {
    if (!enabled || !brokerIdsKey) return

    const brokerIds = brokerIdsKey.split(',').filter(Boolean)
    if (brokerIds.length === 0) return

    const handles = new Map<string, { close: () => void }>()
    let cancelled = false

    for (const brokerId of brokerIds) {
      void openFxsocketStream(brokerId, {
        onMessage: (msg: FxsocketStreamMessage) => {
          if (msg.type === 'account' && 'data' in msg) {
            const snap = parseFxsocketAccountStreamData(msg.data as Record<string, unknown>)
            handlersRef.current.onAccount?.(brokerId, snap)
          } else if (msg.type === 'positions' && 'data' in msg) {
            handlersRef.current.onPositions?.(
              brokerId,
              parseFxsocketPositionsStreamData(msg.data),
              msg.data,
            )
          } else if (msg.type === 'terminal' && 'data' in msg) {
            handlersRef.current.onTerminal?.(brokerId, msg.data as Record<string, unknown>)
          } else if (msg.type === 'trade' && 'data' in msg) {
            const data = msg.data as Record<string, unknown>
            handlersRef.current.onTrade?.(brokerId, data)
          }
        },
      }).then(handle => {
        if (cancelled) {
          handle.close()
          return
        }
        handles.set(brokerId, handle)
      }).catch(() => {
        /* stream setup failed — dashboard falls back to cached values */
      })
    }

    return () => {
      cancelled = true
      for (const handle of handles.values()) handle.close()
    }
  }, [brokerIdsKey, enabled])
}
