import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSourcePosition } from './copyShared/copyHelpers'

/**
 * Persist the provider's live MT position into `trades` so Social Trading /
 * Copier Logs can show manual broker opens (not only channel signals).
 * Mirrors the edge social-copy-reconcile upsert.
 */
export async function upsertSocialCopySourceTrade(
  supabase: SupabaseClient,
  input: {
    traderUserId: string
    brokerAccountId: string
    position: NormalizedSourcePosition
  },
): Promise<void> {
  const ticket = input.position.ticket
  const { data: existing } = await supabase
    .from('trades')
    .select('id,status')
    .eq('broker_account_id', input.brokerAccountId)
    .eq('metaapi_order_id', ticket)
    .maybeSingle()
  if (existing?.id) {
    if (String(existing.status).toLowerCase() !== 'open') {
      await supabase.from('trades').update({
        status: 'open',
        closed_at: null,
        symbol: input.position.symbol,
        direction: input.position.side,
        lot_size: input.position.volume,
        sl: input.position.stopLoss,
        tp: input.position.takeProfit,
        broker_position_ticket: ticket,
      }).eq('id', existing.id)
    } else {
      await supabase.from('trades').update({
        symbol: input.position.symbol,
        direction: input.position.side,
        lot_size: input.position.volume,
        sl: input.position.stopLoss,
        tp: input.position.takeProfit,
        broker_position_ticket: ticket,
      }).eq('id', existing.id)
    }
    return
  }
  const { error } = await supabase.from('trades').insert({
    user_id: input.traderUserId,
    broker_account_id: input.brokerAccountId,
    signal_id: null,
    metaapi_order_id: ticket,
    broker_position_ticket: ticket,
    symbol: input.position.symbol,
    direction: input.position.side,
    lot_size: input.position.volume,
    status: 'open',
    opened_at: new Date().toISOString(),
    sl: input.position.stopLoss,
    tp: input.position.takeProfit,
  })
  if (error && !String(error.message).toLowerCase().includes('duplicate')) {
    console.warn('[social-copy] source trade upsert failed', error.message)
  }
}

export async function closeSocialCopySourceTrade(
  supabase: SupabaseClient,
  brokerAccountId: string,
  sourceTicket: string,
): Promise<void> {
  const { error } = await supabase.from('trades').update({
    status: 'closed',
    closed_at: new Date().toISOString(),
  }).eq('broker_account_id', brokerAccountId).eq('metaapi_order_id', sourceTicket).eq('status', 'open')
  if (error) {
    console.warn('[social-copy] source trade close failed', error.message)
  }
}
