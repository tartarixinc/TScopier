import { createHash } from 'node:crypto'
import type { LayeringPlanSnapshot } from '../manualPlanning/types'
import {
  activateLayeringPlanWithLegs,
  computeLayeringPlanFingerprint,
  parsePersistedLayeringPlan,
  type ExecutableLayerPlanLegRow,
  type LayerPlanPersistenceReason,
} from '../manualPlanning/layeringPlanPersistence'
import { resolveLayeringModeRolloutDecision } from '../manualPlanning/layeringModeRollout'
import { resolveNativePendingCapability } from '../layeringBrokerCapability'
import { markLayeringPlanInvalid } from '../layeringPlanLifecycle'
import {
  isOrderOpTimedOutMessage,
  type MtOperation,
  type OrderResult,
  type OrderSendArgs,
} from '../fxsocketClient'
import { isInvalidStopsMessage } from '../brokerTradeError'
import { clampOrderStops, roundLot } from './helpers'
import type { PreparedEntry } from './entryPrepare'

export type LayeringBrokerPendingReason =
  | 'broker_pending_unsupported'
  | 'broker_pending_conflict'
  | 'broker_pending_ambiguous_unreconciled'
  | 'broker_pending_reconciliation_pending'
  | 'broker_pending_manual_review_required'
  | 'broker_pending_already_confirmed'
  | 'broker_pending_not_sendable'
  | 'broker_pending_invalid_price'
  | 'broker_pending_invalid_lot'
  | 'broker_pending_min_distance'
  | 'broker_pending_quote_unavailable'
  | 'broker_pending_send_failed'
  | 'broker_pending_rejected_stops'
  | 'broker_pending_activation_failed'
  | 'broker_pending_blocked'
  | 'broker_pending_claim_lost'
  | 'broker_pending_confirm_failed'

export type LayeringBrokerPendingResult =
  | { readonly ok: true; readonly outcome: 'activated' | 'already_active'; readonly placed: number; readonly adopted: number }
  | { readonly ok: false; readonly reason: LayeringBrokerPendingReason | LayerPlanPersistenceReason }

function nowIso(): string {
  return new Date().toISOString()
}

export function brokerPendingOperationForLayer(side: 'buy' | 'sell'): MtOperation {
  return side === 'buy' ? 'BuyLimit' : 'SellLimit'
}

export function buildLayeringBrokerPendingClientReference(args: {
  readonly planId: string
  readonly stepIdx: number
  readonly brokerAccountId: string
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({
      v: 'layering-native-pending-v1',
      p: args.planId,
      s: args.stepIdx,
      b: args.brokerAccountId,
    }), 'utf8')
    .digest('base64url')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16)
  return `layer_${digest}_${Math.max(0, Math.floor(args.stepIdx))}`
}

function readString(row: unknown, ...keys: string[]): string | null {
  if (!row || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function readNumber(row: unknown, ...keys: string[]): number | null {
  if (!row || typeof row !== 'object') return null
  const rec = row as Record<string, unknown>
  for (const key of keys) {
    const n = Number(rec[key])
    if (Number.isFinite(n)) return n
  }
  return null
}

export function findBrokerOrderByClientReference(openedOrders: readonly unknown[], reference: string): unknown | null {
  return openedOrders.find(row => readString(row, 'comment', 'Comment', 'clientReference', 'client_reference') === reference) ?? null
}

export function brokerOrderMatchesLayer(args: {
  readonly order: unknown
  readonly symbol: string
  readonly operation: MtOperation
  readonly price: number
  readonly lot: number
  readonly digits: number
}): boolean {
  const symbol = readString(args.order, 'symbol', 'Symbol')
  const op = readString(args.order, 'operation', 'Operation', 'orderType', 'OrderType', 'type', 'Type')
  const price = readNumber(args.order, 'openPrice', 'OpenPrice', 'price', 'Price')
  const lots = readNumber(args.order, 'lots', 'Lots', 'volume', 'Volume')
  const ticket = readNumber(args.order, 'ticket', 'Ticket', 'order', 'Order')
  const round = (n: number) => Number(n.toFixed(args.digits))
  const normalizedOp = op?.replace(/[^A-Za-z]/g, '').toLowerCase()
  const expectedOp = args.operation.toLowerCase()
  return (
    ticket != null
    && symbol?.toUpperCase() === args.symbol.toUpperCase()
    && (op === args.operation || normalizedOp === expectedOp || normalizedOp?.endsWith(expectedOp) === true)
    && price != null
    && round(price) === round(args.price)
    && lots != null
    && Number(lots.toFixed(8)) === Number(args.lot.toFixed(8))
  )
}

function ticketFromOrder(order: unknown): number | null {
  return readNumber(order, 'ticket', 'Ticket', 'order', 'Order')
}

export function validateBrokerPendingPrice(args: {
  readonly side: 'buy' | 'sell'
  readonly price: number
  readonly bid: number
  readonly ask: number
  readonly point: number
  readonly stopsLevel: number
  readonly freezeLevel: number
}): LayeringBrokerPendingReason | null {
  if (!Number.isFinite(args.price) || args.price <= 0) return 'broker_pending_invalid_price'
  if (!Number.isFinite(args.bid) || !Number.isFinite(args.ask) || args.bid <= 0 || args.ask <= 0) {
    return 'broker_pending_quote_unavailable'
  }
  const point = Number(args.point)
  const minDistance = point > 0
    ? Math.max(0, Number(args.stopsLevel) || 0, Number(args.freezeLevel) || 0) * point
    : 0
  if (args.side === 'buy') {
    const distance = args.ask - args.price
    return distance > 0 && distance >= minDistance ? null : 'broker_pending_min_distance'
  }
  const distance = args.price - args.bid
  return distance > 0 && distance >= minDistance ? null : 'broker_pending_min_distance'
}

async function reconcileByReference(prep: PreparedEntry, reference: string): Promise<unknown | null> {
  if (!prep.api) return null
  const opened = await prep.api.openedOrders(prep.uuid)
  return findBrokerOrderByClientReference(opened, reference)
}

async function placeOrAdoptPending(args: {
  readonly prep: PreparedEntry
  readonly snapshot: LayeringPlanSnapshot
  readonly row: ExecutableLayerPlanLegRow
  readonly reference: string
  readonly operation: MtOperation
}): Promise<
  | { readonly ok: true; readonly row: ExecutableLayerPlanLegRow; readonly adopted: boolean; readonly ticket: number }
  | { readonly ok: false; readonly reason: LayeringBrokerPendingReason }
> {
  const { prep, row } = args
  const digits = Math.max(0, Math.min(8, Number(prep.params?.digits) || 5))
  let existing: unknown | null
  try {
    existing = await reconcileByReference(prep, args.reference)
  } catch {
    return { ok: false, reason: 'broker_pending_reconciliation_pending' }
  }
  if (existing) {
    if (!brokerOrderMatchesLayer({
      order: existing,
      symbol: prep.symbol,
      operation: args.operation,
      price: row.trigger_price,
      lot: row.volume,
      digits,
    })) {
      return { ok: false, reason: 'broker_pending_conflict' }
    }
    const ticket = ticketFromOrder(existing)
    if (ticket == null || ticket <= 0) return { ok: false, reason: 'broker_pending_conflict' }
    const iso = nowIso()
    return {
      ok: true,
      adopted: true,
      ticket,
      row: {
        ...row,
        ticket: String(ticket),
        broker_client_reference: args.reference,
        broker_pending_type: args.operation,
        last_reconciled_at: iso,
        broker_pending_reason: 'already_placed_matching',
      },
    }
  }

  const q = await prep.api.quote(prep.uuid, prep.symbol).catch(() => null)
  if (!q) return { ok: false, reason: 'broker_pending_quote_unavailable' }
  const priceReason = validateBrokerPendingPrice({
    side: args.snapshot.side,
    price: row.trigger_price,
    bid: q.bid,
    ask: q.ask,
    point: Number(prep.params?.point) || 0,
    stopsLevel: Number(prep.params?.stopsLevel) || 0,
    freezeLevel: Number(prep.params?.freezeLevel) || 0,
  })
  if (priceReason) return { ok: false, reason: priceReason }
  const roundedLot = roundLot(row.volume, prep.params)
  if (Number(roundedLot.toFixed(8)) !== Number(row.volume.toFixed(8))) {
    return { ok: false, reason: 'broker_pending_invalid_lot' }
  }

  const plannedSl = row.stoploss != null && Number(row.stoploss) > 0 ? Number(row.stoploss) : 0
  const plannedTp = row.takeprofit != null && Number(row.takeprofit) > 0 ? Number(row.takeprofit) : 0
  const sendArgs: OrderSendArgs = {
    symbol: prep.symbol,
    operation: args.operation,
    volume: row.volume,
    price: row.trigger_price,
    stoploss: plannedSl,
    takeprofit: plannedTp,
    slippage: row.slippage,
    comment: args.reference,
    expertID: row.expert_id ?? 909090,
  }
  const clamped = clampOrderStops(sendArgs, prep.params)
  let result: OrderResult | null = null
  let sendErrMsg: string | null = null
  try {
    result = await prep.api.orderSend(prep.uuid, clamped.args)
  } catch (err) {
    sendErrMsg = err instanceof Error ? err.message : String(err)
  }
  if (!result) {
    const msg = sendErrMsg ?? 'broker_pending_send_failed'
    if (isInvalidStopsMessage(msg)) {
      // The broker refused the protective stop. Do not resend without it: fail
      // the pending order and surface the reason.
      console.warn(
        `[tradeExecutor] broker pending rejected stops signal=${args.prep.signal.id}`
        + ` symbol=${prep.symbol}: ${msg}`,
      )
      return { ok: false, reason: 'broker_pending_rejected_stops' }
    }
    if (isOrderOpTimedOutMessage(msg)) {
      const reconciled = await reconcileByReference(prep, args.reference).catch(() => null)
      if (reconciled && brokerOrderMatchesLayer({
        order: reconciled,
        symbol: prep.symbol,
        operation: args.operation,
        price: row.trigger_price,
        lot: row.volume,
        digits,
      })) {
        const ticket = ticketFromOrder(reconciled)
        if (ticket != null && ticket > 0) {
          const iso = nowIso()
          return {
            ok: true,
            adopted: true,
            ticket,
            row: {
              ...row,
              ticket: String(ticket),
              broker_client_reference: args.reference,
              broker_pending_type: args.operation,
              submitted_at: iso,
              confirmed_at: iso,
              last_reconciled_at: iso,
              broker_pending_reason: 'ambiguous_reconciled',
            },
          }
        }
      }
      return { ok: false, reason: 'broker_pending_ambiguous_unreconciled' }
    }
    return { ok: false, reason: 'broker_pending_send_failed' }
  }
  const ticket = Number(result.ticket)
  if (!Number.isFinite(ticket) || ticket <= 0) return { ok: false, reason: 'broker_pending_send_failed' }
  const iso = nowIso()
  return {
    ok: true,
    adopted: false,
    ticket,
    row: {
      ...row,
      ticket: String(ticket),
      broker_client_reference: args.reference,
      broker_pending_type: args.operation,
      submitted_at: iso,
      confirmed_at: iso,
      last_reconciled_at: iso,
      broker_pending_reason: 'placed',
    },
  }
}

type PersistedNativePendingLegRow = ExecutableLayerPlanLegRow & {
  readonly id: string
  readonly native_submission_status?: string | null
  readonly submission_claimed_by?: string | null
  readonly submission_attempt?: number | null
  readonly reconciliation_claimed_by?: string | null
}

const NATIVE_FIRST_SEND_STATUSES = ['planned'] as const
const NATIVE_RECONCILIATION_STATUSES = ['submission_claimed', 'submission_ambiguous', 'reconciliation_required', 'submitted'] as const

function claimOwner(): string {
  return `layering-native:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function legSelectColumns(): string {
  return [
    'id',
    'layer_plan_id',
    'layer_plan_metadata',
    'signal_id',
    'user_id',
    'broker_account_id',
    'metaapi_account_id',
    'symbol',
    'step_idx',
    'is_buy',
    'volume',
    'anchor_price',
    'trigger_price',
    'stoploss',
    'takeprofit',
    'slippage',
    'comment',
    'expert_id',
    'expires_at',
    'ticket',
    'cwe_close_price',
    'broker_client_reference',
    'broker_pending_type',
    'native_submission_status',
    'submission_claimed_at',
    'submission_claimed_by',
    'submission_attempt',
    'submitted_at',
    'confirmed_at',
    'last_reconciled_at',
    'broker_pending_reason',
    'reconciliation_reason',
    'reconciliation_claimed_at',
    'reconciliation_claimed_by',
    'cancellation_status',
    'status',
  ].join(',')
}

async function loadNativePendingRows(prep: PreparedEntry, snapshot: LayeringPlanSnapshot): Promise<PersistedNativePendingLegRow[] | null> {
  const { data, error } = await prep.ctx.supabase
    .from('range_pending_legs')
    .select(legSelectColumns())
    .eq('layer_plan_id', snapshot.planId)
    .eq('broker_account_id', snapshot.brokerAccountId)
    .eq('status', 'broker_pending')
    .order('step_idx', { ascending: true })
  if (error) return null
  return (data ?? []) as unknown as PersistedNativePendingLegRow[]
}

async function markNativeLegBlocked(prep: PreparedEntry, row: PersistedNativePendingLegRow, reason: string): Promise<void> {
  await prep.ctx.supabase
    .from('range_pending_legs')
    .update({
      native_submission_status: 'planned',
      submission_claimed_by: null,
      reconciliation_reason: reason,
      broker_pending_reason: reason,
    })
    .eq('id', row.id)
    .eq('native_submission_status', 'submission_claimed')
}

async function claimNativeLegForSend(args: {
  readonly prep: PreparedEntry
  readonly row: PersistedNativePendingLegRow
  readonly reference: string
  readonly operation: MtOperation
  readonly owner: string
}): Promise<PersistedNativePendingLegRow | null> {
  const { data, error } = await args.prep.ctx.supabase
    .from('range_pending_legs')
    .update({
      native_submission_status: 'submission_claimed',
      broker_client_reference: args.reference,
      broker_pending_type: args.operation,
      submission_claimed_at: nowIso(),
      submission_claimed_by: args.owner,
      submission_attempt: Number(args.row.submission_attempt ?? 0) + 1,
      reconciliation_reason: null,
    })
    .eq('id', args.row.id)
    .eq('status', 'broker_pending')
    .in('native_submission_status', [...NATIVE_FIRST_SEND_STATUSES])
    .select(legSelectColumns())
    .maybeSingle()
  if (error || !data) return null
  return data as unknown as PersistedNativePendingLegRow
}

async function confirmNativeLeg(args: {
  readonly prep: PreparedEntry
  readonly row: PersistedNativePendingLegRow
  readonly owner: string
  readonly reference: string
  readonly operation: MtOperation
  readonly ticket: number
  readonly reason: string
  readonly adopted: boolean
}): Promise<boolean> {
  const iso = nowIso()
  const { data, error } = await args.prep.ctx.supabase
    .from('range_pending_legs')
    .update({
      ticket: String(args.ticket),
      broker_client_reference: args.reference,
      broker_pending_type: args.operation,
      native_submission_status: 'confirmed',
      submitted_at: args.adopted ? null : iso,
      confirmed_at: iso,
      last_reconciled_at: iso,
      broker_pending_reason: args.reason,
      reconciliation_reason: null,
      reconciliation_claimed_at: null,
      reconciliation_claimed_by: null,
    })
    .eq('id', args.row.id)
    .eq('status', 'broker_pending')
    .eq('submission_claimed_by', args.owner)
    .eq('native_submission_status', 'submission_claimed')
    .select('id')
    .maybeSingle()
  return !error && Boolean(data)
}

async function markNativeLegAmbiguous(args: {
  readonly prep: PreparedEntry
  readonly row: PersistedNativePendingLegRow
  readonly owner: string
  readonly reference: string
  readonly operation: MtOperation
  readonly reason: string
}): Promise<void> {
  await args.prep.ctx.supabase
    .from('range_pending_legs')
    .update({
      broker_client_reference: args.reference,
      broker_pending_type: args.operation,
      native_submission_status: 'reconciliation_required',
      reconciliation_reason: args.reason,
      broker_pending_reason: args.reason,
      last_reconciled_at: nowIso(),
      reconciliation_claimed_at: null,
      reconciliation_claimed_by: null,
    })
    .eq('id', args.row.id)
    .eq('submission_claimed_by', args.owner)
}

async function markNativeLegReconciliationPending(args: {
  readonly prep: PreparedEntry
  readonly row: PersistedNativePendingLegRow
  readonly reference: string
  readonly operation: MtOperation
  readonly reason: string
  readonly status?: 'reconciliation_required' | 'manual_review'
}): Promise<void> {
  await args.prep.ctx.supabase
    .from('range_pending_legs')
    .update({
      broker_client_reference: args.reference,
      broker_pending_type: args.operation,
      native_submission_status: args.status ?? 'reconciliation_required',
      reconciliation_reason: args.reason,
      broker_pending_reason: args.reason,
      last_reconciled_at: nowIso(),
      reconciliation_claimed_at: null,
      reconciliation_claimed_by: null,
    })
    .eq('id', args.row.id)
    .eq('status', 'broker_pending')
}

export async function reconcileNativePendingLegByReference(args: {
  readonly prep: PreparedEntry
  readonly snapshot: LayeringPlanSnapshot
  readonly row: PersistedNativePendingLegRow
  readonly reference: string
  readonly operation: MtOperation
  readonly owner?: string
  readonly manualReviewOnMissingReference?: boolean
}): Promise<
  | { readonly ok: true; readonly outcome: 'reconciliation_adopted' | 'already_confirmed'; readonly ticket: number | null }
  | { readonly ok: false; readonly reason: LayeringBrokerPendingReason; readonly outcome: 'reconciliation_conflict' | 'reconciliation_pending' | 'manual_review_required' | 'not_sendable' }
> {
  const status = String(args.row.native_submission_status ?? '')
  if (status === 'confirmed' && args.row.ticket) {
    return { ok: true, outcome: 'already_confirmed', ticket: Number(args.row.ticket) || null }
  }
  if (!NATIVE_RECONCILIATION_STATUSES.includes(status as typeof NATIVE_RECONCILIATION_STATUSES[number])) {
    return { ok: false, outcome: 'not_sendable', reason: 'broker_pending_not_sendable' }
  }

  let existing: unknown | null
  try {
    existing = await reconcileByReference(args.prep, args.reference)
  } catch {
    await markNativeLegReconciliationPending({ prep: args.prep, row: args.row, reference: args.reference, operation: args.operation, reason: 'broker_pending_reconciliation_pending' })
    return { ok: false, outcome: 'reconciliation_pending', reason: 'broker_pending_reconciliation_pending' }
  }
  const digits = Math.max(0, Math.min(8, Number(args.prep.params?.digits) || 5))
  if (!existing) {
    await markNativeLegReconciliationPending({
      prep: args.prep,
      row: args.row,
      reference: args.reference,
      operation: args.operation,
      reason: 'manual_review_required',
      status: args.manualReviewOnMissingReference ? 'manual_review' : 'reconciliation_required',
    })
    return { ok: false, outcome: 'manual_review_required', reason: 'broker_pending_manual_review_required' }
  }
  if (!brokerOrderMatchesLayer({
    order: existing,
    symbol: args.prep.symbol,
    operation: args.operation,
    price: args.row.trigger_price,
    lot: args.row.volume,
    digits,
  })) {
    await markNativeLegReconciliationPending({ prep: args.prep, row: args.row, reference: args.reference, operation: args.operation, reason: 'broker_pending_conflict' })
    await markLayeringPlanInvalid(args.prep.ctx.supabase, args.snapshot.planId, 'broker_pending_conflict')
    return { ok: false, outcome: 'reconciliation_conflict', reason: 'broker_pending_conflict' }
  }
  const ticket = ticketFromOrder(existing)
  if (ticket == null || ticket <= 0) {
    await markNativeLegReconciliationPending({ prep: args.prep, row: args.row, reference: args.reference, operation: args.operation, reason: 'broker_pending_conflict' })
    await markLayeringPlanInvalid(args.prep.ctx.supabase, args.snapshot.planId, 'broker_pending_conflict')
    return { ok: false, outcome: 'reconciliation_conflict', reason: 'broker_pending_conflict' }
  }
  const confirmed = await confirmNativeLeg({
    prep: args.prep,
    row: args.row,
    owner: args.owner ?? String(args.row.submission_claimed_by ?? ''),
    reference: args.reference,
    operation: args.operation,
    ticket,
    reason: 'ambiguous_reconciled',
    adopted: true,
  })
  if (!confirmed) {
    await args.prep.ctx.supabase
      .from('range_pending_legs')
      .update({
        ticket: String(ticket),
        broker_client_reference: args.reference,
        broker_pending_type: args.operation,
        native_submission_status: 'confirmed',
        confirmed_at: nowIso(),
        last_reconciled_at: nowIso(),
        broker_pending_reason: 'ambiguous_reconciled',
        reconciliation_reason: null,
        reconciliation_claimed_at: null,
        reconciliation_claimed_by: null,
      })
      .eq('id', args.row.id)
      .eq('status', 'broker_pending')
      .in('native_submission_status', [...NATIVE_RECONCILIATION_STATUSES])
  }
  return { ok: true, outcome: 'reconciliation_adopted', ticket }
}

async function planStillActive(prep: PreparedEntry, snapshot: LayeringPlanSnapshot): Promise<boolean> {
  const { data, error } = await prep.ctx.supabase
    .from('layering_plans')
    .select('status,semantic_fingerprint,layer_plan_metadata')
    .eq('layer_plan_id', snapshot.planId)
    .eq('broker_account_id', snapshot.brokerAccountId)
    .maybeSingle()
  if (error || !data) return false
  const row = data as { status?: unknown; semantic_fingerprint?: unknown; layer_plan_metadata?: unknown }
  if (String(row.status ?? '') !== 'active') return false
  const parsed = parsePersistedLayeringPlan(row.layer_plan_metadata)
  if (!parsed.ok) return false
  const expectedFingerprint = computeLayeringPlanFingerprint(snapshot)
  const persistedFingerprint = computeLayeringPlanFingerprint(parsed.snapshot)
  return (
    expectedFingerprint != null
    && persistedFingerprint === expectedFingerprint
    && row.semantic_fingerprint === expectedFingerprint
    && parsed.snapshot.planId === snapshot.planId
    && parsed.snapshot.signalId === snapshot.signalId
    && parsed.snapshot.brokerAccountId === snapshot.brokerAccountId
    && parsed.snapshot.symbol === snapshot.symbol
    && parsed.snapshot.side === snapshot.side
    && parsed.snapshot.mode === snapshot.mode
  )
}

async function placeOrAdoptClaimedPending(args: {
  readonly prep: PreparedEntry
  readonly snapshot: LayeringPlanSnapshot
  readonly row: PersistedNativePendingLegRow
  readonly reference: string
  readonly operation: MtOperation
  readonly owner: string
}): Promise<
  | { readonly ok: true; readonly adopted: boolean; readonly ticket: number }
  | { readonly ok: false; readonly reason: LayeringBrokerPendingReason }
> {
  const { prep, row } = args
  if (String(row.native_submission_status ?? '') !== 'submission_claimed') {
    const reconciled = await reconcileNativePendingLegByReference(args)
    return reconciled.ok
      ? { ok: true, adopted: true, ticket: reconciled.ticket ?? 0 }
      : { ok: false, reason: reconciled.reason }
  }
  const preSendDecision = resolveLayeringModeRolloutDecision({ mode: args.snapshot.mode, brokerAccountId: prep.broker.id })
  const active = await planStillActive(prep, args.snapshot)
  if (!preSendDecision.executionAllowed || preSendDecision.reason !== 'allowed' || !active) {
    await markNativeLegBlocked(prep, row, active ? preSendDecision.reason : 'plan_not_active')
    return { ok: false, reason: 'broker_pending_blocked' }
  }
  const existing = await reconcileByReference(prep, args.reference)
  const digits = Math.max(0, Math.min(8, Number(prep.params?.digits) || 5))
  if (existing) {
    if (!brokerOrderMatchesLayer({
      order: existing,
      symbol: prep.symbol,
      operation: args.operation,
      price: row.trigger_price,
      lot: row.volume,
      digits,
    })) {
      await markNativeLegAmbiguous({ prep, row, owner: args.owner, reference: args.reference, operation: args.operation, reason: 'broker_pending_conflict' })
      await markLayeringPlanInvalid(prep.ctx.supabase, args.snapshot.planId, 'broker_pending_conflict')
      return { ok: false, reason: 'broker_pending_conflict' }
    }
    const ticket = ticketFromOrder(existing)
    if (ticket == null || ticket <= 0) return { ok: false, reason: 'broker_pending_conflict' }
    const confirmed = await confirmNativeLeg({ prep, row, owner: args.owner, reference: args.reference, operation: args.operation, ticket, reason: 'already_placed_matching', adopted: true })
    if (!confirmed) {
      await markNativeLegAmbiguous({ prep, row, owner: args.owner, reference: args.reference, operation: args.operation, reason: 'broker_pending_confirm_failed' })
      return { ok: false, reason: 'broker_pending_confirm_failed' }
    }
    return { ok: true, adopted: true, ticket }
  }

  const placed = await placeOrAdoptPending({ prep, snapshot: args.snapshot, row, reference: args.reference, operation: args.operation })
  if (!placed.ok) {
    await markNativeLegAmbiguous({ prep, row, owner: args.owner, reference: args.reference, operation: args.operation, reason: placed.reason })
    if (placed.reason === 'broker_pending_conflict') {
      await markLayeringPlanInvalid(prep.ctx.supabase, args.snapshot.planId, placed.reason)
    }
    return placed
  }
  const confirmed = await confirmNativeLeg({
    prep,
    row,
    owner: args.owner,
    reference: args.reference,
    operation: args.operation,
    ticket: placed.ticket,
    reason: placed.adopted ? 'ambiguous_reconciled' : 'placed',
    adopted: placed.adopted,
  })
  if (!confirmed) {
    await markNativeLegAmbiguous({ prep, row, owner: args.owner, reference: args.reference, operation: args.operation, reason: 'broker_pending_confirm_failed' })
    return { ok: false, reason: 'broker_pending_confirm_failed' }
  }
  return { ok: true, adopted: placed.adopted, ticket: placed.ticket }
}

export async function activateLayeringBrokerPendingOrders(args: {
  readonly prep: PreparedEntry
  readonly snapshot: LayeringPlanSnapshot
  readonly skipFirstLayer: boolean
  readonly firstFill?: {
    readonly entryPrice: number | null
    readonly lot: number | null
    readonly tradeRowId: string | null
    readonly ticket: number | null
  }
}): Promise<LayeringBrokerPendingResult> {
  const { prep, snapshot } = args
  if (!prep.api) return { ok: false, reason: 'broker_pending_unsupported' }
  if (prep.manual.range_layering_type !== 'pending_order') return { ok: false, reason: 'broker_pending_blocked' }
  const capability = resolveNativePendingCapability({
    broker: prep.broker as { platform?: string; fxsocket_account_id?: string; metaapi_account_id?: string; connection_status?: string; terminal_connected?: boolean; trade_allowed?: boolean },
    api: prep.api,
  })
  if (!capability.supported) return { ok: false, reason: 'broker_pending_unsupported' }
  const decision = resolveLayeringModeRolloutDecision({ mode: snapshot.mode, brokerAccountId: prep.broker.id })
  if (!decision.executionAllowed || !decision.activationAllowed || decision.reason !== 'allowed') {
    return { ok: false, reason: 'broker_pending_blocked' }
  }

  const operation = brokerPendingOperationForLayer(snapshot.side)
  const placedTickets: number[] = []
  let adopted = 0
  const activated = await activateLayeringPlanWithLegs(prep.ctx.supabase, snapshot, {
    executionMechanism: 'pending_order',
    excludeFirstLayer: args.skipFirstLayer,
    legContext: {
      user_id: prep.signal.user_id,
      signal_id: snapshot.signalId,
      broker_account_id: snapshot.brokerAccountId,
      metaapi_account_id: prep.uuid,
      stoploss: Number(prep.legs[0]?.args.stoploss) > 0 ? Number(prep.legs[0]?.args.stoploss) : null,
      takeprofit: Number(prep.legs[0]?.args.takeprofit) > 0 ? Number(prep.legs[0]?.args.takeprofit) : null,
      slippage: Number(prep.legs[0]?.args.slippage) || 20,
      comment: prep.commentPrefix,
      expert_id: Number(prep.legs[0]?.args.expertID) || 909090,
      broker_pending_type: operation,
      first_execution_trade_id: args.firstFill?.tradeRowId ?? null,
      first_execution_order_id: args.firstFill?.ticket != null ? String(args.firstFill.ticket) : null,
      first_execution_status: args.firstFill ? 'confirmed' : null,
      first_execution_fill_price: args.firstFill?.entryPrice ?? null,
      first_execution_filled_lot: args.firstFill?.lot ?? null,
      first_execution_confirmed_at: args.firstFill ? nowIso() : null,
    },
  })
  if (!activated.ok) {
    return { ok: false, reason: activated.reason === 'activation_failed' ? 'broker_pending_activation_failed' : activated.reason }
  }
  const persistedRows = await loadNativePendingRows(prep, snapshot)
  if (!persistedRows) return { ok: false, reason: 'broker_pending_activation_failed' }

  for (const row of persistedRows) {
    const loopDecision = resolveLayeringModeRolloutDecision({ mode: snapshot.mode, brokerAccountId: prep.broker.id })
    if (!loopDecision.executionAllowed || loopDecision.reason !== 'allowed') {
      return { ok: false, reason: 'broker_pending_blocked' }
    }
    const reference = buildLayeringBrokerPendingClientReference({
      planId: snapshot.planId,
      stepIdx: row.step_idx,
      brokerAccountId: prep.broker.id,
    })
    if (row.native_submission_status === 'confirmed' && row.ticket) continue
    if (NATIVE_RECONCILIATION_STATUSES.includes(String(row.native_submission_status ?? '') as typeof NATIVE_RECONCILIATION_STATUSES[number])) {
      const reconciled = await reconcileNativePendingLegByReference({ prep, snapshot, row, reference, operation })
      if (reconciled.ok) {
        adopted += reconciled.outcome === 'reconciliation_adopted' ? 1 : 0
        continue
      }
      return { ok: false, reason: reconciled.reason }
    }
    if (String(row.native_submission_status ?? '') !== 'planned') {
      return { ok: false, reason: 'broker_pending_not_sendable' }
    }
    const owner = claimOwner()
    const claimed = await claimNativeLegForSend({ prep, row, reference, operation, owner })
    if (!claimed) return { ok: false, reason: 'broker_pending_claim_lost' }
    const placed = await placeOrAdoptClaimedPending({ prep, snapshot, row: claimed, reference, operation, owner })
    if (!placed.ok) {
      return { ok: false, reason: placed.reason }
    }
    if (placed.adopted) adopted += 1
    else placedTickets.push(placed.ticket)
  }
  return { ok: true, outcome: activated.outcome, placed: placedTickets.length, adopted }
}
