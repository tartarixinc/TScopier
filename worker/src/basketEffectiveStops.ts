/**
 * Single source of truth for open-basket SL/TP authority (anchor vs adjust vs channel memory).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  channelParamsPredateBasket,
  levelFitsDirection,
  loadChannelActiveTradeParamsForSymbol,
  type ChannelActiveTradeParams,
} from './channelActiveTradeParams'
import { mgmtSignalMatchesBasketSymbol } from './basketModFollowUp'
import type { BasketOpenLeg } from './basketSlTpReconcile'
import { coercePositiveTpLevels, type RangeBasketParsedSlice } from './rangeBasketTpSync'
import { loadBasketSlTpTarget } from './basketTargetStore'
import {
  parseUserOverride,
  userOverrideInForce,
  type SignalUserOverride,
} from './signalOverride'

export type EffectiveStopSource =
  | 'user_override'
  | 'basket_target'
  | 'mgmt_signal'
  | 'channel_memory'
  | 'anchor'
  | 'leg_consensus'

/** Latest explicit instruction — unifies SL on every leg, including Manage Signals. */
export function isExplicitBasketSlSource(source?: EffectiveStopSource | string | null): boolean {
  return source === 'user_override' || source === 'basket_target' || source === 'mgmt_signal'
}

/** True when any open leg was moved to breakeven (auto-BE or channel BE). */
export function basketHasAutoBreakeven(
  familyTrades: { auto_be_applied_at?: string | null }[] | undefined,
): boolean {
  return (familyTrades ?? []).some(t => Boolean(t.auto_be_applied_at))
}

export type EffectiveBasketStops = {
  stoploss: number
  tpLevels: number[]
  parsedSlice: RangeBasketParsedSlice
  source: EffectiveStopSource
  sourceSignalId?: string
  anchorSl: number
  /** Present when the per-basket target store row was loaded. */
  basketTargetSource?: string
  basketTargetInstructionAt?: string | null
}

type ParsedMgmtRow = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
}

const MGMT_SL_ACTIONS = new Set(['modify', 'breakeven', 'partial_breakeven'])

function sanitizeLevel(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function inferIsBuy(familyTrades: BasketOpenLeg[] | undefined): boolean {
  const dir = String(familyTrades?.[0]?.direction ?? 'buy').toLowerCase()
  return dir !== 'sell'
}

export function unanimousLegSl(familyTrades: BasketOpenLeg[] | undefined): number | null {
  if (!familyTrades?.length) return null
  const levels = new Set<number>()
  for (const tr of familyTrades) {
    const sl = sanitizeLevel(tr.sl)
    if (sl <= 0) return null
    levels.add(sl)
  }
  if (levels.size !== 1) return null
  return [...levels][0]!
}

/** Highest SL for buys / lowest for sells among open legs (breakeven-tightened legs). */
export function mostProtectiveOpenLegSl(
  familyTrades: BasketOpenLeg[] | undefined,
  isBuy: boolean,
): number | null {
  if (!familyTrades?.length) return null
  let best: number | null = null
  for (const tr of familyTrades) {
    const sl = sanitizeLevel(tr.sl)
    if (sl <= 0) continue
    if (best == null) best = sl
    else if (isBuy) best = Math.max(best, sl)
    else best = Math.min(best, sl)
  }
  return best
}

export function mergeWithProtectiveLegSl(
  resolvedSl: number,
  protectiveSl: number | null,
  isBuy: boolean,
): number {
  if (protectiveSl == null || protectiveSl <= 0) return resolvedSl
  if (resolvedSl <= 0) return protectiveSl
  return isBuy ? Math.max(resolvedSl, protectiveSl) : Math.min(resolvedSl, protectiveSl)
}

/** True when `currentSl` is tighter than `targetSl` for the trade direction. */
export function isSlMoreProtective(
  currentSl: number,
  targetSl: number,
  isBuy: boolean,
  epsilon = 1e-8,
): boolean {
  if (currentSl <= 0 || targetSl <= 0) return false
  if (isBuy) return currentSl > targetSl + epsilon
  return currentSl < targetSl - epsilon
}

/** Pure SL priority for unit tests. */
export function resolveEffectiveStoplossPriority(args: {
  anchorSl: number
  mgmtSl: number | null
  channelSl: number | null
  legConsensus: number | null
  /** Authoritative per-basket target (latest recorded instruction) — wins over all. */
  basketTargetSl?: number | null
  /** Manage Signals override — wins over original signal, basket entry seed, and auto-BE. */
  userOverrideSl?: number | null
}): { stoploss: number; source: EffectiveStopSource } {
  const override = args.userOverrideSl != null && args.userOverrideSl > 0 ? args.userOverrideSl : null
  if (override != null) return { stoploss: override, source: 'user_override' }

  const target = args.basketTargetSl != null && args.basketTargetSl > 0 ? args.basketTargetSl : null
  if (target != null) return { stoploss: target, source: 'basket_target' }

  const mgmt = args.mgmtSl != null && args.mgmtSl > 0 ? args.mgmtSl : null
  if (mgmt != null) return { stoploss: mgmt, source: 'mgmt_signal' }

  const channel = args.channelSl != null && args.channelSl > 0 ? args.channelSl : null
  if (channel != null) return { stoploss: channel, source: 'channel_memory' }

  const anchor = args.anchorSl > 0 ? args.anchorSl : 0
  const consensus = args.legConsensus != null && args.legConsensus > 0 ? args.legConsensus : null
  if (consensus != null && (anchor <= 0 || consensus !== anchor)) {
    return { stoploss: consensus, source: 'leg_consensus' }
  }

  return { stoploss: anchor, source: anchor > 0 ? 'anchor' : 'anchor' }
}

export async function findLatestMgmtSlAdjustment(
  supabase: SupabaseClient,
  args: {
    userId: string
    channelId: string
    basketCreatedAt: string
    symbol: string
  },
): Promise<{
  sl: number
  signalId: string
  tpLevels: number[]
  createdAt: string | null
  latestActionIsBreakeven: boolean
  newestCreatedAt: string | null
} | null> {
  const { data: candidates, error } = await supabase
    .from('signals')
    .select('id, parsed_data, created_at')
    .eq('user_id', args.userId)
    .eq('channel_id', args.channelId)
    .in('status', ['parsed', 'executed'])
    .gte('created_at', args.basketCreatedAt)
    .order('created_at', { ascending: false })
    .limit(60)

  if (error) {
    console.warn(`[effectiveStops] mgmt signal scan failed: ${error.message}`)
    return null
  }

  // Candidates are newest-first. The newest management action determines which
  // instruction is authoritative. A breakeven message carries no price (sl=null),
  // so we must track it explicitly: an older "Adjust SL" must NOT override a
  // newer breakeven (that would revert the basket off breakeven).
  let newestMgmtAction: string | null = null
  let newestMgmtCreatedAt: string | null = null
  let priceAdjust: { sl: number; signalId: string; tpLevels: number[]; createdAt: string | null } | null = null
  for (const row of candidates ?? []) {
    const parsed = row.parsed_data as ParsedMgmtRow | null
    if (!parsed?.action) continue
    const action = String(parsed.action).toLowerCase()
    if (!MGMT_SL_ACTIONS.has(action)) continue
    if (!mgmtSignalMatchesBasketSymbol(parsed, args.symbol)) continue
    const rowCreatedAt = (row as { created_at?: string }).created_at ?? null
    if (newestMgmtAction == null) {
      newestMgmtAction = action
      newestMgmtCreatedAt = rowCreatedAt
    }
    if (priceAdjust == null && action === 'modify') {
      const sl = sanitizeLevel(parsed.sl)
      if (sl > 0) {
        priceAdjust = {
          sl,
          signalId: String(row.id),
          tpLevels: coercePositiveTpLevels(parsed.tp),
          createdAt: rowCreatedAt,
        }
      }
    }
    if (newestMgmtAction != null && priceAdjust != null) break
  }

  const latestActionIsBreakeven =
    newestMgmtAction === 'breakeven' || newestMgmtAction === 'partial_breakeven'

  if (!priceAdjust) {
    if (newestMgmtAction == null) return null
    return {
      sl: 0,
      signalId: '',
      tpLevels: [],
      createdAt: newestMgmtCreatedAt,
      newestCreatedAt: newestMgmtCreatedAt,
      latestActionIsBreakeven,
    }
  }
  return {
    ...priceAdjust,
    newestCreatedAt: newestMgmtCreatedAt,
    latestActionIsBreakeven,
  }
}

/** Newest auto-breakeven timestamp across open legs (autoManagementMonitor sets auto_be_applied_at). */
export function latestAutoBreakevenAt(familyTrades: BasketOpenLeg[] | undefined): string | null {
  if (!familyTrades?.length) return null
  let latest: number | null = null
  let latestIso: string | null = null
  for (const tr of familyTrades) {
    const at = (tr as { auto_be_applied_at?: string | null }).auto_be_applied_at
    if (!at) continue
    const t = Date.parse(at)
    if (!Number.isFinite(t)) continue
    if (latest == null || t > latest) {
      latest = t
      latestIso = at
    }
  }
  return latestIso
}

/** @deprecated Use findLatestMgmtSlAdjustment */
export const findLatestMgmtModifySl = findLatestMgmtSlAdjustment

export type ResolveEffectiveBasketStopsArgs = {
  supabase: SupabaseClient
  userId: string
  channelId: string | null
  anchorSignalId: string
  symbol: string
  basketCreatedAt: string | null
  anchorParsed: RangeBasketParsedSlice
  familyTrades?: BasketOpenLeg[]
  /** Enables the authoritative per-basket target store lookup. */
  brokerAccountId?: string | null
  /**
   * Manage Signals override. When provided (including `null`), skips the
   * signals.user_override load. Production callers omit this so the resolver
   * always reads the live jsonb even if `anchorParsed` is the raw signal.
   */
  userOverride?: SignalUserOverride | null
}

async function loadAnchorUserOverride(
  supabase: SupabaseClient,
  anchorSignalId: string,
): Promise<SignalUserOverride | null> {
  const { data, error } = await supabase
    .from('signals')
    .select('user_override')
    .eq('id', anchorSignalId)
    .maybeSingle()
  if (error || !data) return null
  return parseUserOverride((data as { user_override?: unknown }).user_override)
}

export async function resolveEffectiveBasketStops(
  args: ResolveEffectiveBasketStopsArgs,
): Promise<EffectiveBasketStops> {
  const anchorSl = sanitizeLevel(args.anchorParsed.sl)
  let tpLevels = coercePositiveTpLevels(args.anchorParsed.tp)
  const isBuy = inferIsBuy(args.familyTrades)

  // Auto-breakeven (autoManagementMonitor) tightens legs per-leg WITHOUT a
  // signal/channel memory/basket-target write — it only stamps
  // trades.auto_be_applied_at. Treat it as a first-class management action for
  // recency so a stale channel instruction cannot revert it after a TP hit.
  // Manage Signals overrides are an exception: they stay in force until a
  // later Telegram Adjust/BE, even if auto-BE stamped afterwards.
  const autoBeAt = latestAutoBreakevenAt(args.familyTrades)

  const override = args.userOverride !== undefined
    ? args.userOverride
    : await loadAnchorUserOverride(args.supabase, args.anchorSignalId)

  let mgmt: Awaited<ReturnType<typeof findLatestMgmtSlAdjustment>> = null
  if (args.channelId && args.basketCreatedAt) {
    mgmt = await findLatestMgmtSlAdjustment(args.supabase, {
      userId: args.userId,
      channelId: args.channelId,
      basketCreatedAt: args.basketCreatedAt,
      symbol: args.symbol,
    })
  }
  const overrideActive = userOverrideInForce(override, mgmt?.newestCreatedAt ?? null)

  // Authoritative per-basket target ("evolving signal"): the latest recorded
  // channel-wide instruction (entry seed / adjust / breakeven). When present it
  // wins for SL and TP — UNLESS a Manage Signals override is still in force
  // (including over a stale source=entry seed) or an auto-breakeven happened
  // after it was written (and no user override is in force).
  let basketTargetSl: number | null = null
  let tpFromTarget = false
  let basketTargetSource: string | undefined
  let basketTargetInstructionAt: string | null = null
  if (args.brokerAccountId) {
    const target = await loadBasketSlTpTarget(args.supabase, args.brokerAccountId, args.anchorSignalId)
    if (target) {
      basketTargetSource = target.source
      basketTargetInstructionAt = target.instructionAt
      const targetAt = target.instructionAt ?? target.updatedAt
      const autoBeNewerThanTarget = !overrideActive
        && autoBeAt != null
        && targetAt != null
        && Date.parse(autoBeAt) > Date.parse(targetAt)
      const staleEntryVsOverride = overrideActive && target.source === 'entry'
      if (
        !autoBeNewerThanTarget
        && !staleEntryVsOverride
        && target.stoploss != null
        && target.stoploss > 0
      ) {
        basketTargetSl = target.stoploss
      }
      if (target.tpLevels.length > 0 && !overrideActive) {
        tpLevels = target.tpLevels
        tpFromTarget = true
      } else if (target.tpLevels.length > 0 && !(override?.tp && override.tp.length > 0)) {
        tpLevels = target.tpLevels
        tpFromTarget = true
      }
    }
  }

  let userOverrideSl: number | null = null
  if (overrideActive) {
    const ovSl = override?.sl != null ? sanitizeLevel(override.sl) : 0
    if (ovSl > 0) userOverrideSl = ovSl
    if (override?.tp && override.tp.length > 0) {
      tpLevels = coercePositiveTpLevels(override.tp)
      tpFromTarget = true
    }
  }

  let mgmtSl: number | null = null
  let sourceSignalId: string | undefined
  if (mgmt && !overrideActive) {
    // The latest management instruction wins. A breakeven that happened AFTER
    // the last "Adjust SL" — whether a channel breakeven signal OR an auto-BE
    // on the legs — must not be overridden by that stale adjust. TP authority
    // still follows the latest Adjust (unless the basket target already set it).
    if (mgmt.tpLevels.length && !tpFromTarget) tpLevels = mgmt.tpLevels
    const autoBeNewerThanAdjust = autoBeAt != null
      && mgmt.createdAt != null
      && Date.parse(mgmt.createdAt) < Date.parse(autoBeAt)
      && Date.parse(mgmt.createdAt) > 0
    const breakevenIsLatest = mgmt.latestActionIsBreakeven || autoBeNewerThanAdjust
    if (!breakevenIsLatest && mgmt.sl > 0) {
      mgmtSl = mgmt.sl
      sourceSignalId = mgmt.signalId || undefined
    }
  }

  let channelSl: number | null = null
  let channelParams: ChannelActiveTradeParams | null = null
  if (args.channelId && !overrideActive) {
    channelParams = await loadChannelActiveTradeParamsForSymbol(
      args.supabase,
      args.userId,
      args.channelId,
      args.symbol,
    )
    if (channelParams && args.basketCreatedAt && channelParamsPredateBasket(channelParams, args.basketCreatedAt)) {
      channelParams = null
    } else if (channelParams) {
      // The per-symbol record has no direction, so it may hold stop/target values
      // written by an opposite-direction signal. Use only the levels that are valid
      // for this basket's direction; a wrong-side level would be rejected by the
      // broker and loop the reconcile forever.
      const refs = (args.familyTrades ?? [])
        .map((t) => Number((t as { entry_price?: number | null }).entry_price))
        .filter((n) => Number.isFinite(n) && n > 0)
      const channelRef = refs.length ? refs.reduce((a, b) => a + b, 0) / refs.length : 0
      const sl = channelParams.stoploss != null ? sanitizeLevel(channelParams.stoploss) : null
      channelSl = sl != null && sl > 0 && (channelRef <= 0 || levelFitsDirection(sl, channelRef, isBuy, 'sl'))
        ? sl
        : null
      const tps = channelRef > 0
        ? channelParams.tpLevels.filter((l) => levelFitsDirection(l, channelRef, isBuy, 'tp'))
        : channelParams.tpLevels
      if (tps.length > 0 && !mgmtSl && !tpFromTarget) {
        tpLevels = [...tps]
      }
    }
  }

  const legConsensus = unanimousLegSl(args.familyTrades)
  const { stoploss: prioritySl, source } = resolveEffectiveStoplossPriority({
    anchorSl,
    mgmtSl,
    channelSl: channelSl && channelSl > 0 ? channelSl : null,
    legConsensus,
    basketTargetSl,
    userOverrideSl,
  })

  // The authoritative basket target, Manage Signals override, and an explicit
  // recent channel adjustment are the user's latest instruction and must win
  // for the whole basket — even when they LOOSEN the stop.
  const protectiveLegSl = mostProtectiveOpenLegSl(args.familyTrades, isBuy)
  const stoploss = isExplicitBasketSlSource(source)
    ? prioritySl
    : mergeWithProtectiveLegSl(prioritySl, protectiveLegSl, isBuy)

  const parsedSlice: RangeBasketParsedSlice = {
    sl: stoploss > 0 ? stoploss : args.anchorParsed.sl,
    tp: tpLevels.length ? tpLevels : args.anchorParsed.tp,
  }

  return {
    stoploss,
    tpLevels,
    parsedSlice,
    source,
    sourceSignalId,
    anchorSl,
    basketTargetSource,
    basketTargetInstructionAt,
  }
}

export function logEffectiveBasketStops(
  prefix: string,
  anchorSignalId: string,
  effective: EffectiveBasketStops,
): void {
  const tag = prefix.endsWith(' ') ? prefix.slice(0, -1) : prefix
  console.log(
    `${tag} [effectiveStops] basket=${anchorSignalId} sl=${effective.stoploss}`
    + ` source=${effective.source}${effective.sourceSignalId ? ` signal=${effective.sourceSignalId}` : ''}`
    + ` anchor_sl=${effective.anchorSl}`,
  )
}
