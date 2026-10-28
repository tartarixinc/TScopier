import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isValidLayerPlanId,
  LAYERING_PLAN_CALCULATOR_VERSION,
  LAYERING_PLAN_SCHEMA_VERSION,
  parseLayeringPlanSnapshot,
  serializeLayeringPlanSnapshot,
} from './layeringModes'
import type { CalculatedLayerPlanSuccess, LayerPlanReason } from './layeringModeCalculators'
import type { LayeringMode, LayeringPlanSnapshot, LayerPlanAnchorSource, LayerPlanSide } from './types'
import { stableStringify } from '../stableJson'

export type LayerPlanPersistenceStatus =
  | 'prepared'
  | 'activating'
  | 'active'
  | 'entries_complete'
  | 'completed'
  | 'cancelling'
  | 'cancellation_pending'
  | 'cancellation_manual_review'
  | 'cancelled'
  | 'invalid'

export interface LayerPlanIdentity {
  readonly signalId: string
  readonly brokerAccountId: string
  readonly basketKey?: string | null
  readonly symbol: string
  readonly side: LayerPlanSide
  readonly mode: Exclude<LayeringMode, 'legacy'>
}

export interface LayerPlanSnapshotInput extends LayerPlanIdentity {
  readonly planId: string
  readonly calculatedPlan: CalculatedLayerPlanSuccess
  readonly anchorSource: LayerPlanAnchorSource
  readonly configuredStaticLayerCount?: number | null
  readonly configuredDynamicStepPips?: number | null
  readonly configuredDynamicMaxLayers?: number | null
  readonly createdAt: string
  readonly lockedAt?: string | null
}

export type BuildLayeringPlanSnapshotResult =
  | { readonly ok: true; readonly snapshot: LayeringPlanSnapshot }
  | { readonly ok: false; readonly reason: LayerPlanPersistenceReason }

export type LayerPlanPersistenceReason =
  | 'invalid_identity'
  | 'invalid_plan_id'
  | 'invalid_calculated_plan'
  | 'invalid_snapshot'
  | 'created'
  | 'already_exists_matching'
  | 'activation_claimed'
  | 'activated'
  | 'already_activating'
  | 'already_active'
  | 'fingerprint_conflict'
  | 'conflict'
  | 'not_found'
  | 'malformed_metadata'
  | 'unsupported_version'
  | 'identity_mismatch'
  | 'leg_count_mismatch'
  | 'price_mismatch'
  | 'lot_mismatch'
  | 'duplicate_leg'
  | 'terminal_plan'
  | 'invalid_plan'
  | 'unknown_status'
  | 'malformed_existing_plan'
  | 'persistence_failed'
  | 'activation_failed'

export type PersistLayeringPlanResult =
  | { readonly ok: true; readonly outcome: 'created' | 'already_exists_matching'; readonly snapshot: LayeringPlanSnapshot }
  | { readonly ok: false; readonly reason: LayerPlanPersistenceReason }

export type RecoverLayeringPlanResult =
  | { readonly ok: true; readonly outcome: 'recovered'; readonly snapshot: LayeringPlanSnapshot }
  | { readonly ok: false; readonly reason: LayerPlanPersistenceReason }

export interface ProposedLayerPlanLegRow {
  readonly layer_plan_id: string
  readonly layer_plan_metadata: Record<string, unknown>
  readonly signal_id: string
  readonly broker_account_id: string
  readonly symbol: string
  readonly step_idx: number
  readonly is_buy: boolean
  readonly trigger_price: number
  readonly volume: number
  readonly status: 'planned'
}

export interface ExecutableLayerPlanLegRow extends Omit<ProposedLayerPlanLegRow, 'status'> {
  readonly user_id: string
  readonly metaapi_account_id: string
  readonly anchor_price: number
  readonly stoploss: number | null
  readonly takeprofit: number | null
  readonly slippage: number
  readonly comment: string | null
  readonly expert_id: number | null
  readonly expires_at: string | null
  readonly ticket?: string | null
  readonly cwe_close_price?: number | null
  readonly broker_client_reference?: string | null
  readonly broker_pending_type?: string | null
  readonly native_submission_status?: string | null
  readonly submission_claimed_at?: string | null
  readonly submission_claimed_by?: string | null
  readonly submission_attempt?: number | null
  readonly submitted_at?: string | null
  readonly confirmed_at?: string | null
  readonly last_reconciled_at?: string | null
  readonly broker_pending_reason?: string | null
  readonly reconciliation_reason?: string | null
  readonly status: 'pending' | 'broker_pending'
}

export interface ActivateLayeringPlanContext {
  readonly user_id: string
  readonly signal_id: string
  readonly broker_account_id: string
  readonly metaapi_account_id: string
  readonly stoploss: number | null
  readonly takeprofit: number | null
  readonly slippage: number
  readonly comment: string | null
  readonly expert_id?: number | null
  readonly expires_at?: string | null
  readonly cwe_close_price?: number | null
  readonly broker_pending_type?: string | null
  readonly first_execution_trade_id?: string | null
  readonly first_execution_order_id?: string | null
  readonly first_execution_status?: string | null
  readonly first_execution_fill_price?: number | null
  readonly first_execution_filled_lot?: number | null
  readonly first_execution_confirmed_at?: string | null
}

interface ActivateLayeringPlanArgs {
  readonly executionMechanism: 'auto' | 'pending_order'
  readonly excludeFirstLayer: boolean
  readonly legContext: ActivateLayeringPlanContext
}

export interface PersistedLayerPlanRow {
  readonly layer_plan_id: string
  readonly signal_id: string
  readonly broker_account_id: string
  readonly basket_key: string
  readonly mode: 'static' | 'dynamic'
  readonly status: LayerPlanPersistenceStatus
  readonly layer_plan_metadata: unknown
  readonly semantic_fingerprint?: string | null
  readonly created_at: string
  readonly locked_at: string
}

function canonicalIdentityValue(value: unknown, options?: { readonly required?: boolean; readonly normalizeUpper?: boolean }): { readonly kind: 'value'; readonly value: string } | { readonly kind: 'null' } | { readonly kind: 'undefined' } | null {
  if (value == null) {
    if (options?.required) return null
    return value === null ? { kind: 'null' } : { kind: 'undefined' }
  }
  if (typeof value !== 'string') return null
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 32 || code === 127) return null
  }
  const trimmed = value.trim()
  if (options?.required && trimmed.length === 0) return null
  if (trimmed.length > 256) return null
  return { kind: 'value', value: options?.normalizeUpper ? trimmed.toUpperCase() : trimmed }
}

function identityTuple(identity: LayerPlanIdentity): Record<string, unknown> | null {
  const signalId = canonicalIdentityValue(identity.signalId, { required: true })
  const brokerAccountId = canonicalIdentityValue(identity.brokerAccountId, { required: true })
  const basketKey = canonicalIdentityValue(identity.basketKey)
  const symbol = canonicalIdentityValue(identity.symbol, { required: true, normalizeUpper: true })
  if (
    signalId == null
    || brokerAccountId == null
    || basketKey == null
    || symbol == null
    || (identity.side !== 'buy' && identity.side !== 'sell')
    || (identity.mode !== 'static' && identity.mode !== 'dynamic')
  ) return null
  return Object.freeze({
    signalId,
    brokerAccountId,
    basketKey,
    symbol,
    side: identity.side,
    mode: identity.mode,
  })
}

export function generateLayerPlanId(identity: LayerPlanIdentity): string | null {
  const tuple = identityTuple(identity)
  if (tuple == null) return null
  const digest = createHash('sha256')
    .update(stableStringify(tuple), 'utf8')
    .digest('base64url')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 32)
  const planId = `layerplan_${digest}`
  return isValidLayerPlanId(planId) ? planId : null
}

function isoTimestamp(value: string): string | null {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const iso = new Date(ms).toISOString()
  return iso === value ? value : null
}

function uniqueReasons(reasons: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(reasons)])
}

function canonicalSemanticSnapshot(snapshot: LayeringPlanSnapshot): Record<string, unknown> | null {
  const metadata = serializeLayeringPlanSnapshot(snapshot)
  if (metadata == null) return null
  const semantic = { ...metadata }
  delete semantic.createdAt
  delete semantic.lockedAt
  return semantic
}

export function computeLayeringPlanFingerprint(snapshot: LayeringPlanSnapshot): string | null {
  const semantic = canonicalSemanticSnapshot(snapshot)
  if (semantic == null) return null
  return createHash('sha256').update(stableStringify(semantic), 'utf8').digest('base64url')
}

export function areLayeringPlansSemanticallyEqual(a: LayeringPlanSnapshot, b: LayeringPlanSnapshot): boolean {
  const left = computeLayeringPlanFingerprint(a)
  const right = computeLayeringPlanFingerprint(b)
  return left != null && left === right
}

export function buildLayeringPlanSnapshot(input: LayerPlanSnapshotInput): BuildLayeringPlanSnapshotResult {
  if (!isValidLayerPlanId(input.planId)) return { ok: false, reason: 'invalid_plan_id' }
  if (identityTuple(input) == null) return { ok: false, reason: 'invalid_identity' }
  if (!input.calculatedPlan.ok || input.calculatedPlan.mode !== input.mode) return { ok: false, reason: 'invalid_calculated_plan' }
  if (input.calculatedPlan.fundedPrices.length === 0 || input.calculatedPlan.fundedPrices.length !== input.calculatedPlan.lots.length) {
    return { ok: false, reason: 'invalid_calculated_plan' }
  }
  if (input.calculatedPlan.actualLayerCount !== input.calculatedPlan.fundedPrices.length) {
    return { ok: false, reason: 'invalid_calculated_plan' }
  }
  if (input.calculatedPlan.allocatedTotalLot > input.calculatedPlan.intendedTotalLot) {
    return { ok: false, reason: 'invalid_calculated_plan' }
  }
  const createdAt = isoTimestamp(input.createdAt)
  const lockedAt = isoTimestamp(input.lockedAt ?? input.createdAt)
  if (createdAt == null || lockedAt == null || Date.parse(lockedAt) < Date.parse(createdAt)) {
    return { ok: false, reason: 'invalid_snapshot' }
  }

  const snapshot: LayeringPlanSnapshot = {
    schemaVersion: LAYERING_PLAN_SCHEMA_VERSION,
    calculatorVersion: LAYERING_PLAN_CALCULATOR_VERSION,
    planId: input.planId,
    mode: input.mode,
    signalId: input.signalId,
    brokerAccountId: input.brokerAccountId,
    basketKey: input.basketKey?.trim() ?? null,
    symbol: input.symbol.trim().toUpperCase(),
    side: input.side,
    originalRangeLow: input.calculatedPlan.rangeLow,
    originalRangeHigh: input.calculatedPlan.rangeHigh,
    anchorPrice: input.calculatedPlan.rawAnchorPrice,
    executableAnchorPrice: input.calculatedPlan.executableAnchorPrice,
    anchorSource: input.anchorSource,
    configuredStaticLayerCount: input.mode === 'static' ? input.configuredStaticLayerCount ?? input.calculatedPlan.requestedLayerCount : null,
    configuredDynamicStepPips: input.mode === 'dynamic' ? input.configuredDynamicStepPips ?? null : null,
    configuredDynamicMaxLayers: input.mode === 'dynamic' ? input.configuredDynamicMaxLayers ?? input.calculatedPlan.requestedLayerCount : null,
    optimizationStrategy: input.calculatedPlan.optimizationStrategy,
    theoreticalLayerCount: input.calculatedPlan.theoreticalLayerCount,
    effectiveStepPips: input.calculatedPlan.effectiveStepPips,
    requestedLayerPercent: input.calculatedPlan.requestedLayerPercent,
    effectiveLayerPercent: input.calculatedPlan.effectiveLayerPercent,
    allocationPercentTotal: input.calculatedPlan.allocationPercentTotal,
    requestedLayerCount: input.calculatedPlan.requestedLayerCount,
    plannedLayerCount: input.calculatedPlan.actualLayerCount,
    plannedTotalLot: input.calculatedPlan.intendedTotalLot,
    allocatedTotalLot: input.calculatedPlan.allocatedTotalLot,
    unallocatedLot: input.calculatedPlan.unallocatedLot,
    fundedPrices: Object.freeze([...input.calculatedPlan.fundedPrices]),
    lots: Object.freeze([...input.calculatedPlan.lots]),
    reasons: uniqueReasons(input.calculatedPlan.reasons as readonly LayerPlanReason[]),
    createdAt,
    lockedAt,
  }
  const parsed = parseLayeringPlanSnapshot(snapshot)
  return parsed == null ? { ok: false, reason: 'invalid_snapshot' } : { ok: true, snapshot: parsed }
}

export function snapshotsMatch(a: LayeringPlanSnapshot, b: LayeringPlanSnapshot): boolean {
  return areLayeringPlansSemanticallyEqual(a, b)
}

export function parsePersistedLayeringPlan(raw: unknown): RecoverLayeringPlanResult {
  try {
    if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
      const row = raw as { schemaVersion?: unknown; calculatorVersion?: unknown }
      if (row.schemaVersion !== undefined && row.schemaVersion !== LAYERING_PLAN_SCHEMA_VERSION) {
        return { ok: false, reason: 'unsupported_version' }
      }
      if (row.calculatorVersion !== undefined && row.calculatorVersion !== LAYERING_PLAN_CALCULATOR_VERSION) {
        return { ok: false, reason: 'unsupported_version' }
      }
    }
  } catch {
    return { ok: false, reason: 'malformed_metadata' }
  }
  const snapshot = parseLayeringPlanSnapshot(raw)
  if (snapshot == null) return { ok: false, reason: 'malformed_metadata' }
  if (snapshot.mode !== 'static' && snapshot.mode !== 'dynamic') return { ok: false, reason: 'unsupported_version' }
  if (snapshot.schemaVersion !== LAYERING_PLAN_SCHEMA_VERSION || snapshot.calculatorVersion !== LAYERING_PLAN_CALCULATOR_VERSION) {
    return { ok: false, reason: 'unsupported_version' }
  }
  return { ok: true, outcome: 'recovered', snapshot }
}

function normalizeStatus(value: unknown): LayerPlanPersistenceStatus | null {
  return value === 'prepared' || value === 'activating' || value === 'active'
    || value === 'entries_complete' || value === 'completed'
    || value === 'cancelling' || value === 'cancellation_pending' || value === 'cancellation_manual_review'
    || value === 'cancelled' || value === 'invalid'
    ? value
    : null
}

function checkPlanRowStatus(status: LayerPlanPersistenceStatus): LayerPlanPersistenceReason | null {
  if (status === 'prepared' || status === 'activating' || status === 'active') return null
  if (status === 'invalid') return 'invalid_plan'
  return 'terminal_plan'
}

function parsePersistedLayeringPlanRow(row: unknown): RecoverLayeringPlanResult {
  if (row == null || typeof row !== 'object' || Array.isArray(row)) return { ok: false, reason: 'malformed_existing_plan' }
  const data = row as Partial<PersistedLayerPlanRow>
  const status = normalizeStatus(data.status)
  if (status == null) return { ok: false, reason: 'unknown_status' }
  const statusReason = checkPlanRowStatus(status)
  if (statusReason != null) return { ok: false, reason: statusReason }
  const parsed = parsePersistedLayeringPlan(data.layer_plan_metadata)
  if (!parsed.ok) return parsed.reason === 'malformed_metadata' ? { ok: false, reason: 'malformed_existing_plan' } : parsed
  const snapshot = parsed.snapshot
  if (
    data.layer_plan_id !== snapshot.planId
    || data.signal_id !== snapshot.signalId
    || data.broker_account_id !== snapshot.brokerAccountId
    || data.basket_key !== (snapshot.basketKey ?? '')
    || data.mode !== snapshot.mode
  ) return { ok: false, reason: 'identity_mismatch' }
  if (data.created_at !== snapshot.createdAt || data.locked_at !== snapshot.lockedAt) {
    return { ok: false, reason: 'identity_mismatch' }
  }
  if (data.semantic_fingerprint != null && data.semantic_fingerprint !== computeLayeringPlanFingerprint(snapshot)) {
    return { ok: false, reason: 'identity_mismatch' }
  }
  return parsed
}

function snapshotMetadata(snapshot: LayeringPlanSnapshot): Record<string, unknown> | null {
  return serializeLayeringPlanSnapshot(snapshot)
}

function isDuplicateError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string }
  return e.code === '23505' || /duplicate key|unique constraint/i.test(e.message ?? '')
}

function isAmbiguousPersistenceError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const e = error as { code?: string; message?: string }
  return /timeout|timed out|connection.*closed|network|fetch failed/i.test(`${e.code ?? ''} ${e.message ?? ''}`)
}

export async function loadLayeringPlan(
  supabase: SupabaseClient,
  planId: string,
): Promise<RecoverLayeringPlanResult> {
  if (!isValidLayerPlanId(planId)) return { ok: false, reason: 'invalid_plan_id' }
  const { data, error } = await supabase
    .from('layering_plans')
    .select('layer_plan_id,signal_id,broker_account_id,basket_key,mode,status,layer_plan_metadata,semantic_fingerprint,created_at,locked_at')
    .eq('layer_plan_id', planId)
    .maybeSingle()
  if (error) return { ok: false, reason: 'persistence_failed' }
  if (!data) return { ok: false, reason: 'not_found' }
  return parsePersistedLayeringPlanRow(data)
}

export async function persistLayeringPlan(
  supabase: SupabaseClient,
  snapshot: LayeringPlanSnapshot,
): Promise<PersistLayeringPlanResult> {
  const parsed = parsePersistedLayeringPlan(snapshot)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const metadata = snapshotMetadata(parsed.snapshot)
  if (metadata == null) return { ok: false, reason: 'invalid_snapshot' }
  const fingerprint = computeLayeringPlanFingerprint(parsed.snapshot)
  if (fingerprint == null) return { ok: false, reason: 'invalid_snapshot' }

  const { error } = await supabase.from('layering_plans').insert({
    layer_plan_id: parsed.snapshot.planId,
    signal_id: parsed.snapshot.signalId,
    broker_account_id: parsed.snapshot.brokerAccountId,
    basket_key: parsed.snapshot.basketKey ?? '',
    mode: parsed.snapshot.mode,
    status: 'prepared',
    layer_plan_metadata: metadata,
    semantic_fingerprint: fingerprint,
    created_at: parsed.snapshot.createdAt,
    locked_at: parsed.snapshot.lockedAt,
  })
  if (!error) return { ok: true, outcome: 'created', snapshot: parsed.snapshot }
  if (!isDuplicateError(error) && !isAmbiguousPersistenceError(error)) return { ok: false, reason: 'persistence_failed' }
  const afterDuplicate = await loadLayeringPlan(supabase, snapshot.planId)
  if (!afterDuplicate.ok) return { ok: false, reason: afterDuplicate.reason === 'not_found' ? 'persistence_failed' : afterDuplicate.reason }
  return snapshotsMatch(afterDuplicate.snapshot, parsed.snapshot)
    ? { ok: true, outcome: 'already_exists_matching', snapshot: afterDuplicate.snapshot }
    : { ok: false, reason: 'conflict' }
}

export async function claimLayeringPlanActivation(
  supabase: SupabaseClient,
  snapshot: LayeringPlanSnapshot,
): Promise<{ readonly ok: true; readonly outcome: 'activation_claimed' | 'already_active' } | { readonly ok: false; readonly reason: LayerPlanPersistenceReason }> {
  const parsed = parsePersistedLayeringPlan(snapshot)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const fingerprint = computeLayeringPlanFingerprint(parsed.snapshot)
  if (fingerprint == null) return { ok: false, reason: 'invalid_snapshot' }
  const { data, error } = await supabase
    .from('layering_plans')
    .update({ status: 'activating', updated_at: new Date().toISOString(), activated_at: new Date().toISOString() })
    .eq('layer_plan_id', parsed.snapshot.planId)
    .eq('status', 'prepared')
    .eq('semantic_fingerprint', fingerprint)
    .select('layer_plan_id')
    .maybeSingle()
  if (!error && data) return { ok: true, outcome: 'activation_claimed' }
  const existing = await loadLayeringPlan(supabase, parsed.snapshot.planId)
  if (!existing.ok) return { ok: false, reason: existing.reason }
  if (!snapshotsMatch(existing.snapshot, parsed.snapshot)) return { ok: false, reason: 'fingerprint_conflict' }
  const row = await supabase
    .from('layering_plans')
    .select('status')
    .eq('layer_plan_id', parsed.snapshot.planId)
    .maybeSingle()
  const status = normalizeStatus((row.data as { status?: unknown } | null)?.status)
  if (status === 'active') return { ok: true, outcome: 'already_active' }
  if (status === 'activating') return { ok: false, reason: 'already_activating' }
  if (status === 'entries_complete' || status === 'completed' || status === 'cancelling' || status === 'cancellation_pending' || status === 'cancellation_manual_review' || status === 'cancelled') return { ok: false, reason: 'terminal_plan' }
  if (status === 'invalid') return { ok: false, reason: 'invalid_plan' }
  return { ok: false, reason: 'activation_failed' }
}

export async function activateLayeringPlanWithLegs(
  supabase: SupabaseClient,
  snapshot: LayeringPlanSnapshot,
  args: ActivateLayeringPlanArgs | readonly ExecutableLayerPlanLegRow[],
): Promise<{ readonly ok: true; readonly outcome: 'activated' | 'already_active' } | { readonly ok: false; readonly reason: LayerPlanPersistenceReason }> {
  const parsed = parsePersistedLayeringPlan(snapshot)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const fingerprint = computeLayeringPlanFingerprint(parsed.snapshot)
  if (fingerprint == null) return { ok: false, reason: 'invalid_snapshot' }
  const legacyRows = Array.isArray(args) ? args : null
  const activationArgs = args as ActivateLayeringPlanArgs
  const firstLegacy = legacyRows?.[0]
  const legContext: ActivateLayeringPlanContext = legacyRows
    ? {
        user_id: firstLegacy?.user_id ?? '',
        signal_id: parsed.snapshot.signalId,
        broker_account_id: parsed.snapshot.brokerAccountId,
        metaapi_account_id: firstLegacy?.metaapi_account_id ?? '',
        stoploss: firstLegacy?.stoploss ?? null,
        takeprofit: firstLegacy?.takeprofit ?? null,
        slippage: firstLegacy?.slippage ?? 20,
        comment: firstLegacy?.comment ?? null,
        expert_id: firstLegacy?.expert_id ?? null,
        expires_at: firstLegacy?.expires_at ?? null,
        cwe_close_price: firstLegacy?.cwe_close_price ?? null,
        broker_pending_type: firstLegacy?.broker_pending_type ?? null,
      }
    : activationArgs.legContext
  const executionMechanism = legacyRows
    ? (firstLegacy?.status === 'broker_pending' ? 'pending_order' : 'auto')
    : activationArgs.executionMechanism
  const excludeFirstLayer = legacyRows ? firstLegacy?.step_idx === 2 : activationArgs.excludeFirstLayer
  const { data, error } = await supabase.rpc('activate_layering_plan', {
    p_layer_plan_id: parsed.snapshot.planId,
    p_semantic_fingerprint: fingerprint,
    p_execution_mechanism: executionMechanism,
    p_exclude_first_layer: excludeFirstLayer,
    p_leg_context: legContext,
  })
  if (error) return { ok: false, reason: 'activation_failed' }
  const outcome = typeof data === 'string'
    ? data
    : (data && typeof data === 'object' ? String((data as { outcome?: unknown }).outcome ?? '') : '')
  if (outcome === 'activated') return { ok: true, outcome: 'activated' }
  if (outcome === 'already_active') return { ok: true, outcome: 'already_active' }
  if (outcome === 'already_activating') return { ok: false, reason: 'already_activating' }
  if (outcome === 'fingerprint_conflict') return { ok: false, reason: 'fingerprint_conflict' }
  if (outcome === 'terminal_plan') return { ok: false, reason: 'terminal_plan' }
  if (outcome === 'not_found') return { ok: false, reason: 'not_found' }
  return { ok: false, reason: 'activation_failed' }
}

export function materializeLayerPlanLegRows(snapshot: LayeringPlanSnapshot): { ok: true; rows: readonly ProposedLayerPlanLegRow[] } | { ok: false; reason: LayerPlanPersistenceReason } {
  const parsed = parsePersistedLayeringPlan(snapshot)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const metadata = snapshotMetadata(parsed.snapshot)
  if (metadata == null || parsed.snapshot.fundedPrices == null || parsed.snapshot.lots == null) {
    return { ok: false, reason: 'invalid_snapshot' }
  }
  const rows = parsed.snapshot.fundedPrices.map((price, idx) => ({
    layer_plan_id: parsed.snapshot.planId,
    layer_plan_metadata: metadata,
    signal_id: parsed.snapshot.signalId,
    broker_account_id: parsed.snapshot.brokerAccountId,
    symbol: parsed.snapshot.symbol,
    step_idx: idx + 1,
    is_buy: parsed.snapshot.side === 'buy',
    trigger_price: price,
    volume: parsed.snapshot.lots![idx]!,
    status: 'planned' as const,
  }))
  return { ok: true, rows: Object.freeze(rows) }
}

export function materializeExecutableLayerPlanLegRows(args: {
  readonly snapshot: LayeringPlanSnapshot
  readonly userId: string
  readonly metaapiAccountId: string
  readonly stoploss: number | null
  readonly takeprofit: number | null
  readonly slippage: number
  readonly comment: string | null
  readonly expertId?: number | null
  readonly expiresAt?: string | null
  readonly cweClosePrice?: number | null
  readonly status: 'pending' | 'broker_pending'
  readonly skipFirstLayer?: boolean
}): { ok: true; rows: readonly ExecutableLayerPlanLegRow[] } | { ok: false; reason: LayerPlanPersistenceReason } {
  const parsed = parsePersistedLayeringPlan(args.snapshot)
  if (!parsed.ok) return { ok: false, reason: parsed.reason }
  const metadata = snapshotMetadata(parsed.snapshot)
  if (metadata == null || parsed.snapshot.fundedPrices == null || parsed.snapshot.lots == null) {
    return { ok: false, reason: 'invalid_snapshot' }
  }
  const start = args.skipFirstLayer ? 1 : 0
  const anchor = parsed.snapshot.executableAnchorPrice ?? parsed.snapshot.fundedPrices[0] ?? parsed.snapshot.anchorPrice
  if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) return { ok: false, reason: 'invalid_snapshot' }
  const rows = parsed.snapshot.fundedPrices.slice(start).map((price, offset) => {
    const idx = start + offset
    return {
      layer_plan_id: parsed.snapshot.planId,
      layer_plan_metadata: metadata,
      signal_id: parsed.snapshot.signalId,
      user_id: args.userId,
      broker_account_id: parsed.snapshot.brokerAccountId,
      metaapi_account_id: args.metaapiAccountId,
      symbol: parsed.snapshot.symbol,
      step_idx: idx + 1,
      is_buy: parsed.snapshot.side === 'buy',
      volume: parsed.snapshot.lots![idx]!,
      anchor_price: anchor,
      trigger_price: price,
      stoploss: args.stoploss,
      takeprofit: args.cweClosePrice != null ? null : args.takeprofit,
      slippage: args.slippage,
      comment: args.comment,
      expert_id: args.expertId ?? null,
      expires_at: args.expiresAt ?? null,
      status: args.status,
      cwe_close_price: args.cweClosePrice ?? null,
    }
  })
  return { ok: true, rows: Object.freeze(rows) }
}

export function recoverLayeringPlan(args: {
  readonly planRow: PersistedLayerPlanRow | { readonly layer_plan_metadata?: unknown; readonly status?: unknown } | null
  readonly legRows?: readonly Partial<ProposedLayerPlanLegRow>[]
}): RecoverLayeringPlanResult {
  if (!args.planRow) return { ok: false, reason: 'not_found' }
  const parsed = 'layer_plan_id' in args.planRow
    ? parsePersistedLayeringPlanRow(args.planRow)
    : (() => {
      const status = args.planRow.status == null ? null : normalizeStatus(args.planRow.status)
      if (args.planRow.status != null && status == null) return { ok: false, reason: 'unknown_status' } as RecoverLayeringPlanResult
      if (status != null) {
        const statusReason = checkPlanRowStatus(status)
        if (statusReason != null) return { ok: false, reason: statusReason } as RecoverLayeringPlanResult
      }
      return parsePersistedLayeringPlan(args.planRow.layer_plan_metadata)
    })()
  if (!parsed.ok) return parsed
  if (args.legRows != null && args.legRows.length > 0) {
    const expected = materializeLayerPlanLegRows(parsed.snapshot)
    if (!expected.ok) return { ok: false, reason: expected.reason }
    if (args.legRows.length !== expected.rows.length) return { ok: false, reason: 'leg_count_mismatch' }
    const seen = new Set<number>()
    for (const row of args.legRows) {
      const idx = Number(row.step_idx)
      if (!Number.isInteger(idx) || idx < 1 || idx > expected.rows.length) return { ok: false, reason: 'identity_mismatch' }
      if (seen.has(idx)) return { ok: false, reason: 'duplicate_leg' }
      seen.add(idx)
      const want = expected.rows[idx - 1]!
      if (row.layer_plan_id !== want.layer_plan_id || row.signal_id !== want.signal_id || row.broker_account_id !== want.broker_account_id) {
        return { ok: false, reason: 'identity_mismatch' }
      }
      if (row.status != null && row.status !== want.status) return { ok: false, reason: 'identity_mismatch' }
      if (row.trigger_price !== want.trigger_price) return { ok: false, reason: 'price_mismatch' }
      if (row.volume !== want.volume) return { ok: false, reason: 'lot_mismatch' }
    }
  }
  return parsed
}
