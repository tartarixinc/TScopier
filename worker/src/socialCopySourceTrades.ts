import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSourcePosition } from './copyShared/copyHelpers'

/**
 * Persist the provider's live MT position into `trades` so Social Trading /
 * Copier Logs can show manual broker opens (not only channel signals).
 * Mirrors the edge social-copy-reconcile upsert.
 */
/** Attach an alternate OpenedOrders ticket to an existing open trade instead of
 * inserting a null-signal orphan (order vs position twin rows). */
const NEAR_DUPLICATE_ATTACH_WINDOW_MS = 120_000

export async function upsertSocialCopySourceTrade(
  supabase: SupabaseClient,
  input: {
    traderUserId: string
    brokerAccountId: string
    position: NormalizedSourcePosition
  },
): Promise<void> {
  const ticket = input.position.ticket
  const { data: byOrder } = await supabase
    .from('trades')
    .select('id,status')
    .eq('broker_account_id', input.brokerAccountId)
    .eq('metaapi_order_id', ticket)
    .maybeSingle()
  const { data: byPosition } = byOrder?.id
    ? { data: null }
    : await supabase
      .from('trades')
      .select('id,status')
      .eq('broker_account_id', input.brokerAccountId)
      .eq('broker_position_ticket', ticket)
      .maybeSingle()
  const existing = byOrder?.id ? byOrder : byPosition
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

  // Twin ticket for a channel-managed fill: attach rather than insert a
  // signal_id=null orphan that CLOSE ALL will not see.
  const openedAfterMs = Date.now() - NEAR_DUPLICATE_ATTACH_WINDOW_MS
  const { data: nearDupes } = await supabase
    .from('trades')
    .select('id,signal_id,lot_size,direction,opened_at')
    .eq('broker_account_id', input.brokerAccountId)
    .eq('status', 'open')
    .eq('symbol', input.position.symbol)
    .order('opened_at', { ascending: false })
    .limit(20)
  const ranked = (nearDupes ?? [])
    .filter(row => {
      const openedAt = row.opened_at ? Date.parse(String(row.opened_at)) : NaN
      if (!Number.isFinite(openedAt) || openedAt < openedAfterMs) return false
      const direction = String(row.direction ?? '').toLowerCase()
      if (direction && !direction.includes(input.position.side)) return false
      const lots = Number(row.lot_size)
      if (Number.isFinite(lots) && Math.abs(lots - input.position.volume) > 1e-8) return false
      return true
    })
    .sort((left, right) => {
      // Prefer channel-managed rows so we attach the twin ticket there instead of
      // creating a parallel null-signal orphan beside them.
      const leftSignal = left.signal_id ? 1 : 0
      const rightSignal = right.signal_id ? 1 : 0
      return rightSignal - leftSignal
    })
  const twin = ranked[0]
  if (twin?.id) {
    await supabase.from('trades').update({
      broker_position_ticket: ticket,
      sl: input.position.stopLoss,
      tp: input.position.takeProfit,
      lot_size: input.position.volume,
    }).eq('id', twin.id)
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
