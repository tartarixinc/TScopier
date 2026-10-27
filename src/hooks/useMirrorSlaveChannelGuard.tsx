import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { MirrorSlaveChannelGuardModal, type MirrorSlaveGuardMaster } from '../components/dashboard/MirrorSlaveChannelGuardModal'
import { useAuth } from '../context/AuthContext'
import { getBrokerDisplayLabel } from '../lib/brokerChannelLink'
import {
  disconnectBrokerCopyLinkSafely,
  fetchBrokerCopyDestinationLinks,
  humanizeMirrorDeleteError,
  type BrokerCopyLinkRow,
} from '../lib/brokerCopyLink'
import { supabase } from '../lib/supabase'
import type { BrokerAccount } from '../types/database'

interface GuardRequest {
  broker: BrokerAccount
  links: BrokerCopyLinkRow[]
  masters: MirrorSlaveGuardMaster[]
}

type MirrorSlaveGuardOptions = {
  /** Called after mirror links were removed from inside the guard modal. */
  onMirrorLinksRemoved?: () => void
}

/**
 * Blocks linking a broker to a Telegram channel while the broker is a
 * mirror-trading slave. `guardBroker` resolves true when the caller may
 * proceed (the broker is not a slave, the user chose Proceed, or the user
 * disconnected the mirror links). Only one request is shown at a time; a
 * second call cancels the first by resolving it with false.
 */
export function useMirrorSlaveChannelGuard(options: MirrorSlaveGuardOptions = {}) {
  const { onMirrorLinksRemoved } = options
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [request, setRequest] = useState<GuardRequest | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [guardError, setGuardError] = useState<string | null>(null)
  const resolverRef = useRef<((proceed: boolean) => void) | null>(null)

  // A caller awaiting a superseded or unmounted request must not hang forever.
  useEffect(() => () => {
    resolverRef.current?.(false)
    resolverRef.current = null
  }, [])

  const settle = useCallback((proceed: boolean) => {
    resolverRef.current?.(proceed)
    resolverRef.current = null
    setRequest(null)
    setGuardError(null)
    setDisconnecting(false)
  }, [])

  const guardBroker = useCallback((broker: BrokerAccount): Promise<boolean> => {
    if (!userId) return Promise.resolve(true)
    return (async () => {
      const { links, error } = await fetchBrokerCopyDestinationLinks(supabase, userId, broker.id)
      // A read failure must not block the normal connect flow.
      if (error || links.length === 0) return true
      const masterIds = [...new Set(links.map(link => link.source_broker_account_id))]
      let masters: MirrorSlaveGuardMaster[] = masterIds.map(id => ({ id, label: id }))
      const { data: masterRows } = await supabase
        .from('broker_accounts')
        .select('id,label,broker_name,account_login')
        .eq('user_id', userId)
        .in('id', masterIds)
      if (masterRows) {
        const byId = new Map<string, BrokerAccount>(
          (masterRows as Pick<BrokerAccount, 'id' | 'label' | 'broker_name' | 'account_login'>[])
            .map(row => [row.id, row as BrokerAccount]),
        )
        masters = masterIds.map(id => {
          const master = byId.get(id)
          return master
            ? { id, label: getBrokerDisplayLabel(master) }
            : { id, label: id }
        })
      }
      return new Promise<boolean>(resolve => {
        // Single-flight: an overlapping call cancels the pending one.
        resolverRef.current?.(false)
        resolverRef.current = resolve
        setGuardError(null)
        setDisconnecting(false)
        setRequest({ broker, links, masters })
      })
    })()
  }, [userId])

  const disconnectMirror = useCallback(async () => {
    if (!userId || !request || disconnecting) return
    setDisconnecting(true)
    setGuardError(null)
    for (const link of request.links) {
      const result = await disconnectBrokerCopyLinkSafely(supabase, userId, link)
      if (result.error) {
        setGuardError(humanizeMirrorDeleteError(result.error))
        setDisconnecting(false)
        return
      }
    }
    onMirrorLinksRemoved?.()
    settle(true)
  }, [disconnecting, onMirrorLinksRemoved, request, settle, userId])

  const modal: ReactNode = request ? (
    <MirrorSlaveChannelGuardModal
      brokerLabel={getBrokerDisplayLabel(request.broker)}
      masters={request.masters}
      disconnecting={disconnecting}
      error={guardError}
      onProceed={() => settle(true)}
      onDisconnectMirror={() => void disconnectMirror()}
      onCancel={() => settle(false)}
    />
  ) : null

  return { guardBroker, modal }
}
