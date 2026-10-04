import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerProviderName } from './brokerProvider'

export type BrokerWriteAuthority = {
  brokerAccountId: string
  provider: BrokerProviderName
  sessionId: string
  writerEpoch: number
  transitionState: 'stable' | 'transition'
}

export type BrokerWriteLease = { id: string; writerEpoch: number }

export interface BrokerWriteAuthorityStore {
  acquire(authority: BrokerWriteAuthority, operation: string): Promise<BrokerWriteLease>
  renew(leaseId: string): Promise<boolean>
  release(leaseId: string): Promise<void>
}

const LEASE_TTL_SECONDS = Math.max(
  30,
  Math.min(300, Number(process.env.BROKER_WRITE_LEASE_TTL_SECONDS ?? 120)),
)
const LEASE_RENEW_MS = Math.max(
  10_000,
  Math.min(60_000, Number(process.env.BROKER_WRITE_LEASE_RENEW_MS ?? 30_000)),
)

let authorityStore: BrokerWriteAuthorityStore | null = null

function safeRejectLog(authority: BrokerWriteAuthority, operation: string, reason: string): void {
  console.warn(JSON.stringify({
    event: 'broker_stale_write_rejected',
    broker_account_id: authority.brokerAccountId,
    expected_provider: authority.provider,
    writer_epoch: authority.writerEpoch,
    operation,
    reason,
  }))
}

export function registerBrokerWriteAuthorityStore(store: BrokerWriteAuthorityStore): void {
  authorityStore = store
}
export function brokerWriteAuthorityStoreRegistered(): boolean {
  return authorityStore != null
}


export function resetBrokerWriteAuthorityStoreForTests(): void {
  authorityStore = null
}

export function createSupabaseBrokerWriteAuthorityStore(
  supabase: SupabaseClient,
): BrokerWriteAuthorityStore {
  return {
    async acquire(authority, operation) {
      const { data, error } = await supabase.rpc('acquire_broker_write_lease', {
        p_broker_account_id: authority.brokerAccountId,
        p_expected_provider: authority.provider,
        p_expected_session_id: authority.sessionId,
        p_expected_writer_epoch: authority.writerEpoch,
        p_operation: operation,
        p_ttl_seconds: LEASE_TTL_SECONDS,
      })
      if (error) throw new Error('BROKER_WRITE_FENCE_REJECTED')
      const row = Array.isArray(data) ? data[0] : data
      const id = String((row as { lease_id?: unknown } | null)?.lease_id ?? '').trim()
      const epoch = Number((row as { writer_epoch?: unknown } | null)?.writer_epoch)
      if (!id || !Number.isSafeInteger(epoch) || epoch !== authority.writerEpoch) {
        throw new Error('BROKER_WRITE_FENCE_REJECTED')
      }
      return { id, writerEpoch: epoch }
    },
    async renew(leaseId) {
      const { data, error } = await supabase.rpc('renew_broker_write_lease', {
        p_lease_id: leaseId,
        p_ttl_seconds: LEASE_TTL_SECONDS,
      })
      return !error && data === true
    },
    async release(leaseId) {
      const { error } = await supabase.rpc('release_broker_write_lease', {
        p_lease_id: leaseId,
      })
      if (error) console.warn(JSON.stringify({ event: 'broker_write_lease_release_failed' }))
    },
  }
}

export async function withBrokerWriteAuthority<T>(
  authority: BrokerWriteAuthority | null | undefined,
  operation: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const store = authorityStore
  // Tests and isolated library consumers do not register a database store.
  // Production worker startup always does; once registered, missing metadata
  // is a hard failure rather than an unfenced write.
  if (!store) return mutate()
  if (!authority) throw new Error('BROKER_WRITE_AUTHORITY_REQUIRED')
  if (
    !authority.brokerAccountId
    || !authority.sessionId
    || !Number.isSafeInteger(authority.writerEpoch)
    || authority.writerEpoch < 1
    || authority.transitionState !== 'stable'
  ) {
    safeRejectLog(authority, operation, 'invalid_snapshot')
    throw new Error('BROKER_WRITE_FENCE_REJECTED')
  }

  let lease: BrokerWriteLease
  try {
    lease = await store.acquire(authority, operation)
  } catch {
    safeRejectLog(authority, operation, 'authority_changed')
    throw new Error('BROKER_WRITE_FENCE_REJECTED')
  }

  let leaseValid = true
  let renewalRunning = false
  const timer = setInterval(() => {
    if (renewalRunning || !leaseValid) return
    renewalRunning = true
    void store.renew(lease.id)
      .then(ok => { if (!ok) leaseValid = false })
      .catch(() => { leaseValid = false })
      .finally(() => { renewalRunning = false })
  }, LEASE_RENEW_MS)
  timer.unref?.()

  try {
    const result = await mutate()
    if (!leaseValid) throw new Error('BROKER_WRITE_LEASE_LOST')
    return result
  } finally {
    clearInterval(timer)
    await store.release(lease.id).catch(() => undefined)
  }
}

export function authorityFromBrokerRow(row: {
  id?: string | null
  provider?: string | null
  mtapi_session_id?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  writer_epoch?: number | null
  provider_transition_state?: string | null
}): BrokerWriteAuthority | null {
  const provider = row.provider == null || row.provider === '' ? 'fxsocket' : row.provider
  if (provider !== 'fxsocket' && provider !== 'mtapi') return null
  const sessionId = provider === 'mtapi'
    ? String(row.mtapi_session_id ?? '').trim()
    : String(row.fxsocket_account_id ?? row.metaapi_account_id ?? '').trim()
  const brokerAccountId = String(row.id ?? '').trim()
  const writerEpoch = Number(row.writer_epoch)
  const transitionState = row.provider_transition_state ?? 'stable'
  if (
    !brokerAccountId
    || !sessionId
    || sessionId.includes('|')
    || !Number.isSafeInteger(writerEpoch)
    || writerEpoch < 1
    || (transitionState !== 'stable' && transitionState !== 'transition')
  ) return null
  return {
    brokerAccountId,
    provider,
    sessionId,
    writerEpoch,
    transitionState,
  }
}
