import os from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isTransientMtApiError,
  normalizeSymbolParams,
  OrderSendArgs,
  SymbolParams,
} from './fxsocketClient'
import { apiForFxsocketAccount, resolveDurableBrokerArtifacts, type PlatformByFxsocketId } from './mtApiByAccount'
import { autoManagementTradeSnapshot, breakevenStopLossForSymbol, resolveAutoBeTpHitTriggerPriceFromManual, shouldStampAutoBeAppliedAt } from './autoManagement'
import { signalPipPrice } from './signalPip'
import { tryApplyBasketFollowUpToNewFill, symbolsCompatibleForBasket } from './basketModFollowUp'
import { loadOpenBasketLegs, upsertBasketReconcileJob } from './basketSlTpReconcile'
import { resolveFreshBasketReconcileTargets } from './basketReconcileTargets'
import { resolveEffectiveBasketStops } from './basketEffectiveStops'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import { markRangeLegFired } from './rangePendingLadderSync'
import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import { resolvePredefinedSlForEntry, resolvePredefinedTpForEntry } from './manualPlanning/manualStops'
import { resolveFiringLegStops, resolvePerLegBreakevenSlForNewFill, syncRangeBasketTakeProfits, toRangeBasketParsedSlice } from './rangeBasketTpSync'
import {
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  applyShardToQuery,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import {
  loadRangeLayerTillCloseForSignal,
  stopRangeLayeringUnlessEnabled,
} from './rangeLayerTillClose'
import { isUserCopierPausedCached } from './copierPause'
import {
  reconcileStaleClaimedLegs,
  setTpTouchedLock,
  shouldBlockVirtualLegFire,
} from './rangePendingFireGuard'
import { isMtBridgeGlitchMessage } from './brokerConnectError'
import { modifyLegSlTpWithFallback } from './orderModifySafe'
import {
  deleteRangePendingLegsForBasket,
  reconcileBasketFlatFromBroker,
  reconcilePendingLegBasketsFromBroker,
} from './rangePendingBasketCleanup'
import { reanchorPendingLegsAfterGapFill } from './gapFillReanchor'
import {
  DEFAULT_MAX_LAYER_FIRES_PER_TICK,
  highestFiredStepIdxForBasket,
  isLegEligibleByDistance,
  selectLegsForLayerTick,
  stepPriceOffsetForBasket,
} from './layerConcurrentFire'
import { incMetric } from './workerMetrics'
import { captureBusinessIssue } from './observability/businessEvents'
import { parsePersistedLayeringPlan } from './manualPlanning/layeringPlanPersistence'
import { resolveLayeringModeRolloutDecision } from './manualPlanning/layeringModeRollout'
import { convergeLayeringPlanAfterLegTerminal } from './layeringPlanLifecycle'
import { writeExecutionLog } from './observability/executionLog'
/**
 * Worker-side monitor that turns persisted "virtual range pendings" into
 * real market orders the moment the live /Quote crosses their trigger price.
 *
 * The matching `range-pending-sweep` edge function (60s cron) runs the same
 * check as a backup so a worker outage doesn't strand pending averaging-down
 * legs. Both racers use a CAS update (status='pending' to 'claimed') so only
 * one of them ever fires a given row.
 *
 * Design choices:
 *   • Poll cadence: 1.5s. Fast enough to react to most fills without hammering
 *     /Quote (we collapse one /Quote per `(account, symbol)` group per tick).
 *   • Trigger semantics:
 *       buy ladder  → fires when bid <= trigger_price   (price dropped to leg)
 *       sell ladder → fires when ask >= trigger_price   (price rose to leg)
 *   • Claim staleness: rows stuck in `claimed` for >30s get re-claimed —
 *     covers a worker that crashed mid-OrderSend.
 *   • Side-effect free until a trigger hits: a tick that finds nothing to fire
 *     never touches Postgres beyond the initial SELECT.
 *
 *   • Orphan pendings: if every `trades` row for the same (signal, broker,
 *     symbol) is already closed, we cancel `pending` legs (see early stale
 *     check before claim, and DB trigger `cancel_range_pending_legs_when_basket_empty`
 *     on `trades` close) so a flat basket cannot spawn new market entries when
 *     price revisits old ladder triggers.
 *
 *   • Ladder discipline: each leg must cross its planned trigger_price and fit
 *     the distance ceiling (floor(adverseDistance / stepOffset)). At most
 *     DEFAULT_MAX_LAYER_FIRES_PER_TICK legs per basket per tick (catch-up when
 *     multiple triggers crossed). Shallower pending/claimed rungs block deeper
 *     ones until they fire. Strict signal-entry deferrals use broker limit orders
 *     limit orders (`signal_entry_pending_orders`), not `step_idx = 0` rows
 *     in this table.
 *
 *   • Terminal rows (`expired` TTL, successful `fired`) are **deleted** from
 *     `range_pending_legs` with status `fired` (row retained for ladder history)
 *     tombstones. Failed / cancelled legs remain for diagnostics.
 */

interface PendingRow {
  id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  step_idx: number
  is_buy: boolean
  volume: number
  anchor_price: number
  trigger_price: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string | null
  expert_id: number | null
  expires_at: string | null
  status: string
  /**
   * Close-Worse-Entries threshold inherited from the planner via the
   * executor's INSERT. When non-null the leg is part of the worse-entries
   * basket: the broker order goes out with NO takeprofit (only the SL
   * rides) and the resulting `trades` row carries this value so
   * `cweCloseMonitor` will close the position when the live quote crosses.
   */
  cwe_close_price: number | null
  layer_plan_id?: string | null
  layer_plan_metadata?: unknown | null
}

interface BasketOpenTpRow {
  signal_id: string
  broker_account_id: string
  user_id: string
  direction: string
  tp: number | null
  status?: string | null
}

interface SymbolCacheEntry {
  digits: number
  point: number
  minLot: number
  lotStep: number
  /**
   * Units in 1.00 standard lot. The monitor doesn't currently use this for
   * order math, but the field keeps the cache shape aligned with the
   * tradeExecutor cache so future risk/sizing code can be added in one
   * place.
   */
  contractSize: number | null
  stopsLevel: number
  freezeLevel: number
  loadedAt: number
}

type BrokerConfigCacheEntry = {
  manual: Record<string, unknown>
  loadedAt: number
}

type LayerExecutionTimestamps = {
  market_tick_received_at?: number
  layer_lookup_started_at?: number
  layer_lookup_completed_at?: number
  layer_cross_detected_at?: number
  layer_claim_started_at?: number
  layer_claim_acquired_at?: number
  layer_execution_planned_at?: number
  broker_request_started_at?: number
  broker_response_received_at?: number
  pending_leg_updated_at?: number
  layer_reconciled_at?: number
}

export type FireLegResult =
  | { outcome: 'fired' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'not_claimed'; reason?: string }
  | { outcome: 'failed'; reason: string }

const SYMBOL_TTL_MS = 10 * 60_000
const ACTIVE_MS = monitorActiveIntervalMs('VIRTUAL_PENDING_TICK_MS', 200)
const IDLE_MS = monitorIdleIntervalMs('VIRTUAL_PENDING_IDLE_MS', 15_000)
const STALE_CLAIM_AFTER_MS = 30_000

export function layerLatencyPayload(
  ts: LayerExecutionTimestamps,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const duration = (end?: number, start?: number) =>
    end != null && start != null ? Math.max(0, end - start) : null
  return {
    ...extra,
    tick_to_cross_detection_ms: duration(ts.layer_cross_detected_at, ts.market_tick_received_at),
    layer_lookup_ms: duration(ts.layer_lookup_completed_at, ts.layer_lookup_started_at),
    claim_ms: duration(ts.layer_claim_acquired_at, ts.layer_claim_started_at),
    cross_to_broker_request_ms: duration(ts.broker_request_started_at, ts.layer_cross_detected_at),
    broker_response_ms: duration(ts.broker_response_received_at, ts.broker_request_started_at),
    complete_layer_execution_ms: duration(ts.layer_reconciled_at ?? ts.pending_leg_updated_at, ts.market_tick_received_at),
    timestamps: ts,
  }
}

function logLayerLatency(event: string, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({
    event,
    component: 'virtualPendingMonitor',
    ...payload,
  }))
}

async function virtualPendingHasWork(
  supabase: SupabaseClient,
  staleCut: string,
): Promise<boolean> {
  const pending = await hasWorkOnShard(supabase, 'range_pending_legs', q =>
    q
      .eq('status', 'pending')
      .not('comment', 'ilike', '%:strictEntry%')
      .not('comment', 'ilike', '%:strictEntryAgg%'),
  )
  if (pending) return true
  return hasWorkOnShard(supabase, 'range_pending_legs', q =>
    q.eq('status', 'claimed').lt('claimed_at', staleCut),
  )
}

/**
 * Pure trigger-check used by both the worker monitor and the edge sweep:
 *   buy ladder  → trigger fires when bid <= trigger_price (price dropped)
 *   sell ladder → trigger fires when ask >= trigger_price (price rose)
 */
export function isTriggered(isBuy: boolean, triggerPrice: number, bid: number, ask: number): boolean {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  return isBuy ? bid <= triggerPrice : ask >= triggerPrice
}

/**
 * True if some shallower virtual rung for the same basket is still `pending`
 * or `claimed` (see `activeStepsByBasket` from `fetchShallowActiveSteps`).
 */
export function isBlockedByShallowerStep(
  leg: { signal_id: string; broker_account_id: string; step_idx: number },
  activeStepsByBasket: Map<string, Set<number>>,
): boolean {
  const bk = `${leg.signal_id}|${leg.broker_account_id}`
  const steps = activeStepsByBasket.get(bk)
  if (!steps) return false
  for (const s of steps) {
    if (s < leg.step_idx) return true
  }
  return false
}

/**
 * A layer must fill at (or better than) its planned rung price, within the
 * configured slippage. Guards against the fire-time price racing away from the
 * tick-time trigger check — without it, a buy rung that triggered on a brief
 * dip can fill seconds later at the top of a rally, printing a WORSE entry
 * than the immediates it was supposed to average down from and ignoring the
 * step-pips ladder spacing.
 */
export function fillWithinTriggerBand(args: {
  isBuy: boolean
  triggerPrice: number
  bid: number
  ask: number
  slippagePoints: number
  point: number | null
}): { ok: boolean; reason?: string } {
  const { isBuy, triggerPrice, bid, ask, slippagePoints, point } = args
  if (!isTriggered(isBuy, triggerPrice, bid, ask)) {
    return { ok: false, reason: 'no_longer_triggered' }
  }
  if (point == null || !(point > 0)) return { ok: true }
  const tol = Math.max(2, Math.max(0, slippagePoints)) * point
  const fillSide = isBuy ? ask : bid
  const ok = isBuy ? fillSide <= triggerPrice + tol : fillSide >= triggerPrice - tol
  return ok ? { ok: true } : { ok: false, reason: 'fill_outside_trigger_band' }
}

import { shouldLockBasketLayering } from './rangeBasketLayeringLock'
export { evaluateTpTouch, shouldLockBasketLayering } from './rangeBasketLayeringLock'

export class VirtualPendingMonitor {
  private loop: MonitorLoopHandle | null = null
  private platformByUuid: PlatformByFxsocketId = new Map()
  private symbolCache = new Map<string, SymbolCacheEntry>()
  private brokerConfigCache = new Map<string, BrokerConfigCacheEntry>()
  private hostId: string
  private ticking = false
  /** Heartbeat counter: when there ARE pending rows but none triggered, we
   *  still log one line every N ticks so it's obvious the monitor is alive
   *  and how far the live quote sits from the nearest trigger. */
  private quietTicks = 0
  private reconcileTicks = 0
  private firstTickLogged = false
  /** Throttle basket_in_profit skip logs — legs re-check every tick. */
  private profitSkipLogAt = new Map<string, number>()
  /** Throttle trigger-band defer logs — legs re-check every tick. */
  private bandSkipLogAt = new Map<string, number>()
  /** Previous quote per (account, symbol) for adverse crossing detection. */
  private lastQuoteByGroup = new Map<string, { bid: number; ask: number }>()
  private static readonly PROFIT_SKIP_LOG_MS = 60_000

  constructor(private readonly supabase: SupabaseClient) {
    this.hostId = `worker:${os.hostname()}:${process.pid}`
  }

  start() {
    if (this.loop) return
    const staleCut = () => new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    this.loop = startMonitorLoop({
      name: 'virtualPendingMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => virtualPendingHasWork(sb, staleCut()),
      tick: () => this.runTick(),
    })
    console.log(`[virtualPendingMonitor] started host=${this.hostId} active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  /** Statuses polled by the auto (virtual) layering monitor — excludes `broker_pending`. */
  static readonly AUTO_LAYER_STATUSES = ['pending'] as const

  /** One-shot trigger pass after virtual pending insert (avoids waiting for next poll tick). */
  async runImmediateCheck(signalId: string, brokerAccountId: string): Promise<void> {
    if (this.ticking) {
      this.loop?.poke()
      return
    }
    await this.tick({ signalId, brokerAccountId })
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } finally {
      this.ticking = false
    }
  }

  private async tick(scope?: { signalId: string; brokerAccountId: string }): Promise<void> {
    // Re-open rows whose claim is stale. Anything older than STALE_CLAIM_AFTER_MS
    // is considered abandoned (the claiming worker probably crashed); reset it
    // so another monitor can pick it up.
    const staleCut = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    const staleStats = await reconcileStaleClaimedLegs(this.supabase, staleCut)
    if (staleStats.cancelled > 0 || staleStats.reset > 0) {
      console.log(
        `[virtualPendingMonitor] stale claims reconciled cancelled=${staleStats.cancelled} reset=${staleStats.reset}`,
      )
    }

    // Expire any rows whose pending_expiry_hours have lapsed BEFORE we try to
    // fire them — keeps the queue tight.
    const nowIso = new Date().toISOString()
    const { data: expired } = await this.supabase
      .from('range_pending_legs')
      .update({ status: 'expired', error_message: 'pending_expiry' })
      .eq('status', 'pending')
      .not('expires_at', 'is', null)
      .lt('expires_at', nowIso)
      .select('id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,is_buy,step_idx,layer_plan_id')
    if (expired && expired.length) {
      for (const r of expired as PendingRow[]) {
        if (r.layer_plan_id) {
          await convergeLayeringPlanAfterLegTerminal(this.supabase, r.layer_plan_id)
        }
        if (isUserCopierPausedCached(r.user_id)) continue
        await writeExecutionLog(this.supabase, {
          user_id: r.user_id,
          signal_id: r.signal_id,
          broker_account_id: r.broker_account_id,
          action: 'virtual_pending_expired',
          status: 'info',
          request_payload: { id: r.id, symbol: r.symbol, step_idx: r.step_idx } as unknown as Record<string, unknown>,
        })
      }
    }

    // Pull the live pending queue.
    const layerLookupStartedAt = Date.now()
    let pendingQuery = this.supabase
      .from('range_pending_legs')
      .select('*')
      .eq('status', 'pending')
      .not('comment', 'ilike', '%:strictEntry%')
      .not('comment', 'ilike', '%:strictEntryAgg%')
    if (scope) {
      pendingQuery = pendingQuery
        .eq('signal_id', scope.signalId)
        .eq('broker_account_id', scope.brokerAccountId)
    }
    const pendingQ = await applyShardToQuery(
      this.supabase,
      pendingQuery.limit(scope ? 100 : 500),
    )
    if (!pendingQ) return
    const { data, error } = await pendingQ
    const layerLookupCompletedAt = Date.now()
    if (error) {
      console.error('[virtualPendingMonitor] select failed:', error.message)
      return
    }
    const rows = ((data ?? []) as PendingRow[])
      .filter(r => !isUserCopierPausedCached(r.user_id))
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[virtualPendingMonitor] first tick ok pending_rows=${rows.length}`)
    }
    if (!rows.length) {
      // Reset the quiet-tick counter — next time rows appear, the heartbeat
      // restarts from zero so the first non-empty tick always logs.
      this.quietTicks = 0
      return
    }

    const resolved = await resolveDurableBrokerArtifacts(this.supabase, rows)
    this.platformByUuid = resolved.platformBySession
    rows.splice(0, rows.length, ...resolved.rows)

    // SL/TP/manual broker closes leave DB trades "open" — reconcile before triggers.
    // Run every 5th tick (~7.5s) instead of every tick to avoid blocking the fire path.
    this.reconcileTicks += 1
    if (this.reconcileTicks % 5 === 1) {
      await reconcilePendingLegBasketsFromBroker(
        this.supabase,
        rows,
        uuid => apiForFxsocketAccount(this.platformByUuid, uuid),
      )
    }

    // Group by (account, symbol) so we issue at most ONE /Quote per group.
    const groups = new Map<string, PendingRow[]>()
    for (const r of rows) {
      const key = `${r.metaapi_account_id}|${r.symbol}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }

    let triggeredTotal = 0
    let firedOkTotal = 0
    let firedErrTotal = 0
    /** Per-group: cheapest distance between live quote and any leg's trigger.
     *  Lets the heartbeat log show "you're $0.40 from your nearest trigger". */
    const distances: Array<{ symbol: string; bid: number; ask: number; gapPriceUnits: number; legs: number }> = []

    await Promise.all(Array.from(groups.entries()).map(async ([key, legs]) => {
      const [uuid, symbol] = key.split('|')
      if (!uuid || !symbol) return
      const api = apiForFxsocketAccount(this.platformByUuid, uuid)
      if (!api) return
      let q
      try {
        q = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[virtualPendingMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        return
      }
      const marketTickReceivedAt = Date.now()
      const tpTouchedBaskets = await this.detectAndLockTpTouchedBaskets(legs, q.bid, q.ask)
      // How far is the nearest trigger? Useful diagnostic when nothing fires.
      let nearestGap = Number.POSITIVE_INFINITY
      for (const leg of legs) {
        const basketKey = `${leg.signal_id}|${leg.broker_account_id}`
        if (tpTouchedBaskets.has(basketKey)) continue
        const ref = leg.is_buy ? q.bid : q.ask
        const gap = leg.is_buy ? ref - leg.trigger_price : leg.trigger_price - ref
        if (Number.isFinite(gap) && gap < nearestGap) nearestGap = gap
      }
      this.lastQuoteByGroup.set(key, { bid: q.bid, ask: q.ask })

      const pendingByBasket = new Map<string, PendingRow[]>()
      for (const leg of legs) {
        const bk = `${leg.signal_id}|${leg.broker_account_id}`
        if (tpTouchedBaskets.has(bk)) continue
        const arr = pendingByBasket.get(bk) ?? []
        arr.push(leg)
        pendingByBasket.set(bk, arr)
      }

      const signalIds = [...new Set(legs.map(l => l.signal_id))]
      const activeStepsByBasket = await this.fetchShallowActiveSteps(uuid, symbol, signalIds)
      const firedStepsByBasket = await this.loadFiredStepIndicesByBasket(uuid, symbol, signalIds)

      for (const [, basketLegs] of pendingByBasket) {
        if (!basketLegs.length) continue
        const sorted = [...basketLegs].sort((a, b) => a.step_idx - b.step_idx || a.id.localeCompare(b.id))
        const anchor = Number(sorted[0]!.anchor_price)
        const isBuy = sorted[0]!.is_buy
        const stepOffset = stepPriceOffsetForBasket(sorted) ?? 0
        if (stepOffset <= 0) continue

        const bk = `${sorted[0]!.signal_id}|${sorted[0]!.broker_account_id}`
        const highestFired = highestFiredStepIdxForBasket(firedStepsByBasket.get(bk) ?? [])

        const toFire = selectLegsForLayerTick({
          pendingLegs: sorted,
          isBuy,
          anchor,
          bid: q.bid,
          ask: q.ask,
          stepPriceOffset: stepOffset,
          highestFiredStepIdx: highestFired,
          maxFiresPerTick: DEFAULT_MAX_LAYER_FIRES_PER_TICK,
        })

        for (const leg of toFire) {
          if (isBlockedByShallowerStep(leg, activeStepsByBasket)) continue

          triggeredTotal += 1
          const layerCrossDetectedAt = Date.now()
          const result = await this.fireLeg(leg, q.bid, q.ask, {
            distanceBurst: { anchor, stepPriceOffset: stepOffset },
            timestamps: {
              market_tick_received_at: marketTickReceivedAt,
              layer_lookup_started_at: layerLookupStartedAt,
              layer_lookup_completed_at: layerLookupCompletedAt,
              layer_cross_detected_at: layerCrossDetectedAt,
            },
          })
          const outcome = this.recordFireLegResult(result, leg, activeStepsByBasket, firedStepsByBasket)
          if (outcome === 'fired') {
            firedOkTotal += 1
          } else if (outcome === 'failed') {
            firedErrTotal += 1
          }
        }
      }

      distances.push({ symbol, bid: q.bid, ask: q.ask, gapPriceUnits: nearestGap, legs: legs.length })
    }))

    if (triggeredTotal > 0) {
      console.log(
        `[virtualPendingMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`,
      )
      this.quietTicks = 0
    } else {
      // Heartbeat: log every ~30s (20 ticks × 1.5s) when there's work waiting
      // but no triggers crossing — makes "monitor is alive, just not hitting"
      // visible vs. "monitor is dead".
      this.quietTicks += 1
      if (this.quietTicks % 20 === 1) {
        const summary = distances
          .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gapPriceUnits) ? d.gapPriceUnits.toFixed(5) : 'n/a'} (${d.legs} legs)`)
          .join('; ')
        console.log(
          `[virtualPendingMonitor] heartbeat rows=${rows.length} groups=${groups.size} no triggers crossed yet — ${summary}`,
        )
      }
    }
  }

  private async detectAndLockTpTouchedBaskets(
    legs: PendingRow[],
    bid: number,
    ask: number,
  ): Promise<Set<string>> {
    const touched = new Set<string>()
    if (!legs.length) return touched

    const signalIds = [...new Set(legs.map(l => l.signal_id))]
    const brokerIds = [...new Set(legs.map(l => l.broker_account_id))]
    const symbol = legs[0]?.symbol ?? null
    if (!symbol) return touched

    // Scan open AND closed trades: a TP fill closes its rows at the broker
    // within seconds, so an open-only scan misses the touch (the remaining
    // open trades carry deeper TPs that were never reached).
    // Match XAUUSD ↔ XAUUSDm in memory (do not require exact symbol equality).
    const { data, error } = await this.supabase
      .from('trades')
      .select('signal_id,broker_account_id,user_id,direction,tp,status,symbol')
      .in('signal_id', signalIds)
      .in('broker_account_id', brokerIds)
      .in('status', ['open', 'closed'])

    if (error) {
      console.warn(`[virtualPendingMonitor] tp-touch scan failed: ${error.message}`)
      return touched
    }

    const byBasket = new Map<string, BasketOpenTpRow[]>()
    for (const row of (data ?? []) as Array<BasketOpenTpRow & { symbol?: string | null }>) {
      if (row.symbol && !symbolsCompatibleForBasket(symbol, row.symbol)) continue
      const basketKey = `${row.signal_id}|${row.broker_account_id}`
      const arr = byBasket.get(basketKey) ?? []
      arr.push(row)
      byBasket.set(basketKey, arr)
    }

    for (const [basketKey, rows] of byBasket) {
      const openRows = rows.filter(r => r.status === 'open')
      const closedCount = rows.length - openRows.length
      const direction = String((openRows[0] ?? rows[0])?.direction ?? '').toLowerCase()
      const openTps = openRows
        .map(r => Number(r.tp))
        .filter(tp => Number.isFinite(tp) && tp > 0)
      const decision = shouldLockBasketLayering({
        direction,
        openTps,
        openCount: openRows.length,
        closedCount,
        bid,
        ask,
      })
      if (!decision.lock) continue

      const [signalId, brokerAccountId] = basketKey.split('|')
      if (!signalId || !brokerAccountId) continue
      const userId = (openRows[0] ?? rows[0])?.user_id
      if (!userId) continue

      const layerTillClose = await loadRangeLayerTillCloseForSignal(
        this.supabase,
        signalId,
        brokerAccountId,
      )
      if (layerTillClose && decision.reason !== 'basket_fully_closed') {
        // Layer-till-close ON: keep layering (legs must keep firing, so do NOT
        // add to `touched`), but still record a sticky TP-touch marker so the
        // TP-distribution freeze engages — new legs get the deepest TP and
        // existing legs are never repainted after a TP is hit.
        // Fully flat baskets still fall through to stop/purge below.
        await setTpTouchedLock(this.supabase, {
          signalId,
          brokerAccountId,
          symbol,
          userId,
          lockReason: decision.reason ?? 'tp_touched',
          triggerPrice: decision.triggerPrice ?? null,
          triggerSide: decision.triggerSide ?? null,
        })
        continue
      }

      const { stopped, deleted } = await stopRangeLayeringUnlessEnabled(
        this.supabase,
        { signalId, brokerAccountId, symbol, userId },
        decision.reason ?? 'tp_touched',
      )
      if (!stopped) continue
      touched.add(basketKey)
      await writeExecutionLog(this.supabase, {
        user_id: userId,
        signal_id: signalId,
        broker_account_id: brokerAccountId,
        action: 'virtual_pending_tp_lock',
        status: 'info',
        request_payload: {
          symbol,
          direction,
          trigger_price: decision.triggerPrice,
          trigger_side: decision.triggerSide,
          lock_trigger: decision.reason,
          closed_trades: closedCount,
          open_trades: openRows.length,
          bid,
          ask,
          deleted_rows: deleted,
          lock_reason: 'layering_stopped',
        } as unknown as Record<string, unknown>,
      })
    }

    return touched
  }

  /** Undo a CAS claim when the fire-time price check fails — leg stays live. */
  private async releaseClaimedLegToPending(legId: string): Promise<void> {
    const { error } = await this.supabase
      .from('range_pending_legs')
      .update({ status: 'pending', claimed_at: null, claimed_by: null })
      .eq('id', legId)
      .eq('status', 'claimed')
    if (error) {
      console.warn(`[virtualPendingMonitor] release claim failed leg=${legId}: ${error.message}`)
    }
  }

  private recordFireLegResult(
    result: FireLegResult,
    leg: Pick<PendingRow, 'signal_id' | 'broker_account_id' | 'step_idx'>,
    activeStepsByBasket: Map<string, Set<number>>,
    firedStepsByBasket: Map<string, Set<number>>,
  ): FireLegResult['outcome'] {
    if (result.outcome !== 'fired') return result.outcome
    const legBk = `${leg.signal_id}|${leg.broker_account_id}`
    const activeSteps = activeStepsByBasket.get(legBk)
    activeSteps?.delete(leg.step_idx)
    const firedSteps = firedStepsByBasket.get(legBk) ?? new Set<number>()
    firedSteps.add(leg.step_idx)
    firedStepsByBasket.set(legBk, firedSteps)
    return result.outcome
  }

  /**
   * Enqueue a basket reconcile job for a freshly-filled range leg's basket.
   * Used when the post-fill SL/TP follow-up or TP rebalance fails, so the new
   * leg (and its siblings) converge to the channel SL/TP ladder on later
   * reconcile ticks instead of being left mis-aligned until the periodic sweep.
   */
  private async enqueueReconcileForLegBasket(
    leg: PendingRow,
    channelId: string | null,
  ): Promise<void> {
    try {
      const familyTrades = await loadOpenBasketLegs(
        this.supabase,
        leg.broker_account_id,
        leg.signal_id,
        leg.symbol,
      )
      if (!familyTrades.length) return
      const manualRaw = await this.loadManualSettingsForLeg(leg.broker_account_id, channelId)
      const manual = {
        range_trading: (manualRaw as { range_trading?: boolean }).range_trading === true,
        tp_lots: (manualRaw as { tp_lots?: unknown }).tp_lots as never,
      }
      const direction: 'buy' | 'sell' = leg.is_buy ? 'buy' : 'sell'
      const { perLegTargets, signalTps } = await resolveFreshBasketReconcileTargets(this.supabase, {
        anchorSignalId: leg.signal_id,
        channelId,
        symbol: leg.symbol,
        direction,
        userId: leg.user_id,
        brokerAccountId: leg.broker_account_id,
        familyTrades,
        storedTargets: [],
        manual,
        nImmCwe: 0,
        overrideTp: null,
      })
      if (!perLegTargets.length) return
      await upsertBasketReconcileJob(this.supabase, {
        userId: leg.user_id,
        brokerAccountId: leg.broker_account_id,
        anchorSignalId: leg.signal_id,
        sourceSignalId: leg.signal_id,
        channelId,
        symbol: leg.symbol,
        direction,
        perLegTargets,
        familyTrades,
        signalTps,
        tpLots: manual.tp_lots,
        virtualPendingsSnapshot: null,
        nImmCwe: 0,
        overrideTp: null,
        lastError: 'Range fill follow-up failed; reconcile basket SL/TP',
      })
    } catch (err) {
      console.warn(
        `[virtualPendingMonitor] enqueue reconcile failed leg=${leg.id}:`
        + ` ${err instanceof Error ? err.message : String(err)}`,
      )
      captureBusinessIssue({
        category: 'reconciliation',
        event: 'deferred_trade_follow_up_failed',
        severity: 'warning',
        reasonCode: 'BASKET_RECONCILE_ENQUEUE_FAILED',
        message: 'Range fill reconcile enqueue failed after follow-up failure',
        userImpact: 'delayed',
        context: {
          user_id: leg.user_id,
          signal_id: leg.signal_id,
          broker_account_id: leg.broker_account_id,
          pending_leg_id: leg.id,
          basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
          layer_plan_id: leg.layer_plan_id ?? null,
          layer_step_idx: leg.step_idx,
          symbol: leg.symbol,
          side: leg.is_buy ? 'buy' : 'sell',
          operation: 'range_fill_reconcile_enqueue',
        },
      })
    }
  }

  private async markLegFiredWithRetry(
    legId: string,
    ticket: number | string | null,
  ): Promise<void> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await markRangeLegFired(this.supabase, legId, ticket)
        return
      } catch (err) {
        lastErr = err
        await new Promise(r => setTimeout(r, 80 * (attempt + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async validateLayeringModePendingLeg(
    leg: PendingRow,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const planId = typeof leg.layer_plan_id === 'string' && leg.layer_plan_id.trim()
      ? leg.layer_plan_id.trim()
      : null
    if (!planId) return { ok: true }
    const { data, error } = await this.supabase
      .from('layering_plans')
      .select('status,layer_plan_metadata')
      .eq('layer_plan_id', planId)
      .maybeSingle()
    if (error || !data) return { ok: false, reason: 'layering_plan_not_found' }
    const status = String((data as { status?: unknown }).status ?? '')
    if (status !== 'active') return { ok: false, reason: `layering_plan_${status || 'unknown'}` }
    const parsed = parsePersistedLayeringPlan((data as { layer_plan_metadata?: unknown }).layer_plan_metadata)
    if (!parsed.ok) return { ok: false, reason: `layering_plan_${parsed.reason}` }
    const snapshot = parsed.snapshot
    if (
      snapshot.planId !== planId
      || snapshot.signalId !== leg.signal_id
      || snapshot.brokerAccountId !== leg.broker_account_id
      || snapshot.symbol !== leg.symbol
      || (snapshot.side === 'buy') !== leg.is_buy
      || snapshot.fundedPrices == null
      || snapshot.lots == null
    ) return { ok: false, reason: 'layering_plan_identity_mismatch' }
    const idx = leg.step_idx - 1
    if (idx < 0 || idx >= snapshot.fundedPrices.length) return { ok: false, reason: 'layering_plan_leg_index_mismatch' }
    if (snapshot.fundedPrices[idx] !== leg.trigger_price) return { ok: false, reason: 'layering_plan_price_mismatch' }
    if (snapshot.lots[idx] !== leg.volume) return { ok: false, reason: 'layering_plan_lot_mismatch' }
    const decision = resolveLayeringModeRolloutDecision({ mode: snapshot.mode, brokerAccountId: leg.broker_account_id })
    if (!decision.executionAllowed) return { ok: false, reason: `layering_execution_${decision.reason}` }
    return { ok: true }
  }

  private async fireLeg(
    leg: PendingRow,
    bid: number,
    ask: number,
    opts?: {
      distanceBurst?: { anchor: number; stepPriceOffset: number }
      timestamps?: LayerExecutionTimestamps
    },
  ): Promise<FireLegResult> {
    const api = apiForFxsocketAccount(this.platformByUuid, leg.metaapi_account_id)
    if (!api) return { outcome: 'skipped', reason: 'api_unavailable' }
    const timestamps: LayerExecutionTimestamps = { ...(opts?.timestamps ?? {}) }
    const planGuard = await this.validateLayeringModePendingLeg(leg)
    if (!planGuard.ok) return { outcome: 'skipped', reason: planGuard.reason }

    // Use the tick-level quote directly — it was fetched moments ago in this
    // same tick cycle. The monotonicity check below still prevents stale fires.
    const guardBid = bid
    const guardAsk = ask

    const burst = opts?.distanceBurst
    if (burst && burst.stepPriceOffset > 0) {
      if (!isLegEligibleByDistance(
        leg.is_buy,
        burst.anchor,
        guardBid,
        guardAsk,
        leg.step_idx,
        burst.stepPriceOffset,
      )) {
        return { outcome: 'skipped', reason: 'distance_not_eligible' }
      }
    } else if (!isTriggered(leg.is_buy, leg.trigger_price, guardBid, guardAsk)) {
      return { outcome: 'skipped', reason: 'not_triggered' }
    }

    // Flat/stale BEFORE claim — never OrderSend (or claim) when the basket is gone.
    const staleBeforeClaim = await this.getStaleLegReason(leg, api, leg.metaapi_account_id)
    if (staleBeforeClaim) {
      await deleteRangePendingLegsForBasket(
        this.supabase,
        { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
        staleBeforeClaim,
      )
      return { outcome: 'skipped', reason: staleBeforeClaim }
    }

    timestamps.layer_claim_started_at = Date.now()
    const { data: claimed, error: claimErr } = await this.supabase
      .from('range_pending_legs')
      .update({ status: 'claimed', claimed_at: new Date().toISOString(), claimed_by: this.hostId })
      .eq('id', leg.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (claimErr) {
      console.warn(`[virtualPendingMonitor] CAS claim error leg=${leg.id}: ${claimErr.message}`)
      incMetric('range_layer_claim_error')
      return { outcome: 'failed', reason: 'claim_error' }
    }
    if (!claimed) {
      incMetric('range_layer_claim_lost')
      return { outcome: 'not_claimed', reason: 'claim_lost' }
    }
    timestamps.layer_claim_acquired_at = Date.now()
    incMetric('range_layer_claim_acquired')

    const preSendPlanGuard = await this.validateLayeringModePendingLeg(leg)
    if (!preSendPlanGuard.ok) {
      await this.releaseClaimedLegToPending(leg.id)
      return { outcome: 'skipped', reason: preSendPlanGuard.reason }
    }

    const earlyParams = await this.getSymbolParams(leg.metaapi_account_id, leg.symbol)
    const earlyFireBid = guardBid
    const earlyFireAsk = guardAsk
    const earlyBand = fillWithinTriggerBand({
      isBuy: leg.is_buy,
      triggerPrice: leg.trigger_price,
      bid: earlyFireBid,
      ask: earlyFireAsk,
      slippagePoints: leg.slippage ?? 20,
      point: earlyParams?.point ?? null,
    })
    if (!earlyBand.ok) {
      await this.releaseClaimedLegToPending(leg.id)
      incMetric('range_layer_slippage_deferred')
      const now = Date.now()
      const last = this.bandSkipLogAt.get(leg.id) ?? 0
      if (now - last >= VirtualPendingMonitor.PROFIT_SKIP_LOG_MS) {
        this.bandSkipLogAt.set(leg.id, now)
        logLayerLatency('range_layer_execution_deferred', layerLatencyPayload(timestamps, {
          leg_id: leg.id,
          signal_id: leg.signal_id,
          broker_account_id: leg.broker_account_id,
          symbol: leg.symbol,
          step_idx: leg.step_idx,
          reason: earlyBand.reason,
          trigger_price: leg.trigger_price,
          bid: earlyFireBid,
          ask: earlyFireAsk,
        }))
      }
      return { outcome: 'skipped', reason: earlyBand.reason ?? 'trigger_band_rejected' }
    }

    const layerTillClose = await loadRangeLayerTillCloseForSignal(
      this.supabase,
      leg.signal_id,
      leg.broker_account_id,
    )
    const block = await shouldBlockVirtualLegFire(this.supabase, leg, {
      layerTillClose,
      quote: { bid: guardBid, ask: guardAsk },
      isBuy: leg.is_buy,
      distanceBurst: burst && burst.stepPriceOffset > 0
        ? { anchor: burst.anchor, stepPriceOffset: burst.stepPriceOffset, bid: guardBid, ask: guardAsk }
        : undefined,
    })
    if (block.block) {
      if (block.reason === 'basket_in_profit') {
        const bk = `${leg.signal_id}|${leg.broker_account_id}`
        const now = Date.now()
        const last = this.profitSkipLogAt.get(bk) ?? 0
        if (now - last >= VirtualPendingMonitor.PROFIT_SKIP_LOG_MS) {
          this.profitSkipLogAt.set(bk, now)
          console.log(
            `[virtualPendingMonitor] skip fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: basket_in_profit`,
          )
        }
      } else if (block.reason) {
        console.log(
          `[virtualPendingMonitor] skip fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: ${block.reason}`,
        )
      }
      await this.releaseClaimedLegToPending(leg.id)
      return { outcome: 'skipped', reason: block.reason ?? 'safety_blocked' }
    }

    // SL/TP may have been refreshed after this tick's queue SELECT (mgmt / basket refresh).
    try {
      const { data: freshRow } = await this.supabase
        .from('range_pending_legs')
        .select('stoploss,takeprofit,cwe_close_price')
        .eq('id', leg.id)
        .maybeSingle()
      if (freshRow) {
        leg.stoploss = (freshRow as { stoploss?: number | null }).stoploss ?? leg.stoploss
        leg.takeprofit = (freshRow as { takeprofit?: number | null }).takeprofit ?? leg.takeprofit
        leg.cwe_close_price = (freshRow as { cwe_close_price?: number | null }).cwe_close_price ?? leg.cwe_close_price
      }
    } catch {
      // best-effort — fire with stops from the tick snapshot
    }

    // A new layer must fire with the LATEST SL/TP, not the stale anchor value.
    // resolveEffectiveBasketStops is the same source of truth the rebalance and
    // reconcile paths use: latest Adjust signal (incl. entry edits) > channel
    // memory > anchor. When siblings are already at breakeven, this fill uses
    // its own entry + offset instead of the tightest sibling SL.
    let channelIdForTrade: string | null = null
    let openNewFillAtOwnBreakeven = false
    try {
      const { data: sigMeta } = await this.supabase
        .from('signals')
        .select('channel_id,created_at,parsed_data')
        .eq('id', leg.signal_id)
        .maybeSingle()
      channelIdForTrade = (sigMeta as { channel_id?: string } | null)?.channel_id ?? null
      const basketCreatedAt = (sigMeta as { created_at?: string } | null)?.created_at ?? null
      const anchorParsed = toRangeBasketParsedSlice(
        (sigMeta as { parsed_data?: { sl?: unknown; tp?: unknown } } | null)?.parsed_data,
      )
      const familyTrades = await loadOpenBasketLegs(
        this.supabase,
        leg.broker_account_id,
        leg.signal_id,
        leg.symbol,
      )
      const effective = await resolveEffectiveBasketStops({
        supabase: this.supabase,
        userId: leg.user_id,
        channelId: channelIdForTrade,
        anchorSignalId: leg.signal_id,
        symbol: leg.symbol,
        basketCreatedAt,
        anchorParsed,
        familyTrades,
        brokerAccountId: leg.broker_account_id,
      })
      const manualForBe = normalizeManualSettingsForExecution(
        await this.loadManualSettingsForLeg(leg.broker_account_id, channelIdForTrade),
      )
      const perLegBreakevenSl = resolvePerLegBreakevenSlForNewFill({
        familyTrades,
        effectiveSource: effective.source,
        isBuy: leg.is_buy,
        fillPrice: Number(leg.trigger_price) || 0,
        symbol: leg.symbol,
        manual: manualForBe,
      })
      openNewFillAtOwnBreakeven = perLegBreakevenSl != null
      const firing = resolveFiringLegStops({
        legStoploss: leg.stoploss,
        legTakeprofit: leg.takeprofit,
        cweClosePrice: leg.cwe_close_price,
        effective,
        isBuy: leg.is_buy,
        perLegBreakevenSl,
        effectiveSource: effective.source,
        symbol: leg.symbol,
      })
      if (firing.stoploss > 0) leg.stoploss = firing.stoploss
      if (leg.cwe_close_price == null && firing.takeprofit > 0) leg.takeprofit = firing.takeprofit
    } catch {
      // best-effort — fire with stops from pending leg row
    }

    // Re-check after claim — basket may have flattened while we held the claim.
    const staleReason = await this.getStaleLegReason(leg, api, leg.metaapi_account_id)
    if (staleReason) {
      await deleteRangePendingLegsForBasket(
        this.supabase,
        { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
        staleReason,
      )
      return { outcome: 'skipped', reason: staleReason }
    }

    const params = await this.getSymbolParams(leg.metaapi_account_id, leg.symbol)

    // Reuse the tick quote — already validated by monotonicity check above.
    const fireBid = guardBid
    const fireAsk = guardAsk
    const band = burst && burst.stepPriceOffset > 0
      ? fillWithinTriggerBand({
        isBuy: leg.is_buy,
        triggerPrice: leg.trigger_price,
        bid: fireBid,
        ask: fireAsk,
        slippagePoints: leg.slippage ?? 20,
        point: params?.point ?? null,
      })
      : fillWithinTriggerBand({
        isBuy: leg.is_buy,
        triggerPrice: leg.trigger_price,
        bid: fireBid,
        ask: fireAsk,
        slippagePoints: leg.slippage ?? 20,
        point: params?.point ?? null,
      })
    if (!band.ok) {
      await this.releaseClaimedLegToPending(leg.id)
      const now = Date.now()
      const last = this.bandSkipLogAt.get(leg.id) ?? 0
      if (now - last >= VirtualPendingMonitor.PROFIT_SKIP_LOG_MS) {
        this.bandSkipLogAt.set(leg.id, now)
        console.log(
          `[virtualPendingMonitor] defer fire leg=${leg.id} signal=${leg.signal_id} step=${leg.step_idx}: `
          + `${band.reason} trigger=${leg.trigger_price} bid=${fireBid} ask=${fireAsk}`,
        )
      }
      return { outcome: 'skipped', reason: band.reason ?? 'trigger_band_rejected' }
    }

    // Build a MARKET order. We DO NOT send `price` for Buy/Sell — the broker
    // fills at the current bid/ask. Stops were precomputed at planning time
    // against the live anchor; SL/TP from the original ladder stand.
    //
    // CWE-tagged legs (cwe_close_price != null) intentionally ship with
    // takeprofit = 0 — the close threshold is enforced post-fill by
    // cweCloseMonitor, not by the broker. Honouring the persisted
    // `takeprofit` here would re-introduce the "Invalid stops" rejections
    // that motivated this redesign (a TP on a buy that's already in profit
    // is on the wrong side of the market and the broker refuses).
    const args: OrderSendArgs = {
      symbol: leg.symbol,
      operation: leg.is_buy ? 'Buy' : 'Sell',
      volume: leg.volume,
      slippage: leg.slippage ?? 20,
      stoploss: leg.stoploss ?? 0,
      takeprofit: leg.cwe_close_price != null ? 0 : (leg.takeprofit ?? 0),
      comment: leg.comment ?? '',
      expertID: leg.expert_id ?? 909090,
    }
    timestamps.layer_execution_planned_at = Date.now()

    // Last-second SL/TP clamp using the fire-time quote as the reference.
    const refPrice = leg.is_buy ? fireAsk : fireBid
    const manual = normalizeManualSettingsForExecution(
      await this.loadManualSettingsForLeg(leg.broker_account_id, channelIdForTrade),
    )
    const predefinedSlFromFire = resolvePredefinedSlForEntry({
      manual,
      entry: refPrice,
      isBuy: leg.is_buy,
      symbol: leg.symbol,
      point: params?.point,
      digits: params?.digits,
      contractSize: params?.contractSize,
    })
    if (predefinedSlFromFire != null) {
      args.stoploss = predefinedSlFromFire
    }
    if (openNewFillAtOwnBreakeven) {
      const ownBe = breakevenStopLossForSymbol({
        isBuy: leg.is_buy,
        entryPrice: Number(refPrice) || 0,
        manual,
        symbol: leg.symbol,
        digits: params?.digits,
      })
      if (Number.isFinite(ownBe) && ownBe > 0) args.stoploss = ownBe
    }
    const predefinedTpFromFire = leg.cwe_close_price != null
      ? null
      : resolvePredefinedTpForEntry({
        manual,
        entry: refPrice,
        isBuy: leg.is_buy,
        symbol: leg.symbol,
        point: params?.point,
        digits: params?.digits,
        contractSize: params?.contractSize,
        existingTp: leg.takeprofit,
        matchEntry: Number(leg.trigger_price) > 0 ? Number(leg.trigger_price) : null,
      })
    if (predefinedTpFromFire != null) {
      args.takeprofit = predefinedTpFromFire
    }
    if (params) {
      const clamped = this.clampOrderStops(args, refPrice, params)
      if (clamped.adjustments.length) {
        console.warn(
          `[virtualPendingMonitor] stops clamped leg=${leg.id} symbol=${leg.symbol} op=${args.operation}: ${clamped.adjustments.join(', ')}`,
        )
      }
      Object.assign(args, clamped.args)
      // Sanity check the clamped result. The clamp only nudges to `ref ± minDist`,
      // which can still be invalid when the BROKER's effective stops_level is
      // larger than `/SymbolParams` reports (some MT5 builds quietly omit it).
      // If the resulting TP/SL is still on the wrong side of the live ref,
      // drop the offending side rather than send a doomed order — opening
      // without a TP is strictly better than not opening at all for an
      // averaging-down ladder.
      const cleanup = this.sanitizeStops(args, refPrice)
      if (cleanup.notes.length) {
        console.warn(
          `[virtualPendingMonitor] stops sanitized leg=${leg.id} symbol=${leg.symbol} op=${args.operation}: ${cleanup.notes.join(', ')}`,
        )
      }
      Object.assign(args, cleanup.args)
      // Shared basket SL/TP is often on the wrong side of a deeper range fill and
      // gets dropped. Restore Override signal SL/TP from this fire price.
      if (predefinedSlFromFire != null && !(Number(args.stoploss) > 0)) {
        args.stoploss = predefinedSlFromFire
      }
      if (predefinedTpFromFire != null && !(Number(args.takeprofit) > 0) && leg.cwe_close_price == null) {
        args.takeprofit = predefinedTpFromFire
      }
    }

    const t0 = Date.now()
    try {
      timestamps.broker_request_started_at = t0
      const result = await this.sendWithStopsFallback(leg, args)
      timestamps.broker_response_received_at = Date.now()
      // Mark fired immediately after OrderSend so a slow trades insert / log write
      // cannot leave the row `claimed` and get reset to `pending` (30s stale reclaim).
      await this.markLegFiredWithRetry(leg.id, result.ticket ?? null)
      timestamps.pending_leg_updated_at = Date.now()
      if (leg.layer_plan_id) {
        await convergeLayeringPlanAfterLegTerminal(this.supabase, leg.layer_plan_id)
      }
      const latencyMs = Date.now() - t0
      console.log(
        `[virtualPendingMonitor] virtual leg fired signal=${leg.signal_id} stepIdx=${leg.step_idx} trigger=${leg.trigger_price} ref=${refPrice} ticket=${result.ticket} latency=${latencyMs}ms`
        + (result.openedNaked ? ' naked=1' : ''),
      )
      const entryPx = result.openPrice ?? refPrice ?? null
      const predefinedSlFromFill = entryPx != null
        ? resolvePredefinedSlForEntry({
            manual,
            entry: entryPx,
            isBuy: leg.is_buy,
            symbol: leg.symbol,
            point: params?.point,
            digits: params?.digits,
            contractSize: params?.contractSize,
          })
        : null
      const predefinedTpFromFill = entryPx != null && leg.cwe_close_price == null
        ? resolvePredefinedTpForEntry({
            manual,
            entry: entryPx,
            isBuy: leg.is_buy,
            symbol: leg.symbol,
            point: params?.point,
            digits: params?.digits,
            contractSize: params?.contractSize,
            existingTp: leg.takeprofit,
            matchEntry: Number(leg.trigger_price) > 0 ? Number(leg.trigger_price) : null,
          })
        : null
      const desiredSl = (() => {
        if (openNewFillAtOwnBreakeven && entryPx != null) {
          const ownBe = breakevenStopLossForSymbol({
            isBuy: leg.is_buy,
            entryPrice: Number(entryPx),
            manual,
            symbol: leg.symbol,
            digits: params?.digits,
          })
          if (Number.isFinite(ownBe) && ownBe > 0) return ownBe
        }
        return predefinedSlFromFill
          ?? (Number(args.stoploss) > 0 ? Number(args.stoploss) : null)
      })()
      const desiredTp = predefinedTpFromFill
        ?? (Number(args.takeprofit) > 0 ? Number(args.takeprofit) : null)
      const brokerSl = Number(result.stopLoss) > 0 ? Number(result.stopLoss) : null
      const brokerTp = Number(result.takeProfit) > 0 ? Number(result.takeProfit) : null
      // Persist only what the broker actually has. Intended stops on a naked
      // open must not be written yet — that made skipAlreadySynced / follow-up
      // think the leg was done while MT still had SL=0/TP=0.
      const persistSl = result.openedNaked ? null : (brokerSl ?? desiredSl)
      const persistTp = result.openedNaked ? null : (brokerTp ?? desiredTp)
      const pipSize = signalPipPrice(leg.symbol)
      const autoBeCols = autoManagementTradeSnapshot(manual, entryPx, desiredSl ?? persistSl, {
        tpHitTriggerPrice: entryPx != null
          ? resolveAutoBeTpHitTriggerPriceFromManual({
            manual,
            entryPrice: Number(entryPx),
            isBuy: Boolean(leg.is_buy),
            pipSize,
            brokerTp: desiredTp ?? persistTp,
          })
          : null,
      })
      if (
        openNewFillAtOwnBreakeven
        && shouldStampAutoBeAppliedAt({
          appliedSl: persistSl ?? desiredSl,
          isBuy: Boolean(leg.is_buy),
          entryPrice: Number(entryPx),
          symbol: leg.symbol,
          manual,
        })
      ) {
        autoBeCols.auto_be_applied_at = new Date().toISOString()
      }
      const { data: insTrade, error: insErr } = await this.supabase.from('trades').insert({
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        telegram_channel_id: channelIdForTrade,
        broker_account_id: leg.broker_account_id,
        metaapi_order_id: result.ticket != null ? String(result.ticket) : null,
        symbol: leg.symbol,
        direction: leg.is_buy ? 'buy' : 'sell',
        entry_price: entryPx,
        sl: persistSl,
        tp: persistTp,
        lot_size: result.lots ?? args.volume,
        status: 'open',
        opened_at: new Date().toISOString(),
        // Carry the CWE threshold forward so cweCloseMonitor watches the
        // newly-filled leg alongside its sibling immediates. Null for
        // non-CWE pendings.
        cwe_close_price: leg.cwe_close_price,
        ...autoBeCols,
      }).select('id').maybeSingle()
      if (insErr) {
        // The broker position is open but we failed to record the trades row.
        // Surface it as an orphan so ops/reconcile can reconcile it from the
        // broker (reconcile-by-anchor cannot see a leg missing from `trades`).
        console.warn(`[virtualPendingMonitor] trades insert failed leg=${leg.id}: ${insErr.message}`)
        captureBusinessIssue({
          category: 'persistence',
          event: 'broker_success_persistence_failed',
          severity: 'error',
          reasonCode: 'BROKER_SUCCESS_DB_FAILURE',
          message: 'Range layer broker fill succeeded but trade row persistence failed',
          userImpact: 'manual_review_required',
          fingerprint: ['broker_success_persistence_failed', 'range_leg_trade_insert', 'BROKER_SUCCESS_DB_FAILURE'],
          context: {
            user_id: leg.user_id,
            signal_id: leg.signal_id,
            broker_account_id: leg.broker_account_id,
            pending_leg_id: leg.id,
            basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
            layer_plan_id: leg.layer_plan_id ?? null,
            layer_step_idx: leg.step_idx,
            stage: 'range_post_broker_success_persistence',
            symbol: leg.symbol,
            extra: {
              broker_ticket_present: result.ticket != null,
            },
          },
        })
        try {
          await writeExecutionLog(this.supabase, {
            user_id: leg.user_id,
            signal_id: leg.signal_id,
            broker_account_id: leg.broker_account_id,
            action: 'virtual_pending_orphan',
            status: 'failed',
            request_payload: {
              leg_id: leg.id,
              ticket: result.ticket ?? null,
              step_idx: leg.step_idx,
            } as unknown as Record<string, unknown>,
            error_message: `trades insert failed after fire: ${insErr.message}`,
          })
        } catch { /* best-effort */ }
      }

      const ticketNum = result.ticket != null ? Number(result.ticket) : NaN
      const tradeRowId = (insTrade as { id?: string } | null)?.id ?? null
      if (
        tradeRowId
        && Number.isFinite(ticketNum)
        && ticketNum > 0
      ) {
        // Naked open (invalid-stops fallback or broker ignored stops): assign now.
        if (result.openedNaked && (desiredSl || desiredTp)) {
          try {
            const outcome = await modifyLegSlTpWithFallback(
              api,
              leg.metaapi_account_id,
              ticketNum,
              desiredSl ?? 0,
              desiredTp ?? 0,
              desiredTp ? { deepestTp: desiredTp } : undefined,
            )
            if (outcome.ok) {
              const dbPatch: Record<string, number | null> = {}
              if (outcome.slApplied && outcome.appliedSl > 0) dbPatch.sl = outcome.appliedSl
              if (outcome.tpApplied && outcome.appliedTp > 0) dbPatch.tp = outcome.appliedTp
              if (Object.keys(dbPatch).length > 0) {
                await this.supabase.from('trades').update(dbPatch).eq('id', tradeRowId)
              }
              console.log(
                `[virtualPendingMonitor] post-naked stops assigned leg=${leg.id} ticket=${ticketNum}`
                + ` sl=${outcome.appliedSl || 0} tp=${outcome.appliedTp || 0} mode=${outcome.mode}`,
              )
            } else {
              console.warn(
                `[virtualPendingMonitor] post-naked stops failed leg=${leg.id} ticket=${ticketNum}:`
                + ` ${outcome.error ?? 'unknown'}`,
              )
              captureBusinessIssue({
                category: 'management',
                event: 'deferred_trade_follow_up_failed',
                severity: 'error',
                reasonCode: 'RANGE_LEG_POST_NAKED_STOPS_FAILED',
                message: 'Range layer opened naked and follow-up SL/TP assignment failed',
                userImpact: 'partial',
                context: {
                  user_id: leg.user_id,
                  signal_id: leg.signal_id,
                  broker_account_id: leg.broker_account_id,
                  pending_leg_id: leg.id,
                  trade_id: tradeRowId,
                  basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
                  layer_plan_id: leg.layer_plan_id ?? null,
                  layer_step_idx: leg.step_idx,
                  symbol: leg.symbol,
                  side: leg.is_buy ? 'buy' : 'sell',
                  operation: 'range_leg_post_naked_stops',
                  extra: { broker_database_state_may_disagree: true },
                },
              })
              await this.enqueueReconcileForLegBasket(leg, channelIdForTrade)
            }
          } catch (assignErr) {
            console.warn(`[virtualPendingMonitor] post-naked stops error leg=${leg.id}:`, assignErr)
            captureBusinessIssue({
              category: 'management',
              event: 'deferred_trade_follow_up_failed',
              severity: 'error',
              reasonCode: 'RANGE_LEG_POST_NAKED_STOPS_FAILED',
              message: 'Range layer opened naked and follow-up SL/TP assignment failed',
              userImpact: 'partial',
              context: {
                user_id: leg.user_id,
                signal_id: leg.signal_id,
                broker_account_id: leg.broker_account_id,
                pending_leg_id: leg.id,
                trade_id: tradeRowId,
                basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
                layer_plan_id: leg.layer_plan_id ?? null,
                layer_step_idx: leg.step_idx,
                symbol: leg.symbol,
                side: leg.is_buy ? 'buy' : 'sell',
                operation: 'range_leg_post_naked_stops',
              },
            })
            await this.enqueueReconcileForLegBasket(leg, channelIdForTrade)
          }
        }

        try {
          await tryApplyBasketFollowUpToNewFill(this.supabase, api, {
            userId: leg.user_id,
            basketSignalId: leg.signal_id,
            brokerAccountId: leg.broker_account_id,
            metaUuid: leg.metaapi_account_id,
            symbol: leg.symbol,
            ticket: ticketNum,
            tradeRowId,
            entryPrice: entryPx,
            // Force follow-up OrderModify when the broker open was naked.
            existingSl: result.openedNaked ? null : (brokerSl ?? desiredSl),
            existingTp: result.openedNaked ? null : (brokerTp ?? desiredTp),
            isBuy: leg.is_buy,
          })
        } catch (hookErr) {
          console.warn(
            `[virtualPendingMonitor] SL/TP follow-up for range leg=${leg.id} signal=${leg.signal_id}:`,
            hookErr,
          )
          captureBusinessIssue({
            category: 'management',
            event: 'deferred_trade_follow_up_failed',
            severity: 'error',
            reasonCode: 'RANGE_LEG_SL_TP_FOLLOW_UP_FAILED',
            message: 'Range layer SL/TP follow-up failed after layer execution',
            userImpact: 'partial',
            context: {
              user_id: leg.user_id,
              signal_id: leg.signal_id,
              broker_account_id: leg.broker_account_id,
              pending_leg_id: leg.id,
              trade_id: tradeRowId,
              basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
              layer_plan_id: leg.layer_plan_id ?? null,
              layer_step_idx: leg.step_idx,
              symbol: leg.symbol,
              side: leg.is_buy ? 'buy' : 'sell',
              operation: 'range_leg_sl_tp_follow_up',
            },
          })
          await this.enqueueReconcileForLegBasket(leg, channelIdForTrade)
        }
        // Brief pause so the new trade row is visible before the basket-wide rebalance query.
        await new Promise(r => setTimeout(r, Number(process.env.RANGE_REBALANCE_SETTLE_MS ?? 150)))
        try {
          await this.rebalanceRangeBasketTakeProfits(leg, { forceLayeringRebalance: true })
        } catch (rebalErr) {
          console.warn(
            `[virtualPendingMonitor] TP rebalance after range fill leg=${leg.id} signal=${leg.signal_id}:`,
            rebalErr,
          )
          captureBusinessIssue({
            category: 'management',
            event: 'basket_tp_sync_failed',
            severity: 'warning',
            reasonCode: 'RANGE_LEG_TP_REBALANCE_FAILED',
            message: 'Range layer basket TP rebalance failed after layer execution',
            userImpact: 'delayed',
            context: {
              user_id: leg.user_id,
              signal_id: leg.signal_id,
              broker_account_id: leg.broker_account_id,
              pending_leg_id: leg.id,
              trade_id: tradeRowId,
              basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
              layer_plan_id: leg.layer_plan_id ?? null,
              layer_step_idx: leg.step_idx,
              symbol: leg.symbol,
              side: leg.is_buy ? 'buy' : 'sell',
              operation: 'range_leg_tp_rebalance',
            },
          })
          await this.enqueueReconcileForLegBasket(leg, channelIdForTrade)
        }
        // Always enqueue reconcile after a naked open so the monitor retries
        // if OrderModify raced the fill.
        if (result.openedNaked) {
          await this.enqueueReconcileForLegBasket(leg, channelIdForTrade)
        }
      } else if (tradeRowId && Number.isFinite(ticketNum) && ticketNum > 0) {
        console.warn(
          `[virtualPendingMonitor] skip TP rebalance leg=${leg.id} signal=${leg.signal_id}: fxsocket not configured`,
        )
      }
      try {
        await writeExecutionLog(this.supabase, {
          user_id: leg.user_id,
          signal_id: leg.signal_id,
          broker_account_id: leg.broker_account_id,
          action: 'virtual_pending_fired',
          status: 'success',
          request_payload: {
            leg_id: leg.id,
            step_idx: leg.step_idx,
            trigger_price: leg.trigger_price,
            ref_price: refPrice,
            fill_price: entryPx,
            opened_naked: result.openedNaked === true,
            desired_sl: desiredSl,
            desired_tp: desiredTp,
          } as unknown as Record<string, unknown>,
          response_payload: { ticket: result.ticket, latency_ms: latencyMs, claimed_by: this.hostId },
        })
      } catch {
        /* logging is best-effort; leg is already `fired` */
      }

      if (!leg.layer_plan_id && entryPx != null && Number.isFinite(entryPx) && entryPx > 0) {
        try {
          const reanchor = await reanchorPendingLegsAfterGapFill({
            supabase: this.supabase,
            signalId: leg.signal_id,
            brokerAccountId: leg.broker_account_id,
            firedLegId: leg.id,
            firedStepIdx: leg.step_idx,
            isBuy: leg.is_buy,
            triggerPrice: leg.trigger_price,
            anchorPrice: leg.anchor_price,
            fillPrice: entryPx,
            slippagePoints: leg.slippage ?? 20,
            point: params?.point ?? null,
            digits: Math.max(0, Math.min(8, Number(params?.digits) || 5)),
          })
          if (reanchor.updated > 0) {
            console.log(
              `[virtualPendingMonitor] gap-fill reanchor signal=${leg.signal_id}`
              + ` step=${leg.step_idx} fill=${entryPx} updated=${reanchor.updated}`,
            )
            try {
              await writeExecutionLog(this.supabase, {
                user_id: leg.user_id,
                signal_id: leg.signal_id,
                broker_account_id: leg.broker_account_id,
                action: 'virtual_pending_reanchor',
                status: 'info',
                request_payload: {
                  fired_leg_id: leg.id,
                  fired_step_idx: leg.step_idx,
                  trigger_price: leg.trigger_price,
                  fill_price: entryPx,
                  updated: reanchor.updated,
                } as unknown as Record<string, unknown>,
              })
            } catch {
              /* best-effort */
            }
          }
        } catch (reanchorErr) {
          console.warn(
            `[virtualPendingMonitor] gap-fill reanchor failed leg=${leg.id} signal=${leg.signal_id}:`,
            reanchorErr,
          )
          captureBusinessIssue({
            category: 'layering',
            event: 'deferred_trade_follow_up_failed',
            severity: 'warning',
            reasonCode: 'RANGE_LEG_REANCHOR_FAILED',
            message: 'Range layer gap-fill reanchor failed after layer execution',
            userImpact: 'delayed',
            context: {
              user_id: leg.user_id,
              signal_id: leg.signal_id,
              broker_account_id: leg.broker_account_id,
              pending_leg_id: leg.id,
              basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
              layer_plan_id: leg.layer_plan_id ?? null,
              layer_step_idx: leg.step_idx,
              symbol: leg.symbol,
              side: leg.is_buy ? 'buy' : 'sell',
              operation: 'range_leg_reanchor',
              extra: { broker_database_state_may_disagree: true },
            },
          })
        }
      }
      timestamps.layer_reconciled_at = Date.now()
      incMetric('range_layer_execution_success')
      logLayerLatency('range_layer_execution_latency', layerLatencyPayload(timestamps, {
        leg_id: leg.id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        symbol: leg.symbol,
        step_idx: leg.step_idx,
        ticket: result.ticket ?? null,
      }))
      return { outcome: 'fired' }
    } catch (err) {
      timestamps.broker_response_received_at = timestamps.broker_response_received_at ?? Date.now()
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[virtualPendingMonitor] fire failed leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx}: ${msg}`,
      )
      if (isMtBridgeGlitchMessage(msg) || isTransientMtApiError(err)) {
        await this.supabase
          .from('range_pending_legs')
          .update({
            status: 'pending',
            claimed_at: null,
            claimed_by: null,
            error_message: null,
          })
          .eq('id', leg.id)
        incMetric('range_layer_execution_retry_released')
        console.warn(
          `[virtualPendingMonitor] transient fire error leg=${leg.id} — released back to pending for retry: ${msg}`,
        )
        return { outcome: 'failed', reason: 'transient_broker_error' }
      }
      await this.supabase
        .from('range_pending_legs')
        .update({ status: 'failed', error_message: msg, fired_at: new Date().toISOString() })
        .eq('id', leg.id)
      if (leg.layer_plan_id) {
        await convergeLayeringPlanAfterLegTerminal(this.supabase, leg.layer_plan_id)
      }
      timestamps.pending_leg_updated_at = Date.now()
      await writeExecutionLog(this.supabase, {
        user_id: leg.user_id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        action: 'virtual_pending_failed',
        status: 'failed',
        request_payload: { leg_id: leg.id, step_idx: leg.step_idx, claimed_by: this.hostId } as unknown as Record<string, unknown>,
        error_message: msg,
      })
      captureBusinessIssue({
        category: 'layering',
        event: 'layering_leg_execution_failed',
        severity: 'error',
        reasonCode: 'RANGE_LEG_FIRE_FAILED',
        message: 'Virtual range layer leg failed after final broker attempt',
        userImpact: 'failed',
        fingerprint: ['layering_leg_execution_failed', 'range_leg_fire', 'RANGE_LEG_FIRE_FAILED'],
        context: {
          user_id: leg.user_id,
          signal_id: leg.signal_id,
          broker_account_id: leg.broker_account_id,
          pending_leg_id: leg.id,
          basket_id: `${leg.signal_id}:${leg.broker_account_id}`,
          layer_plan_id: leg.layer_plan_id ?? null,
          layer_step_idx: leg.step_idx,
          stage: 'range_leg_fire',
          symbol: leg.symbol,
          operation: 'range_leg_fire',
          extra: { error: msg.slice(0, 180) },
        },
      })
      incMetric('range_layer_execution_failed')
      logLayerLatency('range_layer_execution_failed', layerLatencyPayload(timestamps, {
        leg_id: leg.id,
        signal_id: leg.signal_id,
        broker_account_id: leg.broker_account_id,
        symbol: leg.symbol,
        step_idx: leg.step_idx,
        error: msg,
      }))
      return { outcome: 'failed', reason: msg }
    }
  }

  /**
   * All `step_idx` values that still have a `pending` or `claimed` row for this
   * basket (same metaapi account + symbol). Used so deeper rungs never fire
   * before shallower ones on the same quote tick.
   */
  private async fetchShallowActiveSteps(
    metaapiAccountId: string,
    symbol: string,
    signalIds: string[],
  ): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>()
    if (!signalIds.length) return out
    const { data, error } = await this.supabase
      .from('range_pending_legs')
      .select('signal_id, broker_account_id, step_idx')
      .eq('metaapi_account_id', metaapiAccountId)
      .eq('symbol', symbol)
      .in('signal_id', signalIds)
      .in('status', ['pending', 'claimed'])
      .not('comment', 'ilike', '%:strictEntry%')
      .not('comment', 'ilike', '%:strictEntryAgg%')
    if (error) {
      console.warn(`[virtualPendingMonitor] fetchShallowActiveSteps failed: ${error.message}`)
      return out
    }
    for (const r of (data ?? []) as Array<{ signal_id: string; broker_account_id: string; step_idx: number }>) {
      const bk = `${r.signal_id}|${r.broker_account_id}`
      const s = out.get(bk) ?? new Set<number>()
      s.add(r.step_idx)
      out.set(bk, s)
    }
    return out
  }

  /** Fired step_idx values per basket for highestFiredStepIdx tracking. */
  private async loadFiredStepIndicesByBasket(
    metaapiAccountId: string,
    symbol: string,
    signalIds: string[],
  ): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>()
    if (!signalIds.length) return out
    const { data, error } = await this.supabase
      .from('range_pending_legs')
      .select('signal_id, broker_account_id, step_idx')
      .eq('metaapi_account_id', metaapiAccountId)
      .eq('symbol', symbol)
      .in('signal_id', signalIds)
      .eq('status', 'fired')
    if (error) {
      console.warn(`[virtualPendingMonitor] loadFiredStepIndices failed: ${error.message}`)
      return out
    }
    for (const r of (data ?? []) as Array<{ signal_id: string; broker_account_id: string; step_idx: number }>) {
      const bk = `${r.signal_id}|${r.broker_account_id}`
      const s = out.get(bk) ?? new Set<number>()
      s.add(r.step_idx)
      out.set(bk, s)
    }
    return out
  }

  private async getStaleLegReason(
    leg: PendingRow,
    api: ReturnType<typeof apiForFxsocketAccount> | null,
    metaapiAccountId: string,
  ): Promise<string | null> {
    return reconcileBasketFlatFromBroker(
      this.supabase,
      api ?? null,
      metaapiAccountId,
      { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
    )
  }

  private async cancelClaimedLeg(leg: PendingRow, reason: string): Promise<void> {
    await deleteRangePendingLegsForBasket(
      this.supabase,
      { signalId: leg.signal_id, brokerAccountId: leg.broker_account_id },
      reason,
    )
    await writeExecutionLog(this.supabase, {
      user_id: leg.user_id,
      signal_id: leg.signal_id,
      broker_account_id: leg.broker_account_id,
      action: 'virtual_pending_cancelled',
      status: 'info',
      request_payload: {
        leg_id: leg.id,
        step_idx: leg.step_idx,
        symbol: leg.symbol,
        reason,
        claimed_by: this.hostId,
      } as unknown as Record<string, unknown>,
    })
  }

  private async rebalanceRangeBasketTakeProfits(
    leg: Pick<PendingRow, 'user_id' | 'signal_id' | 'broker_account_id' | 'metaapi_account_id' | 'symbol' | 'is_buy'>,
    opts?: { forceLayeringRebalance?: boolean },
  ): Promise<void> {

    const { data: signalRow, error: signalErr } = await this.supabase
      .from('signals')
      .select('parsed_data, channel_id, created_at')
      .eq('id', leg.signal_id)
      .maybeSingle()
    if (signalErr) {
      console.warn(
        `[virtualPendingMonitor] signal load failed for rebalance signal=${leg.signal_id}: ${signalErr.message}`,
      )
      return
    }
    const channelId = (signalRow?.channel_id ?? null) as string | null
    const basketCreatedAt = (signalRow?.created_at ?? null) as string | null
    const rawManual = await this.loadManualSettingsForLeg(leg.broker_account_id, channelId)
    const manual = normalizeManualSettingsForExecution(rawManual)
    if (manual.range_trading !== true) return

    const api = apiForFxsocketAccount(this.platformByUuid, leg.metaapi_account_id)
    if (!api) return

    const params = await this.getSymbolParams(leg.metaapi_account_id, leg.symbol)
    const parsed = toRangeBasketParsedSlice(
      (signalRow?.parsed_data ?? null) as { sl?: unknown; tp?: unknown } | null,
    )

    await syncRangeBasketTakeProfits({
      supabase: this.supabase,
      api,
      uuid: leg.metaapi_account_id,
      symbol: leg.symbol,
      direction: leg.is_buy ? 'buy' : 'sell',
      baseLot: 0.01,
      params: params
        ? {
            digits: params.digits,
            point: params.point,
            minLot: params.minLot,
            lotStep: params.lotStep,
            contractSize: params.contractSize,
            stopsLevel: params.stopsLevel,
            freezeLevel: params.freezeLevel,
          }
        : null,
      signalId: leg.signal_id,
      userId: leg.user_id,
      brokerAccountId: leg.broker_account_id,
      manual,
      parsed,
      plan: null,
      forceLayeringRebalance: opts?.forceLayeringRebalance,
      channelId,
      basketCreatedAt,
    })
  }

  private async loadManualSettingsForLeg(
    brokerAccountId: string,
    channelId: string | null,
  ): Promise<Record<string, unknown>> {
    const cacheKey = `${brokerAccountId}|${channelId ?? ''}`
    const cached = this.brokerConfigCache.get(cacheKey)
    if (cached && Date.now() - cached.loadedAt < SYMBOL_TTL_MS) {
      return cached.manual
    }
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('manual_settings,channel_trading_configs,copier_mode,signal_channel_ids')
      .eq('id', brokerAccountId)
      .maybeSingle()
    if (error || !data) return {}
    const resolved = resolveChannelTradingConfig(
      data as {
        manual_settings?: Record<string, unknown> | null
        channel_trading_configs?: unknown
        copier_mode?: string | null
        signal_channel_ids?: string[] | null
      },
      channelId,
    )
    this.brokerConfigCache.set(cacheKey, {
      manual: resolved.manual_settings,
      loadedAt: Date.now(),
    })
    return resolved.manual_settings
  }

  private async getSymbolParams(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    const api = apiForFxsocketAccount(this.platformByUuid, uuid)
    if (!api) return null
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && (Date.now() - cached.loadedAt) < SYMBOL_TTL_MS) return cached
    try {
      const p: SymbolParams = await api.symbolParams(uuid, symbol)
      const n = normalizeSymbolParams(p)
      const entry: SymbolCacheEntry = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        minLot: n.minLot ?? 0.01,
        lotStep: n.lotStep ?? 0.01,
        contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
        stopsLevel: Math.max(0, n.stopsLevel ?? 0),
        freezeLevel: Math.max(0, n.freezeLevel ?? 0),
        loadedAt: Date.now(),
      }
      this.symbolCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }

  /**
   * Mirror of tradeExecutor.clampOrderStops — kept inline to avoid coupling the
   * monitor to the executor module. Push SL/TP outside the larger of
   * stops_level / freeze_level so MT5 can't reject the market send.
   */
  private clampOrderStops(args: OrderSendArgs, refPrice: number, params: SymbolCacheEntry): { args: OrderSendArgs; adjustments: string[] } {
    const adjustments: string[] = []
    const point = Number(params.point) || 0
    const minLevel = Math.max(params.stopsLevel, params.freezeLevel)
    const minDist = (minLevel + 2) * point
    if (point <= 0 || minDist <= 0 || refPrice <= 0) return { args, adjustments }

    const digits = Math.max(0, Math.min(8, Math.floor(params.digits)))
    const round = (v: number): number => Number(v.toFixed(digits))
    const isBuy = String(args.operation) === 'Buy'

    let sl = Number(args.stoploss) || 0
    let tp = Number(args.takeprofit) || 0
    const original = { sl, tp }

    if (isBuy) {
      if (sl > 0 && refPrice - sl < minDist) sl = round(refPrice - minDist)
      if (tp > 0 && tp - refPrice < minDist) tp = round(refPrice + minDist)
    } else {
      if (sl > 0 && sl - refPrice < minDist) sl = round(refPrice + minDist)
      if (tp > 0 && refPrice - tp < minDist) tp = round(refPrice - minDist)
    }

    if (sl !== original.sl) adjustments.push(`sl ${original.sl} → ${sl}`)
    if (tp !== original.tp) adjustments.push(`tp ${original.tp} → ${tp}`)
    if (adjustments.length === 0) return { args, adjustments }
    return { args: { ...args, stoploss: sl, takeprofit: tp }, adjustments }
  }

  /**
   * Final safety pass after `clampOrderStops`. If the clamped TP/SL is still on
   * the wrong side of the live reference price for the order's direction (which
   * happens when the broker's real stops_level is larger than `/SymbolParams`
   * reports, or when the signal TP was reached before our leg fired), drop the
   * bad side instead of sending a guaranteed-rejected order.
   */
  private sanitizeStops(args: OrderSendArgs, refPrice: number): { args: OrderSendArgs; notes: string[] } {
    if (!Number.isFinite(refPrice) || refPrice <= 0) return { args, notes: [] }
    const notes: string[] = []
    const isBuy = String(args.operation) === 'Buy'
    let sl = Number(args.stoploss) || 0
    let tp = Number(args.takeprofit) || 0
    if (isBuy) {
      // Buy: TP must sit ABOVE ref, SL must sit BELOW ref.
      if (tp > 0 && tp <= refPrice) {
        notes.push(`tp ${tp} <= ref ${refPrice} (wrong side for Buy) → dropping TP`)
        tp = 0
      }
      if (sl > 0 && sl >= refPrice) {
        notes.push(`sl ${sl} >= ref ${refPrice} (wrong side for Buy) → dropping SL`)
        sl = 0
      }
    } else {
      // Sell: TP must sit BELOW ref, SL must sit ABOVE ref.
      if (tp > 0 && tp >= refPrice) {
        notes.push(`tp ${tp} >= ref ${refPrice} (wrong side for Sell) → dropping TP`)
        tp = 0
      }
      if (sl > 0 && sl <= refPrice) {
        notes.push(`sl ${sl} <= ref ${refPrice} (wrong side for Sell) → dropping SL`)
        sl = 0
      }
    }
    if (notes.length === 0) return { args, notes }
    return { args: { ...args, stoploss: sl, takeprofit: tp }, notes }
  }

  /**
   * Send a market order; if the broker rejects with "Invalid stops" despite our
   * clamp/sanitize passes, retry once with SL=0 and TP=0 so the leg actually
   * opens. Caller must then OrderModify the intended stops — do not trust DB
   * alone, which previously recorded intended SL/TP while the broker stayed naked.
   */
  private async sendWithStopsFallback(
    leg: PendingRow,
    args: OrderSendArgs,
  ): Promise<{
    ticket?: number
    openPrice?: number
    lots?: number
    stopLoss?: number
    takeProfit?: number
    openedNaked: boolean
  }> {
    const api = apiForFxsocketAccount(this.platformByUuid, leg.metaapi_account_id)
    if (!api) throw new Error('api unavailable')
    const requestedSl = Number(args.stoploss) || 0
    const requestedTp = Number(args.takeprofit) || 0
    const requestedStops = requestedSl > 0 || requestedTp > 0
    try {
      const result = await api.orderSend(leg.metaapi_account_id, args)
      const brokerSl = Number(result.stopLoss) || 0
      const brokerTp = Number(result.takeProfit) || 0
      const openedNaked = requestedStops && !(brokerSl > 0) && !(brokerTp > 0)
      return { ...result, openedNaked }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const isInvalidStops = /invalid\s+stops/i.test(msg)
      const hasStops = requestedStops
      if (isInvalidStops && hasStops) {
        console.warn(
          `[virtualPendingMonitor] retry without stops leg=${leg.id} signal=${leg.signal_id} stepIdx=${leg.step_idx} reason="${msg}" (sl=${args.stoploss} tp=${args.takeprofit})`,
        )
        const fallback: OrderSendArgs = { ...args, stoploss: 0, takeprofit: 0 }
        const result = await api.orderSend(leg.metaapi_account_id, fallback)
        return { ...result, openedNaked: true }
      }
      throw err
    }
  }
}

let activeVirtualPendingMonitor: VirtualPendingMonitor | null = null

export function registerVirtualPendingMonitor(monitor: VirtualPendingMonitor): void {
  activeVirtualPendingMonitor = monitor
}

export async function runImmediateVirtualPendingCheck(
  signalId: string,
  brokerAccountId: string,
): Promise<void> {
  await activeVirtualPendingMonitor?.runImmediateCheck(signalId, brokerAccountId)
}
