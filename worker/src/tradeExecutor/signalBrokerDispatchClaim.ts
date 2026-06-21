import type { SupabaseClient } from '@supabase/supabase-js'

function isDuplicateKeyError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === '23505') return true
  const msg = (error.message ?? '').toLowerCase()
  return msg.includes('duplicate key') || msg.includes('unique constraint')
}

/**
 * Claim exclusive entry dispatch for signal+broker before OrderSend.
 * Returns false when another worker already claimed or materialized the dispatch.
 */
export async function claimSignalBrokerDispatch(
  supabase: SupabaseClient,
  signalId: string,
  brokerAccountId: string,
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
  return true
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
