/**
 * Canonical channel SL/TP apply — shared by live mgmt, reconcile, and diagnostics.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  tradeFailureReasonFromBrokerMessage,
  tradeFailureReasonFromCode,
  type TradeFailureReason,
} from './brokerTradeError'
import {
  mtPlatformFrom,
  type FxsocketBrokerClient,
} from './fxsocketClient'
import { loadChannelActiveTradeParamsForSymbol } from './channelActiveTradeParams'
import {
  buildEntryQualityTakeProfitMap,
  type EntryQualityLeg,
} from './manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from './manualPlanning/types'
import { isBenignOrderModifyError, isPositionGoneError, stopsAlreadyMatchDb } from './orderModifyBenign'
import { isInvalidStopsError, modifyLegSlTpWithFallback } from './orderModifySafe'
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
import { mgmtBasketConcurrency, mgmtLegConcurrency, parallelMap } from './parallelPool'
import { deepestFinalTp, hasClosedBasketLegs } from './rangeBasketTpSync'
import { hasTpTouchedLock } from './rangePendingFireGuard'
import { classifyBrokerFailureReason } from './observability/businessEvents'

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
  provider?: string | null
  mtapi_session_id?: string | null
  metaapi_account_id?: string | null
  writer_epoch?: number | null
  provider_transition_state?: string | null
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
const MANAGEMENT_MODIFY_OPERATION = 'management_modify'
const MANAGEMENT_MODIFY_PARTIAL_REASON_CODE = 'MANAGEMENT_MODIFY_PARTIAL'
const UNKNOWN_MODIFY_REASON_CODE = 'UNKNOWN'
const MAX_SUMMARY_LEG_FAILURES = 10
const MAX_UNDERLYING_REASON_CODES = 5

type MgmtModifyFailurePhase =
  | 'broker_session'
  | 'broker_position_lookup'
  | 'order_modify'
  | 'broker_verify'

type MgmtModifyFailureSource = 'structured' | 'broker_classification' | 'local' | 'unknown'

export type MgmtModifyFailureDiagnostic = {
  operation: typeof MANAGEMENT_MODIFY_OPERATION
  reason_code: string
  failure_reason: string
  failure_phase: MgmtModifyFailurePhase
  trade_failure: TradeFailureReason
  retryable: boolean
  source: MgmtModifyFailureSource
  skip_reason?: string
}

function fallbackMgmtModifyTradeFailure(reasonCode: string, failureReason = reasonCode): TradeFailureReason {
  switch (reasonCode) {
    case 'INVALID_STOPS':
      return {
        reasonCode,
        category: 'broker',
        title: 'Management modify was rejected by broker stop rules',
        explanation: 'The broker rejected the SL/TP modification, usually because the requested stop or take-profit was inside stop or freeze limits.',
        recommendedAction: 'Check broker stop/freeze levels, symbol price, and whether price moved while the management update was being applied.',
        retryable: true,
        userActionRequired: false,
      }
    case 'POSITION_GONE':
      return {
        reasonCode,
        category: 'broker',
        title: 'Position was no longer open',
        explanation: 'The broker reported that the ticket was gone while the management modification was being applied.',
        recommendedAction: 'Check whether TP, SL, or a manual close removed the position before the management update completed.',
        retryable: false,
        userActionRequired: false,
      }
    case 'UNKNOWN':
      return {
        reasonCode,
        category: 'broker',
        title: 'Management modify was not confirmed',
        explanation: 'The copier could not safely classify why the broker did not confirm the management modification.',
        recommendedAction: 'Review the broker account state and per-leg execution logs before retrying or escalating.',
        retryable: false,
        userActionRequired: true,
      }
    default:
      return tradeFailureReasonFromCode(reasonCode) ?? {
        reasonCode,
        category: 'broker',
        title: 'Management modify was not confirmed',
        explanation: `The management modification did not complete with the safe reason ${failureReason}.`,
        recommendedAction: 'Review the broker account state and per-leg execution logs before retrying or escalating.',
        retryable: false,
        userActionRequired: true,
      }
  }
}

function classifyBrokerMessageForMgmtModify(message: string): {
  reasonCode: string
  tradeFailure: TradeFailureReason
  source: MgmtModifyFailureSource
} {
  if (isPositionGoneError(message)) {
    const reasonCode = 'POSITION_GONE'
    return { reasonCode, tradeFailure: fallbackMgmtModifyTradeFailure(reasonCode), source: 'structured' }
  }
  if (isInvalidStopsError(message)) {
    const reasonCode = 'INVALID_STOPS'
    return { reasonCode, tradeFailure: fallbackMgmtModifyTradeFailure(reasonCode), source: 'structured' }
  }
  const tradeFailure = tradeFailureReasonFromBrokerMessage(message)
  if (tradeFailure?.reasonCode) {
    return { reasonCode: tradeFailure.reasonCode, tradeFailure, source: 'broker_classification' }
  }

  const genericCode = classifyBrokerFailureReason(message)
  if (genericCode !== 'BROKER_ORDER_REJECTED') {
    return {
      reasonCode: genericCode,
      tradeFailure: fallbackMgmtModifyTradeFailure(genericCode),
      source: 'broker_classification',
    }
  }
  if (/\breject(?:ed|ion)?\b/i.test(message)) {
    return {
      reasonCode: genericCode,
      tradeFailure: fallbackMgmtModifyTradeFailure(genericCode),
      source: 'broker_classification',
    }
  }

  return {
    reasonCode: UNKNOWN_MODIFY_REASON_CODE,
    tradeFailure: fallbackMgmtModifyTradeFailure(UNKNOWN_MODIFY_REASON_CODE),
    source: 'unknown',
  }
}

export function buildMgmtModifyFailureDiagnostic(input: {
  message?: string | null
  skipReason?: string | null
}): MgmtModifyFailureDiagnostic {
  const skipReason = String(input.skipReason ?? '').trim()
  const message = String(input.message ?? '').trim()
  let reasonCode: string
  let failureReason: string
  let failurePhase: MgmtModifyFailurePhase
  let tradeFailure: TradeFailureReason
  let source: MgmtModifyFailureSource

  switch (skipReason) {
    case 'no_session':
      reasonCode = 'BROKER_ACCOUNT_UNAVAILABLE'
      failureReason = 'NO_BROKER_SESSION'
      failurePhase = 'broker_session'
      tradeFailure = tradeFailureReasonFromCode(reasonCode) ?? fallbackMgmtModifyTradeFailure(reasonCode, failureReason)
      source = 'structured'
      break
    case 'skipped_not_on_broker':
      reasonCode = 'POSITION_GONE'
      failureReason = 'POSITION_GONE'
      failurePhase = 'broker_position_lookup'
      tradeFailure = fallbackMgmtModifyTradeFailure(reasonCode)
      source = 'structured'
      break
    case 'sl_not_applied':
      reasonCode = 'BROKER_ORDER_REJECTED'
      failureReason = 'REQUESTED_SL_NOT_APPLIED'
      failurePhase = 'order_modify'
      tradeFailure = fallbackMgmtModifyTradeFailure(reasonCode, failureReason)
      source = 'structured'
      break
    case 'broker_verify_failed':
      reasonCode = 'BROKER_ORDER_REJECTED'
      failureReason = 'BROKER_VERIFY_FAILED'
      failurePhase = 'broker_verify'
      tradeFailure = fallbackMgmtModifyTradeFailure(reasonCode, failureReason)
      source = 'structured'
      break
    case 'fxsocket_only':
      reasonCode = 'BROKER_ACCOUNT_UNAVAILABLE'
      failureReason = 'BROKER_NOT_FXSOCKET_LINKED'
      failurePhase = 'broker_session'
      tradeFailure = tradeFailureReasonFromCode(reasonCode) ?? fallbackMgmtModifyTradeFailure(reasonCode, failureReason)
      source = 'structured'
      break
    default: {
      const classified = classifyBrokerMessageForMgmtModify(message)
      reasonCode = classified.reasonCode
      failureReason = reasonCode
      failurePhase = reasonCode === 'POSITION_GONE' ? 'broker_position_lookup' : 'order_modify'
      tradeFailure = classified.tradeFailure
      source = classified.source
    }
  }

  return {
    operation: MANAGEMENT_MODIFY_OPERATION,
    reason_code: reasonCode,
    failure_reason: failureReason,
    failure_phase: failurePhase,
    trade_failure: tradeFailure,
    retryable: tradeFailure.retryable,
    source,
    ...(skipReason ? { skip_reason: skipReason } : {}),
  }
}

function mgmtModifyFailurePayload(diagnostic: MgmtModifyFailureDiagnostic): Record<string, unknown> {
  return {
    management_operation: diagnostic.operation,
    reason_code: diagnostic.reason_code,
    failure_reason: diagnostic.failure_reason,
    failure_phase: diagnostic.failure_phase,
    trade_failure: diagnostic.trade_failure,
    retryable: diagnostic.retryable,
    diagnostic_source: diagnostic.source,
    ...(diagnostic.skip_reason ? { skip_reason: diagnostic.skip_reason } : {}),
  }
}

function boundedDistinctReasonCodes(values: string[]): {
  codes: string[]
  counts: Record<string, number>
  truncated: boolean
} {
  const counts: Record<string, number> = {}
  const codes: string[] = []
  for (const raw of values) {
    const code = String(raw ?? '').trim().toUpperCase()
    if (!code) continue
    counts[code] = (counts[code] ?? 0) + 1
    if (!codes.includes(code) && codes.length < MAX_UNDERLYING_REASON_CODES) codes.push(code)
  }
  return {
    codes,
    counts: Object.fromEntries(codes.map(code => [code, counts[code] ?? 0])),
    truncated: Object.keys(counts).length > codes.length,
  }
}

function diagnosticPriority(diagnostic: MgmtModifyFailureDiagnostic): number {
  switch (diagnostic.source) {
    case 'structured': return 0
    case 'broker_classification': return 1
    case 'local': return 2
    default: return 3
  }
}

function primaryMgmtModifyDiagnostic(
  diagnostics: MgmtModifyFailureDiagnostic[],
): MgmtModifyFailureDiagnostic | null {
  return [...diagnostics].sort((a, b) => {
    const byPriority = diagnosticPriority(a) - diagnosticPriority(b)
    if (byPriority !== 0) return byPriority
    return a.reason_code.localeCompare(b.reason_code)
  })[0] ?? null
}

function safeLegFailureDiagnostic(error: {
  tradeId: string
  ticket: number
  message: string
  skipReason?: string
}): Record<string, unknown> {
  const diagnostic = buildMgmtModifyFailureDiagnostic({
    message: error.message,
    skipReason: error.skipReason,
  })
  return {
    operation: MANAGEMENT_MODIFY_OPERATION,
    trade_id: error.tradeId,
    ticket: error.ticket,
    reason_code: diagnostic.reason_code,
    failure_reason: diagnostic.failure_reason,
    failure_phase: diagnostic.failure_phase,
    retryable: diagnostic.retryable,
    diagnostic_source: diagnostic.source,
    ...(diagnostic.skip_reason ? { skip_reason: diagnostic.skip_reason } : {}),
  }
}

function mgmtModifySummaryFailurePayload(r: BrokerBasketStopResult): Record<string, unknown> {
  const diagnostics = r.errors.length > 0
    ? r.errors.map(error => buildMgmtModifyFailureDiagnostic({
        message: error.message,
        skipReason: error.skipReason,
      }))
    : [buildMgmtModifyFailureDiagnostic({})]
  const primary = primaryMgmtModifyDiagnostic(diagnostics)
  if (!primary) return {}

  const distinct = boundedDistinctReasonCodes(diagnostics.map(d => d.reason_code))
  const orderedCodes = [
    primary.reason_code,
    ...distinct.codes.filter(code => code !== primary.reason_code),
  ]
  return {
    ...mgmtModifyFailurePayload({
      ...primary,
      reason_code: MANAGEMENT_MODIFY_PARTIAL_REASON_CODE,
      failure_reason: primary.failure_reason,
    }),
    primary_underlying_reason_code: primary.reason_code,
    underlying_reason_codes: orderedCodes,
    underlying_reason_counts: distinct.counts,
    truncated_underlying_reason_codes: distinct.truncated,
    mixed_failure: distinct.codes.length > 1,
    partial_failure: r.modified + r.verified > 0 && (r.failed > 0 || r.skipped > 0),
    leg_failures: r.errors.slice(0, MAX_SUMMARY_LEG_FAILURES).map(safeLegFailureDiagnostic),
    truncated_leg_failures: r.errors.length > MAX_SUMMARY_LEG_FAILURES,
  }
}

function mgmtModifySummaryRetryPending(r: BrokerBasketStopResult): boolean {
  return r.openLegs > 0 && !r.fullySynced
}

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

  // Single all-broker channel load covers every account in one scope query. The
  // previous design re-ran this per broker (O(accounts) serial DB round-trips),
  // the dominant pre-broker latency on channel-wide modify/breakeven at 10-15
  // accounts.
  ingest(await loadOpenTradesForManagement(supabase, {
    userId,
    channelId,
    brokerAccountIds,
    symbolFilter: args.symbolFilter,
  }))

  // Only brokers with zero attributed legs need the anchor-discovery fallback
  // (open legs whose telegram_channel_id / attribution lag behind fresh fills).
  // Run that fallback in parallel, bounded, instead of serially per account.
  const brokersWithLegs = new Set<string>()
  for (const row of byId.values()) brokersWithLegs.add(row.broker_account_id)
  const emptyBrokerIds = brokerAccountIds.filter(id => !brokersWithLegs.has(id))

  if (emptyBrokerIds.length > 0) {
    const fallbackRows = await parallelMap(
      emptyBrokerIds,
      mgmtBasketConcurrency(),
      async (brokerId): Promise<MgmtTradeRow[]> => {
        // Scan all open legs for this broker (not just the latest 5) so older
        // channel baskets on a busy multi-broker account are not missed.
        const { data: openRows } = await supabase
          .from('trades')
          .select('signal_id')
          .eq('user_id', userId)
          .eq('broker_account_id', brokerId)
          .eq('status', 'open')
          .not('metaapi_order_id', 'is', null)
          .order('opened_at', { ascending: false })
          .limit(500)

        const signalIds = [...new Set(
          (openRows ?? [])
            .map(r => (r as { signal_id?: string }).signal_id)
            .filter((id): id is string => Boolean(id)),
        )]
        if (!signalIds.length) return []

        // One batched query resolves which of those signals belong to this channel.
        const { data: sigRows } = await supabase
          .from('signals')
          .select('id')
          .in('id', signalIds)
          .eq('channel_id', channelId)
        const channelSignalIds = (sigRows ?? []).map(s => (s as { id: string }).id)
        if (!channelSignalIds.length) return []

        const found: MgmtTradeRow[] = []
        await parallelMap(channelSignalIds, mgmtBasketConcurrency(), async (anchorId) => {
          const basket = await loadTradesForBasketAnchor(supabase, {
            userId,
            brokerAccountIds: [brokerId],
            anchorSignalId: anchorId,
          })
          found.push(...basket)
        })
        return found
      },
    )
    for (const rows of fallbackRows) ingest(rows)
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

  // Apply baskets (one per account) concurrently — each targets a different MT
  // terminal, so distinct baskets don't contend. Per-leg modifies within a basket
  // still run under mgmtLegConcurrency(), and the fxClient per-terminal gate keeps
  // a single terminal from being overloaded. Serial basket passes were the main
  // "modify too slow across many accounts" cause at 10-15 accounts.
  const processOneBasket = async (
    [basketKey, brokerRows]: [string, ChannelStopLeg[]],
  ): Promise<void> => {
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
      return
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
      return
    }

    const api = apiFor(broker)
    if (!api && !dryRun) {
      baseResult.failed = brokerRows.length
      totalFailed += brokerRows.length
      brokerResults.push(baseResult)
      return
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
      return
    }

    const tpLots = broker.manual_settings?.tp_lots ?? null
    const isBuy = direction === 'buy'
    // Freeze: once a TP has been hit (a leg closed OR a sticky TP-touch lock),
    // never repaint TP across remaining legs. Keep each leg's existing TP and
    // only backfill a naked leg with the deepest TP — mirrors the
    // rebalance/reconcile freeze, which this live modify path previously bypassed.
    let tpFrozen = false
    if (!dryRun && anchorSignalId) {
      try {
        tpFrozen = (await hasClosedBasketLegs(supabase, brokerId, anchorSignalId))
          || (await hasTpTouchedLock(supabase, { signalId: anchorSignalId, brokerAccountId: brokerId, symbol }))
      } catch {
        tpFrozen = false
      }
    }
    const frozenDeepestTp = deepestFinalTp(parsedTpLevels, isBuy)
    const tpMap = slOnly || tpOnly || tpFrozen
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
      const targetTp = tpFrozen
        ? (keepTp ?? (frozenDeepestTp > 0 ? frozenDeepestTp : null))
        : tpOnly
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
        // SL-first with split fallback: an invalid/late TP must never block the
        // protective SL (previously a rejected combined modify left the leg naked).
        const safe = await modifyLegSlTpWithFallback(
          api!,
          uuid,
          ticket,
          modifyArgs.stoploss ?? 0,
          modifyArgs.takeprofit ?? 0,
          { deepestTp: frozenDeepestTp },
        )
        if (!safe.ok) {
          const diagnostic = buildMgmtModifyFailureDiagnostic({ message: safe.error ?? 'OrderModify failed' })
          await supabase.from('trade_execution_logs').insert({
            user_id: userId,
            signal_id: signalId,
            broker_account_id: brokerId,
            action: 'mgmt_modify',
            status: 'failed',
            error_message: safe.error ?? 'OrderModify failed',
            request_payload: {
              ticket,
              trade_id: tr.id,
              channel_stop_apply: true,
              ...mgmtModifyFailurePayload(diagnostic),
            } as unknown as Record<string, unknown>,
          })
          return { ...noop(), failed: 1, error: { tradeId: tr.id, ticket, message: safe.error ?? 'OrderModify failed' } }
        }
        // The SL is the protective stop — if it was requested but not applied
        // (split TP-only success), the leg is not safe; flag for reconcile.
        const slRequested = !tpOnly && target.stoploss > 0
        if (slRequested && !safe.slApplied) {
          const msg = safe.error ?? 'SL not applied'
          const diagnostic = buildMgmtModifyFailureDiagnostic({ message: msg, skipReason: 'sl_not_applied' })
          await supabase.from('trade_execution_logs').insert({
            user_id: userId,
            signal_id: signalId,
            broker_account_id: brokerId,
            action: 'mgmt_modify',
            status: 'failed',
            error_message: msg,
            request_payload: {
              ticket,
              trade_id: tr.id,
              channel_stop_apply: true,
              ...mgmtModifyFailurePayload(diagnostic),
            } as unknown as Record<string, unknown>,
          })
          return {
            ...noop(),
            failed: 1,
            error: { tradeId: tr.id, ticket, message: msg, skipReason: 'sl_not_applied' },
          }
        }

        const brokerOk = !verifyOnBroker
          || !hasNewSl
          || target.stoploss <= 0
          || !safe.slApplied
          || verifyLegStopOnBroker(ordersByTicket, ticket, target.stoploss)

        if (!brokerOk) {
          const msg = 'broker SL mismatch after OrderModify'
          const diagnostic = buildMgmtModifyFailureDiagnostic({ message: msg, skipReason: 'broker_verify_failed' })
          await supabase.from('trade_execution_logs').insert({
            user_id: userId,
            signal_id: signalId,
            broker_account_id: brokerId,
            action: 'mgmt_modify',
            status: 'failed',
            error_message: msg,
            request_payload: {
              ticket,
              trade_id: tr.id,
              channel_stop_apply: true,
              ...mgmtModifyFailurePayload(diagnostic),
            } as unknown as Record<string, unknown>,
          })
          return {
            ...noop(),
            failed: 1,
            error: {
              tradeId: tr.id,
              ticket,
              message: msg,
              skipReason: 'broker_verify_failed',
            },
          }
        }

        const dbPatch: { sl?: number | null; tp?: number | null } = {}
        if (!tpOnly && target.stoploss > 0 && safe.slApplied) dbPatch.sl = safe.appliedSl
        if (!slOnly && target.takeprofit > 0 && safe.tpApplied) dbPatch.tp = safe.appliedTp
        if (Object.keys(dbPatch).length > 0) {
          await supabase.from('trades').update(dbPatch).eq('id', tr.id)
        }

        const tpReassigned = safe.tpApplied
          && (modifyArgs.takeprofit ?? 0) > 0
          && safe.appliedTp !== (modifyArgs.takeprofit ?? 0)
        await supabase.from('trade_execution_logs').insert({
          user_id: userId,
          signal_id: signalId,
          broker_account_id: brokerId,
          action: 'mgmt_modify',
          status: 'success',
          request_payload: {
            ticket,
            action: 'modify',
            target_sl: safe.slApplied ? safe.appliedSl : null,
            target_tp: safe.tpApplied ? safe.appliedTp : null,
            requested_tp: modifyArgs.takeprofit ?? null,
            modify_mode: safe.mode,
            tp_reassigned: tpReassigned,
            tp_deferred: !safe.tpApplied && (modifyArgs.takeprofit ?? 0) > 0,
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
          const diagnostic = buildMgmtModifyFailureDiagnostic({ message: msg })
          await supabase.from('trade_execution_logs').insert({
            user_id: userId,
            signal_id: signalId,
            broker_account_id: brokerId,
            action: 'mgmt_modify',
            status: 'failed',
            error_message: msg,
            request_payload: {
              ticket,
              trade_id: tr.id,
              channel_stop_apply: true,
              ...mgmtModifyFailurePayload(diagnostic),
            } as unknown as Record<string, unknown>,
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

  await parallelMap(
    [...rowsByBrokerSignal.entries()],
    mgmtBasketConcurrency(),
    processOneBasket,
  )

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
    if (r.openLegs === 0 && r.errors.length === 0) continue
    try {
      const failurePayload = r.fullySynced ? {} : mgmtModifySummaryFailurePayload(r)
      const retryPending = mgmtModifySummaryRetryPending(r)
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
          retry_expected: retryPending,
          retry_pending: retryPending,
          reconcile_requested: !r.fullySynced && r.openLegs > 0,
          skip_reasons: r.errors.map(e => e.skipReason ?? buildMgmtModifyFailureDiagnostic({ message: e.message }).failure_reason),
          ...failurePayload,
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
