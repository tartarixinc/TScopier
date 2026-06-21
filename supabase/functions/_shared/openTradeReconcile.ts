/**
 * Reconcile DB `trades.status = 'open'` against live broker positions.
 * Keep in sync with worker/src/openTradeReconcile.ts and basketSlTpReconcile close path.
 */

// deno-lint-ignore no-explicit-any
type SupabaseLike = any

export type OpenTradeReconcileRow = {
  id: string
  broker_account_id: string | null
  metaapi_order_id: string | null
  signal_id?: string | null
}

export function ingestBrokerTickets(orders: unknown[]): Set<number> {
  const tickets = new Set<number>()
  for (const raw of orders ?? []) {
    if (!raw || typeof raw !== "object") continue
    const o = raw as Record<string, unknown>
    const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
    if (Number.isFinite(ticket) && ticket > 0) tickets.add(ticket)
  }
  return tickets
}

/** Open DB legs whose ticket is valid but absent from the broker snapshot. */
export function findGhostOpenTradeIds(
  openTrades: OpenTradeReconcileRow[],
  brokerTickets: Set<number>,
): string[] {
  const ghostIds: string[] = []
  for (const trade of openTrades) {
    const ticket = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    if (!brokerTickets.has(ticket)) ghostIds.push(trade.id)
  }
  return ghostIds
}

export async function closeStaleOpenTrades(
  supabase: SupabaseLike,
  tradeIds: string[],
): Promise<number> {
  if (!tradeIds.length) return 0

  const { data: targets, error: loadErr } = await supabase
    .from("trades")
    .select("id,signal_id,broker_account_id")
    .in("id", tradeIds)
    .eq("status", "open")
  if (loadErr) return 0

  const rows = (targets ?? []) as Array<{ id: string; signal_id: string; broker_account_id: string }>
  if (!rows.length) return 0

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("trades")
    .update({ status: "closed", closed_at: now })
    .in("id", rows.map(r => r.id))
    .eq("status", "open")
    .select("id")
  if (error) return 0

  const closed = (data ?? []).length
  if (closed > 0) {
    const baskets = new Map<string, { signalId: string; brokerAccountId: string }>()
    for (const r of rows) {
      if (!r.signal_id || !r.broker_account_id) continue
      baskets.set(`${r.signal_id}|${r.broker_account_id}`, {
        signalId: r.signal_id,
        brokerAccountId: r.broker_account_id,
      })
    }
    for (const { signalId, brokerAccountId } of baskets.values()) {
      await supabase
        .from("range_pending_legs")
        .update({ status: "cancelled", error_message: "basket_flat" })
        .eq("signal_id", signalId)
        .eq("broker_account_id", brokerAccountId)
        .in("status", ["pending", "claimed"])
    }
  }
  return closed
}

export async function reconcileOpenTradesForBroker(
  supabase: SupabaseLike,
  userId: string,
  brokerAccountId: string,
  brokerTickets: Set<number>,
): Promise<number> {
  const { data, error } = await supabase
    .from("trades")
    .select("id,broker_account_id,metaapi_order_id,signal_id")
    .eq("user_id", userId)
    .eq("broker_account_id", brokerAccountId)
    .eq("status", "open")
    .limit(500)
  if (error || !data?.length) return 0

  const ghostIds = findGhostOpenTradeIds(data as OpenTradeReconcileRow[], brokerTickets)
  if (!ghostIds.length) return 0
  return closeStaleOpenTrades(supabase, ghostIds)
}
