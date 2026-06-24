/**
 * Canonical channel SL/TP apply — shared by live mgmt, reconcile, and diagnostics.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getFxsocketClient,
  hasFxsocketConfigured,
  mtPlatformFrom,
  type FxsocketBrokerClient,
} from './fxsocketClient'
import { loadChannelActiveTradeParamsForSymbol } from './channelActiveTradeParams'
import {
  buildEntryQualityTakeProfitMap,
  type EntryQualityLeg,
} from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from './manualPlanning/types'
import { isBenignOrderModifyError, stopsAlreadyMatchDb } from './orderModifyBenign'
import {
  upsertBasketReconcileJob,
  type BasketOpenLeg,
} from './basketSlTpReconcile'
import {
  expandMgmtRowsToFullBaskets,
  loadOpenTradesForManagement,
  loadTradesForBasketAnchor,
  type MgmtTradeRow,
} from './managementScope'
import { readBrokerOrderStopLoss } from './signalEntryPendingHelpers'
import { brokerSessionUuid, brokerHasLinkedSession } from './tradeExecutor/helpers'
import { incMetric } from './workerMetrics'
import { mgmtLegConcurrency, parallelMap } from './parallelPool'

export type ChannelStopLeg = {
  id: string
  signal_id: string
  broker_account_id: string
  metaapi_order_id: string | null
  symbol: string
  direction: string
  sl: number | null
  tp: number | null
  opened_at: string | null
  entry_price: number | null
  telegram_channel_id: string | null
  lot_size?: number
}

export type ChannelStopBroker = {
  id: string
  label?: string | null
  platform?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  manual_settings?: { tp_lots?: ManualTpLot[] | null } | null
}

export type BrokerBasketStopResult = {
  brokerId: string
  anchorSignalId: string
  symbol: string
  direction: 'buy' | 'sell'
  openLegs: number
  attempted: number
  modified: number
  failed: number
  skipped: number
  verified: number
  errors: Array<{ tradeId: string; ticket: number; message: string; skipReason?: string }>
  fullySynced: boolean
}

export type ChannelStopApplyResult = {
  brokers: BrokerBasketStopResult[]
  allFullySynced: boolean
  totalModified: number
  totalFailed: number
  totalSkipped: number
}

const SL_VERIFY_TOLERANCE = 1e-6

export function mgmtUseChannelStopApply(): boolean {
  const v = String(process.env.MGMT_USE_CHANNEL_STOP_APPLY ?? 'true').toLowerCase().trim()
  return v !== '0' && v !== 'false' && v !== 'no'
}

function positiveNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function mgmtRowToLeg(row: MgmtTradeRow): ChannelStopLeg {
  return {
    id: row.id,
    signal_id: row.signal_id,
    broker_account_id: row.broker_account_id,
    metaapi_order_id: row.metaapi_order_id,
    symbol: row.symbol,
    direction: row.direction,
    sl: row.sl,
    tp: row.tp,
    opened_at: row.opened_at,
    entry_price: row.entry_price,
    telegram_channel_id: null,
    lot_size: row.lot_size,
  }
}

export function groupLegsByBrokerSignal(legs: ChannelStopLeg[]): Map<string, ChannelStopLeg[]> {
  const map = new Map<string, ChannelStopLeg[]>()
  for (const leg of legs) {
    const key = `${leg.broker_account_id}|${leg.signal_id}`
    const list = map.get(key) ?? []
    list.push(leg)
    map.set(key, list)
  }
  return map
}

/**
 * Merge channel modify scope so every linked broker with open channel legs is included.
 */
export async function ensureChannelModifyScope(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    brokerAccountIds: string[]
    symbolFilter?: string | null
  },
): Promise<MgmtTradeRow[]> {
  const { userId, channelId, brokerAccountIds } = args
  if (!channelId || !brokerAccountIds.length) return []

  const byId = new Map<string, MgmtTradeRow>()
  const ingest = (rows: MgmtTradeRow[]) => {
    for (const row of rows) byId.set(row.id, row)
  }

  ingest(await loadOpenTradesForManagement(supabase, {
    userId,
    channelId,
    brokerAccountIds,
    symbolFilter: args.symbolFilter,
  }))

  for (const brokerId of brokerAccountIds) {
    ingest(await loadOpenTradesForManagement(supabase, {
      userId,
      channelId,
      brokerAccountIds: [brokerId],
      symbolFilter: args.symbolFilter,
    }))

    const brokerLegs = [...byId.values()].filter(r => r.broker_account_id === brokerId)
    if (brokerLegs.length > 0) continue

    const { data: latestOpen } = await supabase
      .from('trades')
      .select('signal_id')
      .eq('user_id', userId)
      .eq('broker_account_id', brokerId)
      .eq('status', 'open')
      .not('metaapi_order_id', 'is', null)
      .order('opened_at', { ascending: false })
      .limit(5)

    for (const row of latestOpen ?? []) {
      const anchorId = (row as { signal_id?: string }).signal_id
      if (!anchorId) continue
      const { data: sig } = await supabase
        .from('signals')
        .select('channel_id')
        .eq('id', anchorId)
        .maybeSingle()
      if ((sig as { channel_id?: string } | null)?.channel_id !== channelId) continue
      const basket = await loadTradesForBasketAnchor(supabase, {
        userId,
        brokerAccountIds: [brokerId],
        anchorSignalId: anchorId,
      })
      ingest(basket)
    }
  }

  return [...byId.values()].sort((a, b) => {
    const ta = a.opened_at ? new Date(a.opened_at).getTime() : 0
    const tb = b.opened_at ? new Date(b.opened_at).getTime() : 0
    return ta - tb
  })
}

/** All open symbol buckets on a channel (channel-wide modify without symbol in text). */
export function allChannelModifySymbolBuckets(trades: MgmtTradeRow[]): MgmtTradeRow[] {
  if (!trades.length) return []
  return trades
}

export function brokerOrderSlMatchesTarget(
  brokerSl: number | null,
  targetSl: number,
  tolerance = SL_VERIFY_TOLERANCE,
): boolean {
  if (brokerSl == null || !(brokerSl > 0) || !(targetSl > 0)) return false
  return Math.abs(brokerSl - targetSl) <= tolerance
}

export async function fetchBrokerOrdersByTicket(
  api: FxsocketBrokerClient,
  uuid: string,
): Promise<Map<number, unknown>> {
  const map = new Map<number, unknown>()
  try {
    const orders = await api.openedOrders(uuid)
    for (const raw of orders ?? []) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
      if (Number.isFinite(ticket) && ticket > 0) map.set(ticket, raw)
    }
  } catch {
    /* caller falls back to ticket-set preflight only */
  }
  return map
}

/** One OpenedOrders call -> both the open-ticket set and the ticket->order map. */
export async function fetchBrokerOrdersSnapshot(
  api: FxsocketBrokerClient,
  uuid: string,
): Promise<{ tickets: Set<number>; ordersByTicket: Map<number, unknown> }> {
  const tickets = new Set<number>()
  const ordersByTicket = new Map<number, unknown>()
  try {
    const orders = await api.openedOrders(uuid)
    for (const raw of orders ?? []) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
      if (Number.isFinite(ticket) && ticket > 0) {
        tickets.add(ticket)
        ordersByTicket.set(ticket, raw)
      }
    }
  } catch {
    /* caller treats empty as skip-preflight */
  }
  return { tickets, ordersByTicket }
}

export function verifyLegStopOnBroker(
  ordersByTicket: Map<number, unknown>,
  ticket: number,
  targetSl: number,
): boolean {
  const raw = ordersByTicket.get(ticket)
  if (!raw) return false
  const brokerSl = readBrokerOrderStopLoss(raw)
  return brokerOrderSlMatchesTarget(brokerSl, targetSl)
}

async function resolveTargetSlForLeg(args: {
  supabase: SupabaseClient
  userId: string
  channelId: string | null
  symbol: string
  parsedSl?: number | null
  slOverride?: number | null
  slFrom?: 'channel' | 'signal' | 'parsed' | 'trade'
  tradeSl?: number | null
}): Promise<number | null> {
  const override = positiveNum(args.slOverride)
  if (override != null) return override

  const parsedSl = positiveNum(args.parsedSl)
  if (args.slFrom === 'parsed' && parsedSl != null) return parsedSl

  const tryChannel = async (): Promise<number | null> => {
    if (!args.channelId) return null
    const ch = await loadChannelActiveTradeParamsForSymbol(
      args.supabase,
      args.userId,
      args.channelId,
      args.symbol,
    )
    return positiveNum(ch?.stoploss)
  }

  if (args.slFrom === 'trade') {
    const fromTrade = positiveNum(args.tradeSl)
    if (fromTrade != null) return fromTrade
    const fromCh = await tryChannel()
    if (fromCh != null) return fromCh
    if (parsedSl != null) return parsedSl
  }

  if (args.slFrom === 'signal') {
    if (parsedSl != null) return parsedSl
    const fromCh = await tryChannel()
    if (fromCh != null) return fromCh
  }

  const fromCh = await tryChannel()
  if (fromCh != null) return fromCh
  if (parsedSl != null) return parsedSl
  return positiveNum(args.tradeSl)
}

function legToBasketOpenLeg(leg: ChannelStopLeg): BasketOpenLeg {
  return {
    id: leg.id,
    signal_id: leg.signal_id,
    metaapi_order_id: leg.metaapi_order_id,
    opened_at: leg.opened_at ?? '',
    lot_size: leg.lot_size ?? 0.01,
    sl: leg.sl,
    tp: leg.tp,
    entry_price: leg.entry_price,
    direction: leg.direction,
    symbol: leg.symbol,
  }
}

export type ApplyChannelStopsArgs = {
  supabase: SupabaseClient
  apiFor: (broker: ChannelStopBroker) => FxsocketBrokerClient | null
  userId: string
  channelId: string | null
  signalId: string
  brokersById: Map<string, ChannelStopBroker>
  rowsByBrokerSignal: Map<string, ChannelStopLeg[]>
  hasNewSl: boolean
  hasNewTp: boolean
  parsedSl?: number | null
  parsedTpLevels?: number[]
  slOverride?: number | null
  slFrom?: 'channel' | 'signal' | 'parsed' | 'trade'
  slOnly?: boolean
  tpOnly?: boolean
  dryRun?: boolean
  manualPush?: boolean
  verifyOnBroker?: boolean
  fxsocketOnly?: boolean
}

export async function applyChannelStopsToBaskets(
  args: ApplyChannelStopsArgs,
): Promise<ChannelStopApplyResult> {
  const {
    supabase,
    apiFor,
    userId,
    channelId,
    signalId,
    brokersById,
    rowsByBrokerSignal,
    hasNewSl,
    hasNewTp,
    parsedSl,
    parsedTpLevels = [],
    dryRun = false,
    manualPush = false,
    verifyOnBroker = true,
    fxsocketOnly = false,
  } = args

  const slOnly = args.slOnly === true || (hasNewSl && !hasNewTp)
  const tpOnly = args.tpOnly === true || (hasNewTp && !hasNewSl)

  const brokerResults: BrokerBasketStopResult[] = []
  let totalModified = 0
  let totalFailed = 0
  let totalSkipped = 0

  if (!dryRun && !hasFxsocketConfigured()) {
    return {
      brokers: [],
      allFullySynced: false,
      totalModified: 0,
      totalFailed: 0,
      totalSkipped: 0,
    }
  }

  for (const [basketKey, brokerRows] of rowsByBrokerSignal) {
    const brokerId = basketKey.split('|')[0]!
    const broker = brokersById.get(brokerId)
    const uuid = broker ? brokerSessionUuid(broker) : null

    const anchorSignalId = brokerRows[0]?.signal_id ?? ''
    const symbol = brokerRows[0]?.symbol ?? ''
    const direction = String(brokerRows[0]?.direction ?? '').toLowerCase().includes('sell')
      ? 'sell'
      : 'buy'

    const baseResult: BrokerBasketStopResult = {
      brokerId,
      anchorSignalId,
      symbol,
      direction,
      openLegs: 0,
      attempted: 0,
      modified: 0,
      failed: 0,
      skipped: 0,
      verified: 0,
      errors: [],
      fullySynced: false,
    }

    if (!broker || !uuid || uuid.includes('|')) {
      baseResult.skipped = brokerRows.length
      baseResult.errors.push({
        tradeId: '',
        ticket: 0,
        message: 'no broker session',
        skipReason: 'no_session',
      })
      totalSkipped += brokerRows.length
      brokerResults.push(baseResult)
      incMetric('mgmt_modify_broker_skipped')
      continue
    }

    if (fxsocketOnly && !brokerHasLinkedSession(broker)) {
      baseResult.skipped = brokerRows.length
      baseResult.errors.push({
        tradeId: '',
        ticket: 0,
        message: 'not fxsocket-only broker',
        skipReason: 'fxsocket_only',
      })
      totalSkipped += brokerRows.length
      brokerResults.push(baseResult)
      incMetric('mgmt_modify_broker_skipped')
      continue
    }

    const api = apiFor(broker)
    if (!api && !dryRun) {
      baseResult.failed = brokerRows.length
      totalFailed += brokerRows.length
      brokerResults.push(baseResult)
      continue
    }

    api?.seedPlatformCache(uuid, mtPlatformFrom(broker.platform ?? 'mt5'))

    const legs = brokerRows
      .filter(r => {
        const ticket = Number(r.metaapi_order_id)
        return Number.isFinite(ticket) && ticket > 0
      })
      .sort((a, b) => {
        const ta = a.opened_at ? new Date(a.opened_at).getTime() : 0
        const tb = b.opened_at ? new Date(b.opened_at).getTime() : 0
        return ta - tb
      })

    baseResult.openLegs = legs.length
    if (!legs.length) {
      brokerResults.push(baseResult)
      continue
    }

    const tpLots = broker.manual_settings?.tp_lots ?? null
    const isBuy = direction === 'buy'
    const tpMap = slOnly || tpOnly
      ? new Map<string, number>()
      : buildEntryQualityTakeProfitMap({
          legs: legs.map(tr => ({
            id: tr.id,
            entryPrice: Number(tr.entry_price ?? 0),
            openedAt: tr.opened_at ?? '',
          })) satisfies EntryQualityLeg[],
          isBuy,
          slotLegCount: legs.length,
          finalTps: parsedTpLevels,
          tpLots: tpLots ?? null,
        })

    let openedTickets: Set<number> | null = null
    let ordersByTicket = new Map<number, unknown>()
    if (api) {
      try {
        // Single OpenedOrders snapshot serves both preflight and SL verification.
        const snapshot = await fetchBrokerOrdersSnapshot(api, uuid)
        openedTickets = snapshot.tickets
        ordersByTicket = snapshot.ordersByTicket
      } catch {
        openedTickets = null
      }
    }

    const slCache = new Map<string, number>()
    const perLegTargets: Array<{ stoploss: number; takeprofit: number }> = []

    // Phase 1 (serial, DB-only): build each leg's target and decide skip/execute.
    type LegModPlan = {
      tr: typeof legs[number]
      ticket: number
      target: { stoploss: number; takeprofit: number }
      modifyArgs: { ticket: number; stoploss?: number; takeprofit?: number }
    }
    const execPlan: LegModPlan[] = []

    for (let i = 0; i < legs.length; i++) {
      const tr = legs[i]!
      baseResult.attempted += 1

      const ticket = Number(tr.metaapi_order_id)
      const keepTp = positiveNum(tr.tp)
      const keepSl = positiveNum(tr.sl)
      const targetTp = tpOnly
        ? (tpMap.get(tr.id) ?? keepTp)
        : slOnly
          ? keepTp
          : (tpMap.get(tr.id) ?? keepTp)

      let targetSl: number | null = tpOnly ? keepSl : null
      if (!tpOnly && hasNewSl) {
        const chKey = `${tr.telegram_channel_id ?? channelId ?? ''}|${tr.symbol}`
        const cached = slCache.get(chKey)
        if (cached != null) {
          targetSl = cached
        } else {
          targetSl = await resolveTargetSlForLeg({
            supabase,
            userId,
            channelId: tr.telegram_channel_id ?? channelId,
            symbol: tr.symbol,
            parsedSl,
            slOverride: args.slOverride,
            slFrom: args.slFrom ?? 'parsed',
            tradeSl: tr.sl,
          })
          if (targetSl != null) slCache.set(chKey, targetSl)
        }
      }

      if (targetSl != null && targetSl > 0) {
        perLegTargets.push({
          stoploss: targetSl,
          takeprofit: targetTp ?? 0,
        })
      } else if (targetTp != null && targetTp > 0) {
        perLegTargets.push({ stoploss: keepSl ?? 0, takeprofit: targetTp })
      } else {
        baseResult.skipped += 1
        totalSkipped += 1
        continue
      }

      const target = perLegTargets[perLegTargets.length - 1]!

      if (
        !tpOnly
        && target.stoploss > 0
        && stopsAlreadyMatchDb(
          { sl: tr.sl, tp: tr.tp },
          { stoploss: target.stoploss, takeprofit: target.takeprofit ?? 0 },
          0,
          i,
        )
        && (!verifyOnBroker || verifyLegStopOnBroker(ordersByTicket, ticket, target.stoploss))
      ) {
        baseResult.skipped += 1
        baseResult.verified += 1
        totalSkipped += 1
        continue
      }

      if (openedTickets && openedTickets.size > 0 && !openedTickets.has(ticket)) {
        baseResult.skipped += 1
        baseResult.errors.push({
          tradeId: tr.id,
          ticket,
          message: 'ticket not in OpenedOrders',
          skipReason: 'skipped_not_on_broker',
        })
        totalSkipped += 1
        continue
      }

      if (dryRun) continue

      const modifyArgs: { ticket: number; stoploss?: number; takeprofit?: number } = { ticket }
      if (!tpOnly && target.stoploss > 0) modifyArgs.stoploss = target.stoploss
      if (!slOnly && target.takeprofit > 0) modifyArgs.takeprofit = target.takeprofit
      if (modifyArgs.stoploss == null && modifyArgs.takeprofit == null) {
        baseResult.skipped += 1
        totalSkipped += 1
        continue
      }

      execPlan.push({ tr, ticket, target, modifyArgs })
    }

    // Phase 2 (parallel): fire OrderModify across legs concurrently. Serial
    // bridge round-trips were the main "modify too slow" cause on big baskets.
    type LegModOutcome = {
      modified: number
      failed: number
      skipped: number
      verified: number
      error?: { tradeId: string; ticket: number; message: string; skipReason?: string }
    }
    const noop = (): LegModOutcome => ({ modified: 0, failed: 0, skipped: 0, verified: 0 })

    const execOne = async (plan: LegModPlan): Promise<LegModOutcome> => {
      const { tr, ticket, target, modifyArgs } = plan
      try {
        await api!.orderModify(uuid, modifyArgs)

        const brokerOk = !verifyOnBroker
          || !hasNewSl
          || target.stoploss <= 0
          || verifyLegStopOnBroker(ordersByTicket, ticket, target.stoploss)

        if (!brokerOk) {
          return {
            ...noop(),
            failed: 1,
            error: {
              tradeId: tr.id,
              ticket,
              message: 'broker SL mismatch after OrderModify',
              skipReason: 'broker_verify_failed',
            },
          }
        }

        const dbPatch: { sl?: number | null; tp?: number | null } = {}
        if (!tpOnly && target.stoploss > 0) dbPatch.sl = target.stoploss
        if (!slOnly && target.takeprofit > 0) dbPatch.tp = target.takeprofit
        if (Object.keys(dbPatch).length > 0) {
          await supabase.from('trades').update(dbPatch).eq('id', tr.id)
        }

        await supabase.from('trade_execution_logs').insert({
          user_id: userId,
          signal_id: signalId,
          broker_account_id: brokerId,
          action: 'mgmt_modify',
          status: 'success',
          request_payload: {
            ticket,
            action: 'modify',
            target_sl: modifyArgs.stoploss ?? null,
            target_tp: modifyArgs.takeprofit ?? null,
            manual_push: manualPush,
            trade_id: tr.id,
            channel_stop_apply: true,
          } as unknown as Record<string, unknown>,
        })

        return { ...noop(), modified: 1, verified: 1 }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (isBenignOrderModifyError(msg)) {
          return { ...noop(), skipped: 1 }
        }
        try {
          await supabase.from('trade_execution_logs').insert({
            user_id: userId,
            signal_id: signalId,
            broker_account_id: brokerId,
            action: 'mgmt_modify',
            status: 'failed',
            error_message: msg,
            request_payload: { ticket, trade_id: tr.id, channel_stop_apply: true } as unknown as Record<string, unknown>,
          })
        } catch { /* best-effort */ }
        return { ...noop(), failed: 1, error: { tradeId: tr.id, ticket, message: msg } }
      }
    }

    const outcomes = execPlan.length > 1
      ? await parallelMap(execPlan, mgmtLegConcurrency(), execOne)
      : await Promise.all(execPlan.map(execOne))

    for (const o of outcomes) {
      baseResult.modified += o.modified
      baseResult.failed += o.failed
      baseResult.skipped += o.skipped
      baseResult.verified += o.verified
      totalModified += o.modified
      totalFailed += o.failed
      totalSkipped += o.skipped
      if (o.error) baseResult.errors.push(o.error)
    }

    baseResult.fullySynced = baseResult.openLegs > 0
      && baseResult.failed === 0
      && baseResult.modified + baseResult.verified >= baseResult.openLegs

    if (!baseResult.fullySynced && baseResult.openLegs > 0) {
      incMetric('mgmt_modify_partial')
      const familyTrades = legs.map(legToBasketOpenLeg)
      await upsertBasketReconcileJob(supabase, {
        userId,
        brokerAccountId: brokerId,
        anchorSignalId,
        sourceSignalId: signalId,
        channelId,
        symbol,
        direction,
        perLegTargets: perLegTargets.length
          ? perLegTargets
          : familyTrades.map(tr => ({
              stoploss: positiveNum(parsedSl) ?? positiveNum(tr.sl) ?? 0,
              takeprofit: positiveNum(tr.tp) ?? 0,
            })),
        familyTrades,
        signalTps: parsedTpLevels,
        tpLots,
        virtualPendingsSnapshot: null,
        nImmCwe: 0,
        overrideTp: null,
        lastError: `channel_stop_apply partial ${baseResult.modified}/${baseResult.openLegs}`,
      })
    }

    brokerResults.push(baseResult)
  }

  const allFullySynced = brokerResults.length > 0
    && brokerResults.every(r => r.openLegs === 0 || r.fullySynced)

  return {
    brokers: brokerResults,
    allFullySynced,
    totalModified,
    totalFailed,
    totalSkipped,
  }
}

export async function logMgmtModifyBrokerSummaries(
  supabase: SupabaseClient,
  userId: string,
  signalId: string,
  results: BrokerBasketStopResult[],
): Promise<void> {
  for (const r of results) {
    if (r.openLegs === 0) continue
    try {
      await supabase.from('trade_execution_logs').insert({
        user_id: userId,
        signal_id: signalId,
        broker_account_id: r.brokerId,
        action: 'mgmt_modify_broker_summary',
        status: r.fullySynced ? 'success' : 'failed',
        request_payload: {
          anchor_signal_id: r.anchorSignalId,
          symbol: r.symbol,
          open_legs: r.openLegs,
          attempted: r.attempted,
          modified: r.modified,
          failed: r.failed,
          skipped: r.skipped,
          verified: r.verified,
          fully_synced: r.fullySynced,
          skip_reasons: r.errors.map(e => e.skipReason ?? e.message),
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }
  }
}

export function mgmtRowsToStopLegs(rows: MgmtTradeRow[]): ChannelStopLeg[] {
  return rows.map(mgmtRowToLeg)
}

export async function expandAndGroupChannelModifyLegs(
  supabase: SupabaseClient,
  userId: string,
  rows: MgmtTradeRow[],
): Promise<Map<string, ChannelStopLeg[]>> {
  const expanded = await expandMgmtRowsToFullBaskets(supabase, { userId, rows })
  return groupLegsByBrokerSignal(mgmtRowsToStopLegs(expanded))
}
