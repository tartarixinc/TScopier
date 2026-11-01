import type { SupabaseClient } from '@supabase/supabase-js'
import { writeExecutionLog } from '../observability/executionLog'
/**
 * A claim is a short lease, not a permanent lock. If the worker that took it
 * crashes before releasing it, a later dispatch must be able to take over after
 * this window instead of leaving the signal stuck in `parsed`.
 */
export const SIGNAL_DISPATCH_CLAIM_LEASE_MS = Math.max(
  30_000,
  Number(process.env.SIGNAL_DISPATCH_CLAIM_LEASE_MS ?? 120_000) || 120_000,
)

export function claimIsStale(
  createdAt: string | null | undefined,
  nowMs: number = Date.now(),
  leaseMs: number = SIGNAL_DISPATCH_CLAIM_LEASE_MS,
): boolean {
  if (!createdAt) return false
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return false
  return nowMs - created >= leaseMs
}

async function deleteStaleClaim(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('signal_broker_dispatch_claims')
    .select('created_at')
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .maybeSingle()
  if (error || !data) return false
  const createdAt = (data as { created_at?: string }).created_at
  if (!createdAt || !claimIsStale(createdAt)) return false
  const { data: deleted, error: deleteError } = await supabase
    .from('signal_broker_dispatch_claims')
    .delete()
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
    .eq('created_at', createdAt)
    .select('id')
  if (deleteError) {
    console.warn(
      `[tradeExecutor] stale dispatch claim cleanup failed signal=${signalId} broker=${brokerAccountId}: ${deleteError.message}`,
    )
    return false
  }
  // The owner may have renewed between the read and the delete. In that case
  // the guarded delete removes nothing; report that no takeover happened.
  if ((deleted?.length ?? 0) === 0) return false
  console.warn(
    `[tradeExecutor] took over stale dispatch claim signal=${signalId} broker=${brokerAccountId}`
    + ` age_ms=${Date.now() - Date.parse(createdAt)}`,
  )
  return true
}

/** Delete a claim only when its lease has expired. Never removes a live claim. */
export async function releaseSignalBrokerDispatchClaimIfStale(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<boolean> {
  return await deleteStaleClaim(supabase, signalId, brokerAccountId)
}

/**
 * Extend the lease while a send is still running. A long OrderSend must not be
 * mistaken for a crashed worker: the claim stays fresh as long as the sender
 * keeps renewing it.
 */
export async function renewSignalBrokerDispatchClaim(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from('signal_broker_dispatch_claims')
    .update({ created_at: new Date().toISOString() })
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
  if (error) {
    console.warn(
      `[tradeExecutor] dispatch claim renew failed signal=${signalId} broker=${brokerAccountId}: ${error.message}`,
    )
    return false
  }
  return true
}

export function isDuplicateKeyError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '23505') return true
  const msg = (error.message ?? '').toLowerCase()
  return msg.includes('duplicate key') || msg.includes('unique constraint')
}

/**
 * Claim exclusive entry dispatch for signal+broker before OrderSend.
 * Returns false when another worker already claimed the dispatch or when the
 * database cannot confirm that this worker owns the claim. An uncertain claim
 * must never be treated as permission to place a broker order.
 */
export async function claimSignalBrokerDispatch(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
  userId?: string | null,
): Promise<boolean> {
  const insertClaim = () => supabase.from('signal_broker_dispatch_claims').insert({
    signal_id: signalId,
    broker_account_id: brokerAccountId,
  })
  let { error } = await insertClaim()
  if (!error) return true
  if (isDuplicateKeyError(error)) {
    // A crashed worker can leave a claim behind. Take it over only after the
    // lease expires; a fresh claim still belongs to another dispatcher.
    if (!(await deleteStaleClaim(supabase, signalId, brokerAccountId))) return false
    const retry = await insertClaim()
    error = retry.error
    if (!error) return true
    if (isDuplicateKeyError(error)) return false
  }
  console.warn(
    `[tradeExecutor] signal_broker_dispatch_claim insert failed signal=${signalId} broker=${brokerAccountId}: ${error.message}`,
  )
  if (!userId) {
    return false
  }
  await writeExecutionLog(supabase, {
    user_id: userId,
    signal_id: signalId,
    broker_account_id: brokerAccountId,
    action: 'dispatch_claim_error',
    status: 'failed',
    error_message: error.message,
    request_payload: {
      signal_id: signalId,
      broker_account_id: brokerAccountId,
      fail_closed: true,
    } as unknown as Record<string, unknown>,
  })
  return false
}

/** Release a prior claim so range-wake or retry can dispatch orders. */
export async function releaseSignalBrokerDispatchClaim(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
): Promise<void> {
  const { error } = await supabase
    .from('signal_broker_dispatch_claims')
    .delete()
    .eq('signal_id', signalId)
    .eq('broker_account_id', brokerAccountId)
  if (error) {
    console.warn(
      `[tradeExecutor] signal_broker_dispatch_claim release failed signal=${signalId} broker=${brokerAccountId}: ${error.message}`,
    )
  }
}

/**
 * Safety gate for a message revision taking over a stale dispatch claim:
 * only safe when the revision has not materialized anything AND the original
 * dispatch is no longer executing in this worker. A skipped first dispatch
 * (e.g. `signal_entry_range_requires_price`) must not permanently block the
 * edited signal from executing.
 */
export function shouldTakeOverStaleClaim(args: {
  isRevisionRefresh: boolean
  materialized: boolean
  entryInFlight: boolean
}): boolean {
  return args.isRevisionRefresh === true
    && args.materialized === false
    && args.entryInFlight === false
}
