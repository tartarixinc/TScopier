import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient, MtOperation } from '../fxsocketClient'
import { computeLayeringPlanFingerprint, parsePersistedLayeringPlan } from '../manualPlanning/layeringPlanPersistence'
import type { LayeringPlanSnapshot } from '../manualPlanning/types'
import {
  brokerPendingOperationForLayer,
  buildLayeringBrokerPendingClientReference,
  reconcileNativePendingLegByReference,
} from './layeringModeBrokerPending'
import type { PreparedEntry } from './entryPrepare'

const RECOVERY_STATUSES = ['submission_claimed', 'submission_ambiguous', 'reconciliation_required', 'submitted'] as const
const DEFAULT_RECOVERY_LEASE_TIMEOUT_MS = 5 * 60 * 1000

type RecoveryRow = {
  id: string
  layer_plan_id: string | null
  layer_plan_metadata: unknown | null
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  step_idx: number
  is_buy: boolean
  volume: number
  trigger_price: number
  ticket?: string | null
  broker_client_reference?: string | null
  broker_pending_type?: string | null
  native_submission_status?: string | null
  submission_claimed_by?: string | null
  reconciliation_claimed_at?: string | null
  reconciliation_claimed_by?: string | null
}

export type NativeRecoveryOutcome =
  | 'none'
  | 'reconciliation_adopted'
  | 'reconciliation_pending'
  | 'manual_review_required'
  | 'reconciliation_conflict'
  | 'claim_lost'
  | 'invalid'
  | 'unsupported'

function nowIso(): string {
  return new Date().toISOString()
}

function recoveryLeaseTimeoutMs(): number {
  const raw = Number(process.env.LAYERING_NATIVE_RECOVERY_LEASE_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 60 * 60 * 1000) : DEFAULT_RECOVERY_LEASE_TIMEOUT_MS
}

function recoveryLeaseExpired(row: RecoveryRow, nowMs = Date.now()): boolean {
  if (!row.reconciliation_claimed_by) return true
  if (!row.reconciliation_claimed_at) return false
  const claimedAt = Date.parse(row.reconciliation_claimed_at)
  return Number.isFinite(claimedAt) && claimedAt <= nowMs - recoveryLeaseTimeoutMs()
}

function planMatchesRow(snapshot: LayeringPlanSnapshot, row: RecoveryRow, fingerprint: unknown): boolean {
  const expected = computeLayeringPlanFingerprint(snapshot)
  if (!expected || fingerprint !== expected) return false
  const idx = row.step_idx - 1
  return (
    snapshot.planId === row.layer_plan_id
    && snapshot.signalId === row.signal_id
    && snapshot.brokerAccountId === row.broker_account_id
    && snapshot.symbol === row.symbol
    && (snapshot.side === 'buy') === row.is_buy
    && snapshot.fundedPrices != null
    && snapshot.lots != null
    && idx >= 0
    && snapshot.fundedPrices[idx] === row.trigger_price
    && snapshot.lots[idx] === row.volume
  )
}

async function claimRecovery(supabase: SupabaseClient, row: RecoveryRow, owner: string): Promise<boolean> {
  const patch = {
    native_submission_status: 'reconciliation_required',
    reconciliation_claimed_at: nowIso(),
    reconciliation_claimed_by: owner,
    reconciliation_reason: 'startup_recovery',
  }
  const first = await supabase
    .from('range_pending_legs')
    .update(patch)
    .eq('id', row.id)
    .eq('status', 'broker_pending')
    .in('native_submission_status', [...RECOVERY_STATUSES])
    .is('reconciliation_claimed_by', null)
    .select('id')
    .maybeSingle()
  if (!first.error && first.data) return true

  if (!recoveryLeaseExpired(row)) return false
  if (!row.reconciliation_claimed_by || !row.reconciliation_claimed_at) return false

  const { data, error } = await supabase
    .from('range_pending_legs')
    .update(patch)
    .eq('id', row.id)
    .eq('status', 'broker_pending')
    .in('native_submission_status', [...RECOVERY_STATUSES])
    .eq('reconciliation_claimed_by', row.reconciliation_claimed_by)
    .eq('reconciliation_claimed_at', row.reconciliation_claimed_at)
    .select('id')
    .maybeSingle()
  return !error && Boolean(data)
}

function recoveryPrep(args: {
  supabase: SupabaseClient
  api: FxsocketBrokerClient
  row: RecoveryRow
  snapshot: LayeringPlanSnapshot
}): PreparedEntry {
  return {
    api: args.api,
    ctx: { supabase: args.supabase },
    signal: { id: args.snapshot.signalId, user_id: args.row.user_id },
    broker: {
      id: args.snapshot.brokerAccountId,
      platform: 'MT5',
      fxsocket_account_id: args.row.metaapi_account_id,
      connection_status: 'connected',
      trade_allowed: true,
    },
    uuid: args.row.metaapi_account_id,
    symbol: args.snapshot.symbol,
    params: { digits: 8, point: 0.00001, stopsLevel: 0, freezeLevel: 0, minLot: 0.01, maxLot: 100, lotStep: 0.01 },
    manual: { range_layering_type: 'pending_order' },
    commentPrefix: 'UniCopier:recovery',
    legs: [],
  } as unknown as PreparedEntry
}

export async function recoverOneNativeLayeringSubmission(args: {
  readonly supabase: SupabaseClient
  readonly row: RecoveryRow
  readonly api: FxsocketBrokerClient | null
  readonly owner?: string
}): Promise<NativeRecoveryOutcome> {
  const { data: plan, error } = await args.supabase
    .from('layering_plans')
    .select('status,semantic_fingerprint,layer_plan_metadata')
    .eq('layer_plan_id', args.row.layer_plan_id)
    .maybeSingle()
  if (error || !plan) return 'invalid'
  const planStatus = String((plan as { status?: unknown }).status ?? '')
  if (planStatus !== 'active' && planStatus !== 'cancelling' && planStatus !== 'cancellation_pending') return 'none'
  const parsed = parsePersistedLayeringPlan((plan as { layer_plan_metadata?: unknown }).layer_plan_metadata)
  if (!parsed.ok || !planMatchesRow(parsed.snapshot, args.row, (plan as { semantic_fingerprint?: unknown }).semantic_fingerprint)) {
    await args.supabase
      .from('layering_plans')
      .update({ status: 'invalid', cancellation_reason: 'native_recovery_plan_mismatch', updated_at: nowIso() })
      .eq('layer_plan_id', args.row.layer_plan_id)
      .in('status', ['prepared', 'activating', 'active', 'cancelling', 'cancellation_pending'])
    return 'invalid'
  }
  if (!args.api) return 'unsupported'

  const owner = args.owner ?? `layering-recovery:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  if (!await claimRecovery(args.supabase, args.row, owner)) return 'claim_lost'

  const operation = brokerPendingOperationForLayer(parsed.snapshot.side)
  const expectedReference = buildLayeringBrokerPendingClientReference({
    planId: parsed.snapshot.planId,
    stepIdx: args.row.step_idx,
    brokerAccountId: parsed.snapshot.brokerAccountId,
  })
  if (args.row.broker_client_reference && args.row.broker_client_reference !== expectedReference) {
    await args.supabase
      .from('layering_plans')
      .update({ status: 'invalid', cancellation_reason: 'native_recovery_reference_mismatch', updated_at: nowIso() })
      .eq('layer_plan_id', args.row.layer_plan_id)
      .in('status', ['prepared', 'activating', 'active', 'cancelling', 'cancellation_pending'])
    return 'invalid'
  }
  const prep = recoveryPrep({ supabase: args.supabase, api: args.api, row: args.row, snapshot: parsed.snapshot })
  const result = await reconcileNativePendingLegByReference({
    prep,
    snapshot: parsed.snapshot,
    row: {
      ...args.row,
      broker_client_reference: expectedReference,
      broker_pending_type: (args.row.broker_pending_type as MtOperation | null) ?? operation,
      native_submission_status: 'reconciliation_required',
      submission_claimed_by: owner,
    } as never,
    reference: expectedReference,
    operation,
    owner,
    manualReviewOnMissingReference: true,
  })
  if (result.ok) return 'reconciliation_adopted'
  if (result.outcome === 'reconciliation_conflict') return 'reconciliation_conflict'
  if (result.outcome === 'manual_review_required') return 'manual_review_required'
  return 'reconciliation_pending'
}

export async function recoverNativeLayeringSubmissions(args: {
  readonly supabase: SupabaseClient
  readonly apiLookup: (uuid: string) => FxsocketBrokerClient | null
}): Promise<{ scanned: number; recovered: number; unresolved: number; invalid: number }> {
  const { data, error } = await args.supabase
    .from('range_pending_legs')
    .select('id,layer_plan_id,layer_plan_metadata,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,step_idx,is_buy,volume,trigger_price,ticket,broker_client_reference,broker_pending_type,native_submission_status,submission_claimed_by,reconciliation_claimed_at,reconciliation_claimed_by')
    .eq('status', 'broker_pending')
    .in('native_submission_status', [...RECOVERY_STATUSES])
    .limit(100)
  if (error || !data?.length) return { scanned: 0, recovered: 0, unresolved: 0, invalid: 0 }
  let recovered = 0
  let unresolved = 0
  let invalid = 0
  for (const row of data as RecoveryRow[]) {
    if (!row.layer_plan_id) continue
    const outcome = await recoverOneNativeLayeringSubmission({
      supabase: args.supabase,
      row,
      api: args.apiLookup(row.metaapi_account_id),
    })
    if (outcome === 'reconciliation_adopted') recovered += 1
    else if (outcome === 'invalid' || outcome === 'reconciliation_conflict') invalid += 1
    else if (outcome !== 'none' && outcome !== 'claim_lost') unresolved += 1
  }
  return { scanned: data.length, recovered, unresolved, invalid }
}
