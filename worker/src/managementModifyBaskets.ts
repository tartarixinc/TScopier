/**
 * Apply channel management "modify" (Adjust SL/TP) across multi-leg baskets with
 * per-leg broker validation, clamping, and reconcile retries for missed legs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MetatraderApiClient } from './metatraderapi'
import { normalizeSymbolParams } from './metatraderapi'
import {
  fetchOpenBrokerTickets,
  markBasketReconcileDoneForAnchor,
  runBasketLegModifies,
  upsertBasketReconcileJob,
  type BasketOpenLeg,
  type BasketSymbolParams,
} from './basketSlTpReconcile'
import { takeProfitForLegIndex } from './manualPlanning/tpBucketDistribution'
import type { ManualSettings, ManualTpLot } from './manualPlanning/types'
import type { MgmtTradeRow } from './managementScope'
import {
  isChannelManagementBlocked,
  normalizeChannelMessageFiltersMap,
} from './channelMessageFilters'
import type { PerLegStopTarget } from './multiTradeMerge'

function sanitizeLevel(v: number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function mgmtRowToBasketLeg(row: MgmtTradeRow): BasketOpenLeg {
  return {
    id: row.id,
    signal_id: row.signal_id,
    metaapi_order_id: row.metaapi_order_id,
    opened_at: row.opened_at ?? '',
    lot_size: row.lot_size,
    sl: row.sl,
    tp: row.tp,
    entry_price: row.entry_price,
    direction: row.direction,
    symbol: row.symbol,
  }
}

function inferBasketDirection(rows: MgmtTradeRow[]): 'buy' | 'sell' {
  const sample = String(rows[0]?.direction ?? '').toLowerCase()
  return sample.includes('sell') ? 'sell' : 'buy'
}

function buildMgmtModifyTargets(args: {
  familyTrades: BasketOpenLeg[]
  hasNewSl: boolean
  newSl: number
  hasNewTp: boolean
  parsedTpLevels: number[]
  multiBasket: boolean
  tpLots: ManualTpLot[] | null | undefined
}): PerLegStopTarget[] {
  const {
    familyTrades,
    hasNewSl,
    newSl,
    hasNewTp,
    parsedTpLevels,
    multiBasket,
    tpLots,
  } = args
  return familyTrades.map((tr, legIndex) => {
    const stoploss = hasNewSl ? newSl : sanitizeLevel(tr.sl)
    let takeprofit = sanitizeLevel(tr.tp)
    if (hasNewTp) {
      if (multiBasket) {
        const distributed = takeProfitForLegIndex({
          legIndex,
          openLegCount: familyTrades.length,
          finalTps: parsedTpLevels,
          tpLots,
        })
        if (distributed > 0) takeprofit = distributed
      } else {
        takeprofit = parsedTpLevels[0] ?? takeprofit
      }
    }
    return { stoploss, takeprofit }
  })
}

export async function applyMgmtModifyToBasketGroups(args: {
  supabase: SupabaseClient
  apiFor: (broker: { id: string; metaapi_account_id?: string | null }) => MetatraderApiClient | null
  signal: {
    id: string
    user_id: string
    channel_id: string | null
  }
  parsed: { sl?: number | null; tp?: number[] | null }
  rowsByBrokerSignal: Map<string, MgmtTradeRow[]>
  brokersById: Map<string, {
    id: string
    metaapi_account_id?: string | null
    manual_settings?: unknown
    channel_message_filters?: unknown
    default_lot_size?: number | null
  }>
  hasNewSl: boolean
  hasNewTp: boolean
  parsedTpLevels: number[]
}): Promise<void> {
  const {
    supabase,
    apiFor,
    signal,
    parsed,
    rowsByBrokerSignal,
    brokersById,
    hasNewSl,
    hasNewTp,
    parsedTpLevels,
  } = args
  if (!hasNewSl && !hasNewTp) return

  const newSl = hasNewSl ? (parsed.sl as number) : 0

  for (const [basketKey, brokerRows] of rowsByBrokerSignal) {
    const broker = brokersById.get(basketKey.split('|')[0]!)
    if (!broker?.metaapi_account_id || broker.metaapi_account_id.includes('|')) continue
    if (isChannelManagementBlocked(
      normalizeChannelMessageFiltersMap(broker.channel_message_filters),
      signal.channel_id,
      'modify',
      { hasNewSl, hasNewTp },
    )) {
      continue
    }

    const api = apiFor(broker)
    if (!api) continue

    const uuid = broker.metaapi_account_id
    const familyTrades = brokerRows
      .filter(r => {
        const ticket = Number(r.metaapi_order_id)
        return Number.isFinite(ticket) && ticket > 0
      })
      .sort((a, b) => {
        const ta = a.opened_at ? new Date(a.opened_at).getTime() : 0
        const tb = b.opened_at ? new Date(b.opened_at).getTime() : 0
        return ta - tb
      })
      .map(mgmtRowToBasketLeg)

    if (!familyTrades.length) continue

    const anchorSignalId = familyTrades[0]!.signal_id
    const symbol = familyTrades[0]!.symbol
    const direction = inferBasketDirection(brokerRows)
    const manual = (broker.manual_settings ?? {}) as ManualSettings
    const multiBasket =
      manual.trade_style === 'multi'
      && familyTrades.length > 1
      && parsedTpLevels.length >= 2

    let params: BasketSymbolParams | null = null
    try {
      const sp = await api.symbolParams(uuid, symbol)
      const n = normalizeSymbolParams(sp)
      params = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        minLot: n.minLot ?? 0.01,
        lotStep: n.lotStep ?? 0.01,
        contractSize: n.contractSize ?? null,
        stopsLevel: n.stopsLevel ?? 0,
        freezeLevel: n.freezeLevel ?? 0,
      }
    } catch {
      // optional — runBasketLegModifies still attempts modify
    }

    let openedTickets: Set<number> | null = null
    try {
      openedTickets = await fetchOpenBrokerTickets(api, uuid)
    } catch {
      openedTickets = null
    }

    const perLegTargets = buildMgmtModifyTargets({
      familyTrades,
      hasNewSl,
      newSl,
      hasNewTp,
      parsedTpLevels,
      multiBasket,
      tpLots: manual.tp_lots,
    })

    const nImmCwe = brokerRows.filter(r => r.cwe_close_price != null).length
    const overrideTp = brokerRows.find(r => r.cwe_close_price != null)?.cwe_close_price ?? null

    const { summary, legErrors } = await runBasketLegModifies({
      supabase,
      api,
      uuid,
      symbol,
      direction,
      baseLot: Number(broker.default_lot_size ?? 0.01),
      params,
      signalId: signal.id,
      userId: signal.user_id,
      brokerAccountId: broker.id,
      familyTrades,
      perLegTargets,
      signalTps: parsedTpLevels,
      tpLots: manual.tp_lots,
      nImmCwe,
      overrideTp: typeof overrideTp === 'number' ? overrideTp : null,
      strictEntryPrefetch: null,
      openedTickets,
      skipAlreadySynced: false,
    })

    const mergeFailed = summary.modified < summary.openLegs
    const partialMsg = mergeFailed
      ? `Mgmt modify: ${summary.modified}/${summary.openLegs} legs on broker=${broker.id} anchor=${anchorSignalId}`
        + (summary.failed > 0 ? `; ${summary.failed} broker errors` : '')
        + (summary.skippedNotOnBroker > 0 ? `; ${summary.skippedNotOnBroker} not on broker` : '')
      : null

    if (mergeFailed) {
      console.warn(
        `[tradeExecutor] mgmt modify partial broker=${broker.id} anchor=${anchorSignalId}: ${partialMsg}`,
      )
      await upsertBasketReconcileJob(supabase, {
        userId: signal.user_id,
        brokerAccountId: broker.id,
        anchorSignalId,
        sourceSignalId: signal.id,
        channelId: signal.channel_id,
        symbol,
        direction,
        perLegTargets,
        familyTrades,
        signalTps: parsedTpLevels,
        tpLots: manual.tp_lots,
        virtualPendingsSnapshot: null,
        nImmCwe,
        overrideTp: typeof overrideTp === 'number' ? overrideTp : null,
        lastError: partialMsg,
      })
    } else {
      await markBasketReconcileDoneForAnchor(supabase, broker.id, anchorSignalId)
    }
  }
}
