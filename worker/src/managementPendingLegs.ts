/**
 * Apply channel / basket management instructions to virtual range_pending_legs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { breakevenStopLossForSymbol } from './autoManagement'
import { takeProfitForLegIndex } from './manualPlanning/tpBucketDistribution'
import { type ManualTpLot } from './manualPlanning/types'
import type { MgmtParsedLike, MgmtTradeRow } from './managementScope'

export type PendingLegCancelScope = {
  signalId: string
  brokerAccountId: string
  symbol: string
}

export type RangePendingMgmtRow = {
  id: string
  signal_id: string
  broker_account_id: string
  symbol: string
  step_idx: number
  is_buy: boolean
  anchor_price: number
  stoploss: number | null
  takeprofit: number | null
  cwe_close_price: number | null
  status: string
}

function sanitizeLevel(v: number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function pendingLegsToCancelScopes(legs: RangePendingMgmtRow[]): PendingLegCancelScope[] {
  const uniq = new Map<string, PendingLegCancelScope>()
  for (const leg of legs) {
    const key = `${leg.signal_id}|${leg.broker_account_id}|${leg.symbol}`
    uniq.set(key, {
      signalId: leg.signal_id,
      brokerAccountId: leg.broker_account_id,
      symbol: leg.symbol,
    })
  }
  return [...uniq.values()]
}

export async function loadRangePendingLegsInMgmtScope(
  supabase: SupabaseClient,
  args: {
    userId: string
    brokerAccountIds: string[]
    channelId?: string | null
    basketSignalId?: string | null
    symbolFilter?: string | null
  },
): Promise<RangePendingMgmtRow[]> {
  const { userId, brokerAccountIds, channelId, basketSignalId, symbolFilter } = args
  if (!brokerAccountIds.length) return []

  let signalIds: string[] | null = null
  if (basketSignalId) {
    signalIds = [basketSignalId]
  } else if (channelId) {
    const { data: sigs } = await supabase
      .from('signals')
      .select('id')
      .eq('user_id', userId)
      .eq('channel_id', channelId)
      .limit(5000)
    signalIds = (sigs ?? []).map((r: { id: string }) => r.id)
    if (!signalIds.length) return []
  }

  let query = supabase
    .from('range_pending_legs')
    .select(
      'id,signal_id,broker_account_id,symbol,step_idx,is_buy,anchor_price,stoploss,takeprofit,cwe_close_price,status',
    )
    .eq('user_id', userId)
    .in('broker_account_id', brokerAccountIds)
    .in('status', ['pending', 'claimed'])
    .limit(500)

  if (signalIds) {
    query = query.in('signal_id', signalIds)
  }

  const { data, error } = await query
  if (error) {
    console.warn(`[managementPendingLegs] load failed: ${error.message}`)
    return []
  }

  let legs = (data ?? []) as RangePendingMgmtRow[]
  if (symbolFilter?.trim()) {
    legs = legs.filter(l => symbolsCompatibleForBasket(symbolFilter, l.symbol))
  }
  return legs
}

export async function updateRangePendingLegsForManagement(args: {
  supabase: SupabaseClient
  parsed: MgmtParsedLike
  pendingLegs: RangePendingMgmtRow[]
  openTrades: MgmtTradeRow[]
  tpLotsByBroker: Map<string, ManualTpLot[] | null | undefined>
  breakevenManualByBroker: Map<string, { breakeven_offset_pips?: number }>
  action: string
  hasNewSl: boolean
  hasNewTp: boolean
  parsedTpLevels: number[]
}): Promise<number> {
  const {
    supabase,
    parsed,
    pendingLegs,
    openTrades,
    tpLotsByBroker,
    breakevenManualByBroker,
    action,
    hasNewSl,
    hasNewTp,
    parsedTpLevels,
  } = args
  if (!pendingLegs.length) return 0

  const act = action.toLowerCase()
  if (act !== 'modify' && act !== 'breakeven' && act !== 'partial_breakeven') return 0

  const openByBasket = new Map<string, MgmtTradeRow[]>()
  for (const tr of openTrades) {
    const key = `${tr.signal_id}|${tr.broker_account_id}`
    const list = openByBasket.get(key) ?? []
    list.push(tr)
    openByBasket.set(key, list)
  }

  let updated = 0
  for (const leg of pendingLegs) {
    const basketKey = `${leg.signal_id}|${leg.broker_account_id}`
    const brokerOpen = openByBasket.get(basketKey) ?? []
    const openLegCount = Math.max(brokerOpen.length, leg.step_idx + 1)
    const tpLots = tpLotsByBroker.get(leg.broker_account_id)

    let stoploss = leg.stoploss
    let takeprofit = leg.takeprofit

    if (act === 'breakeven' || act === 'partial_breakeven') {
      const anchor = sanitizeLevel(leg.anchor_price)
      if (anchor > 0) {
        const manual = breakevenManualByBroker.get(leg.broker_account_id) ?? {}
        stoploss = breakevenStopLossForSymbol({
          isBuy: leg.is_buy,
          entryPrice: anchor,
          manual,
          symbol: leg.symbol,
        })
      }
    } else if (act === 'modify') {
      if (hasNewSl) stoploss = parsed.sl as number
      if (hasNewTp && leg.cwe_close_price == null) {
        const distributed = takeProfitForLegIndex({
          legIndex: leg.step_idx,
          openLegCount,
          finalTps: parsedTpLevels,
          tpLots,
        })
        takeprofit = distributed > 0 ? distributed : parsedTpLevels[parsedTpLevels.length - 1] ?? leg.takeprofit
      }
    }

    const patch: Record<string, unknown> = {
      stoploss,
      takeprofit: leg.cwe_close_price != null ? null : takeprofit,
    }

    const { error } = await supabase
      .from('range_pending_legs')
      .update(patch)
      .eq('id', leg.id)
      .in('status', ['pending', 'claimed'])

    if (!error) updated++
  }

  return updated
}
