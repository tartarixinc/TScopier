import type { SupabaseClient } from '@supabase/supabase-js'
import { writeExecutionLog } from '../observability/executionLog'
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
  const { error } = await supabase.from('signal_broker_dispatch_claims').insert({
    signal_id: signalId,
    broker_account_id: brokerAccountId,
  })
  if (!error) return true
  if (isDuplicateKeyError(error)) return false
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
