import type { SupabaseClient } from '@supabase/supabase-js'
import { loadOpenTradesForManagement } from './managementScope'
import { getMetatraderApi, hasMetatraderApiConfigured, mtPlatformFrom } from './metatraderapi'
import { deleteRangePendingLegsForBasket } from './rangePendingLegDelete'
import {
  cancelSignalEntryRowAtBroker,
  type SignalEntryPendingRow,
} from './signalEntryPendingHelpers'

export type CopyLimitFlattenResult = {
  closed: number
  failed: number
  pendingCancelled: number
  virtualLegsDeleted: number
}

async function closeBrokerTicket(
  api: NonNullable<ReturnType<typeof getMetatraderApi>>,
  uuid: string,
  ticket: number,
): Promise<boolean> {
  if (!Number.isFinite(ticket) || ticket <= 0) return false
  try {
    const result = await api.orderClose(uuid, { ticket, slippage: 50 })
    if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) return false
    return true
  } catch {
    return false
  }
}

export async function flattenChannelTradesForCopyLimit(args: {
  supabase: SupabaseClient
  userId: string
  brokerAccountId: string
  metaapiAccountId: string
  platform: string
  channelId: string
  reason: string
}): Promise<CopyLimitFlattenResult> {
  const result: CopyLimitFlattenResult = {
    closed: 0,
    failed: 0,
    pendingCancelled: 0,
    virtualLegsDeleted: 0,
  }

  if (!hasMetatraderApiConfigured()) return result

  const api = getMetatraderApi(mtPlatformFrom(args.platform))
  if (!api || !args.metaapiAccountId || args.metaapiAccountId.includes('|')) return result

  const trades = await loadOpenTradesForManagement(args.supabase, {
    userId: args.userId,
    channelId: args.channelId,
    brokerAccountIds: [args.brokerAccountId],
  })

  const now = new Date().toISOString()
  const basketScopes = new Map<string, { signalId: string; brokerAccountId: string }>()

  for (const trade of trades) {
    basketScopes.set(`${trade.signal_id}|${trade.broker_account_id}`, {
      signalId: trade.signal_id,
      brokerAccountId: trade.broker_account_id,
    })

    const ticket = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue

    const ok = await closeBrokerTicket(api, args.metaapiAccountId, ticket)
    if (!ok) {
      result.failed += 1
      continue
    }

    result.closed += 1
    const terminalStatus = trade.status === 'pending' ? 'cancelled' : 'closed'
    await args.supabase
      .from('trades')
      .update({ status: terminalStatus, closed_at: now })
      .eq('id', trade.id)
      .in('status', ['open', 'pending'])
  }

  const { data: channelSignals } = await args.supabase
    .from('signals')
    .select('id')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .limit(5000)
  const signalIds = (channelSignals ?? []).map((r: { id: string }) => r.id)

  if (signalIds.length) {
    const { data: seRows } = await args.supabase
      .from('signal_entry_pending_orders')
      .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,trade_id,broker_ticket,is_buy')
      .in('signal_id', signalIds)
      .eq('broker_account_id', args.brokerAccountId)
      .eq('status', 'broker_pending')

    for (const row of (seRows ?? []) as SignalEntryPendingRow[]) {
      const cancelled = await cancelSignalEntryRowAtBroker(
        args.supabase,
        api,
        row,
        args.reason,
      )
      if (cancelled.ok) result.pendingCancelled += 1
    }

    const { data: virtualLegs } = await args.supabase
      .from('range_pending_legs')
      .select('signal_id,broker_account_id')
      .in('signal_id', signalIds)
      .eq('broker_account_id', args.brokerAccountId)
      .in('status', ['pending', 'claimed'])

    for (const leg of virtualLegs ?? []) {
      const signalId = String((leg as { signal_id: string }).signal_id)
      basketScopes.set(`${signalId}|${args.brokerAccountId}`, {
        signalId,
        brokerAccountId: args.brokerAccountId,
      })
    }
  }

  for (const scope of basketScopes.values()) {
    result.virtualLegsDeleted += await deleteRangePendingLegsForBasket(
      args.supabase,
      scope,
      args.reason,
    )
  }

  console.log(
    `[copyLimitFlatten] broker=${args.brokerAccountId} channel=${args.channelId}`
    + ` closed=${result.closed} failed=${result.failed}`
    + ` pending_cancelled=${result.pendingCancelled} virtual_deleted=${result.virtualLegsDeleted}`
    + ` reason=${args.reason}`,
  )

  return result
}
