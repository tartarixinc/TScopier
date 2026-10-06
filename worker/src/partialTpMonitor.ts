import os from 'node:os'
import type { SupabaseClient } from '@supabase/supabase-js'
import { type FxsocketBrokerClient } from './fxsocketClient'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import {
  brokerRuntimeForAccount,
  loadBrokerApiByAccountId,
  type BrokerApiByAccountId,
} from './mtApiByAccount'
import { stopRangeLayeringUnlessEnabled } from './rangeLayerTillClose'
import { resolveCanonicalOpenPosition, resolveCurrentLivePosition } from './livePositionIdentity'
import { isUserCopierPausedCached } from './copierPause'
import { isExplicitlyUnavailableRemoteBroker, type RemoteBrokerState } from './brokerRemoteAvailability'
import { isUnresolvableFailure } from './failureClassification'
import { historyTicketCloseMatch, type ClassifyTradeRow } from './openTradeClassification'

/**
 * Worker-side monitor that fires partial /OrderClose calls for single-mode
 * trades the moment the live /Quote crosses each configured early TP.
 *
 * Backstory — why a worker monitor instead of broker-side TPs:
 *   A single trade can only carry ONE broker takeprofit. Sending the
 *   percent-row rungs (TP1/TP2/...) to the broker isn't possible without
 *   splitting the position into separate orders (which is exactly what
 *   trade_style=='multi' already does). The user wants single-mode trades
 *   to ride to the deepest TP at the broker while the EARLIER TPs partial-
 *   close a slice of the position — so the early-TP cuts have to be
 *   enforced by us watching /Quote and calling /OrderClose with `lots = X`.
 *
 * Trigger semantics:
 *   buy  → fire when bid  >= trigger_price   (price rose to early TP)
 *   sell → fire when ask  <= trigger_price   (price fell to early TP)
 *
 * Lifecycle (same shape as range_pending_legs):
 *   pending  -> claimed  -> fired      (happy path)
 *   pending  -> claimed  -> failed     (OrderClose error; left to inspect)
 *   pending  -> cancelled              (parent trade closed by user / SL)
 *
 * Concurrency: a CAS update (status='pending' → 'claimed') gates the close
 * so two workers (or a worker + future edge cron) can never fire the same
 * partial twice.
 */

interface PartialRow {
  id: string
  trade_id: string
  signal_id: string
  user_id: string
  broker_account_id: string
  metaapi_account_id: string
  symbol: string
  is_buy: boolean
  tp_idx: number
  trigger_price: number
  close_lots: number
  status: string
}

interface ParentTradeRow {
  id: string
  metaapi_order_id: string | null
  status: string
  symbol: string
  direction: string
  lot_size: number
  entry_price: number | null
}

interface BrokerRow extends RemoteBrokerState {
  id: string
}

const ACTIVE_MS = monitorActiveIntervalMs('PARTIAL_TP_TICK_MS', 400)
const IDLE_MS = monitorIdleIntervalMs('PARTIAL_TP_IDLE_MS', 15_000)
const STALE_CLAIM_AFTER_MS = 30_000

/**
 * Pure trigger check. Same direction-aware comparison as virtualPendingMonitor's
 * `isTriggered`, just with the buy/sell sides inverted because here we're
 * watching for a profitable level (early TP) rather than an averaging-down
 * level (range pending).
 *
 *   buy  → close when bid  >= triggerPrice
 *   sell → close when ask  <= triggerPrice
 *
 * Returns false on NaN / non-positive inputs so a flaky /Quote can never
 * cause a spurious partial close.
 */
export function isPartialTpTriggered(isBuy: boolean, triggerPrice: number, bid: number, ask: number): boolean {
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return false
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return false
  return isBuy ? bid >= triggerPrice : ask <= triggerPrice
}

/** Keeps non-open parent trades out of the quote/close path without mutating their legs. */
export function shouldMonitorPartialTpLeg(
  leg: Pick<PartialRow, 'broker_account_id' | 'trade_id'>,
  unavailableBrokerIds: ReadonlySet<string>,
  openParentIds: ReadonlySet<string>,
): boolean {
  return !unavailableBrokerIds.has(leg.broker_account_id) && openParentIds.has(leg.trade_id)
}

/**
 * Broker replies that mean "the parent position is already gone" for a
 * partial-TP /OrderClose attempt. When matched, the partial leg is cancelled
 * and the parent trade closed instead of retrying forever.
 *
 * `unknown ticket` must be here: FxSocket replies "unknown ticket" when it no
 * longer knows the position (closed by SL/broker TP/user). Without it the
 * monitor rolled the leg back to `pending` and retried every ~400ms for days
 * (prod incident 2026-08-10, trade 1278201 — 505 errors in 14.5 min).
 */
export function isPartialTpBenignBrokerError(message: string): boolean {
  return /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order|unknown\s+ticket|\b4108\b|invalid\s+request/i.test(message)
}

/**
 * Read a positive-numeric env var, falling back when it is unset, empty,
 * non-numeric or non-positive (`Math.max(1, Number('garbage'))` is `NaN`, and a
 * `NaN` backoff would either never retry or never terminate — see
 * `monitorIdleGate` for the same guard). Floored by `min` afterwards.
 */
function envPositive(name: string, fallback: number, min = 1): number {
  const raw = Number(process.env[name] ?? '')
  const value = Number.isFinite(raw) && raw > 0 ? raw : fallback
  return Math.max(min, value)
}

/** Throttle failed trade_execution_logs rows per leg so a stuck leg cannot flood the table. */
const FAILURE_LOG_THROTTLE_MS = envPositive('PARTIAL_TP_FAILURE_LOG_THROTTLE_MS', 5 * 60_000, 60_000)
/**
 * Per-leg retry backoff. A leg whose close keeps failing must not be re-driven
 * every tick — it costs a /Quote, an /OpenedOrders read and a failed log row
 * each time (prod 2026-10-05: 929 attempts and 571 junk rows in two hours from
 * one leg). Two classes, same split as autoManagementMonitor:
 *   - unresolvable: the stored ticket maps to no live position, only
 *     reconciliation can fix it → long, escalating backoff;
 *   - transient: rate limit, quote/network error → short backoff so a real
 *     partial close is not delayed for long.
 */
const TRANSIENT_BACKOFF_BASE_MS = envPositive('PARTIAL_TP_TRANSIENT_BACKOFF_MS', 5_000, 250)
const TRANSIENT_BACKOFF_MAX_MS = envPositive(
  'PARTIAL_TP_TRANSIENT_BACKOFF_MAX_MS',
  60_000,
  TRANSIENT_BACKOFF_BASE_MS,
)
const UNRESOLVABLE_BACKOFF_BASE_MS = envPositive('PARTIAL_TP_BACKOFF_MS', 30_000, 1_000)
const UNRESOLVABLE_BACKOFF_MAX_MS = envPositive(
  'PARTIAL_TP_BACKOFF_MAX_MS',
  30 * 60_000,
  UNRESOLVABLE_BACKOFF_BASE_MS,
)
/** Consecutive unresolvable failures before a terminal cancel may even be attempted. */
const TERMINAL_CANCEL_AFTER = envPositive('PARTIAL_TP_TERMINAL_CANCEL_AFTER', 4, 2)
/** A post-close `fired` write is retried this many times: leaving the row
 *  `pending` would get the same slice closed a second time on the next tick. */
const FIRE_WRITE_ATTEMPTS = 3
/** Delay between those retries, multiplied by the attempt number. */
const FIRE_WRITE_RETRY_MS = 250
/**
 * After this many unresolvable failures the leg is parked at a long delay: the
 * proof gates have clearly not been satisfied, so re-checking every 30 min
 * forever (≈48 log lines a day, per leg) helps nobody. Still retrying — a leg
 * is never given up on, because only a retry can observe the close.
 */
const PARK_AFTER = envPositive('PARTIAL_TP_PARK_AFTER', 3 * TERMINAL_CANCEL_AFTER, TERMINAL_CANCEL_AFTER + 1)
const PARK_DELAY_MS = envPositive('PARTIAL_TP_PARK_MS', 6 * 60 * 60_000, UNRESOLVABLE_BACKOFF_MAX_MS)
/** Closed-history window for the terminal-cancel proof (matches openTradeReconcile). */
const TERMINAL_CANCEL_HISTORY_DAYS = envPositive('PARTIAL_TP_HISTORY_DAYS', 30)

export type PartialFailureClass = 'transient' | 'unresolvable'

/**
 * Classify a failure the same way autoManagementMonitor does. Anything matching
 * `isUnresolvableFailure` (no live position match, ambiguous identity,
 * reconciliation required) cannot be fixed by retrying; everything else is
 * treated as transient.
 */
export function partialFailureClass(message: string): PartialFailureClass {
  return isUnresolvableFailure(message) ? 'unresolvable' : 'transient'
}

/**
 * Consecutive-failure counter. A failure of a different class than the previous
 * one starts that class's counter at 1 (so a flapping rate limit can never grow
 * the unresolvable counter, and transient delays escalate on their own).
 *
 * Pure and jitter-free so the count-reset invariant can be tested directly.
 */
export function nextPartialFailureCount(
  previous: { count: number; cls: PartialFailureClass } | undefined,
  cls: PartialFailureClass,
): number {
  return previous && previous.cls === cls ? previous.count + 1 : 1
}

/**
 * Exponential delay before the next attempt, in milliseconds. Deterministic
 * (jitter is applied by the caller) so tests can assert exact values.
 * `count` is the number of consecutive failures of that class; 0/1 → base.
 * Unresolvable legs switch to a long park delay once `PARK_AFTER` is reached.
 */
export function partialRetryDelayMs(count: number, cls: PartialFailureClass): number {
  if (cls === 'unresolvable' && count >= PARK_AFTER) return PARK_DELAY_MS
  const base = cls === 'unresolvable' ? UNRESOLVABLE_BACKOFF_BASE_MS : TRANSIENT_BACKOFF_BASE_MS
  const max = cls === 'unresolvable' ? UNRESOLVABLE_BACKOFF_MAX_MS : TRANSIENT_BACKOFF_MAX_MS
  const step = Math.min(Math.max(count, 1), 30)
  return Math.min(max, base * 2 ** (step - 1))
}

/**
 * Terminal cancel gate — every condition must hold, so a cancel can only happen
 * with positive proof and never on a guess:
 *   - enough consecutive unresolvable failures (backoff has had its chance);
 *   - the session answers a health probe (an unhealthy session proves nothing);
 *   - a fresh live-position read no longer contains the stored ticket
 *     (absence — a false-empty snapshot fails this);
 *   - the stored ticket appears in history as a REAL CLOSE (positive proof).
 * Missing proof means the leg keeps its backoff — the row is never cancelled.
 */
export function shouldTerminatePartialLeg(
  input: {
    unresolvableCount: number
    healthOk: boolean
    absentFromLive: boolean
    historyCloseMatched: boolean
  },
  /** Threshold from `PARTIAL_TP_TERMINAL_CANCEL_AFTER`; injectable so a test
   *  can never be silently reinterpreted by the ambient environment. */
  unresolvableAfter: number = TERMINAL_CANCEL_AFTER,
): boolean {
  return input.unresolvableCount >= unresolvableAfter
    && input.healthOk
    && input.absentFromLive
    && input.historyCloseMatched
}

/** A session probe may only authorise a cancel when it resolves (same rule as openTradeReconcile). */
async function sessionIsHealthy(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe()
    return true
  } catch {
    return false
  }
}

/** The resolver can only recognise a position when the trade row carries enough
 *  identity (symbol + direction + lots/entry). Without those, "not found" and
 *  "cannot look" are indistinguishable — so it may never prove absence. */
function identityAttributesUsable(trade: ClassifyTradeRow): boolean {
  const direction = String(trade.direction ?? '').trim().toLowerCase()
  const lots = Number(trade.lot_size)
  const entry = Number(trade.entry_price)
  return Boolean(String(trade.symbol ?? '').trim())
    && (direction === 'buy' || direction === 'sell')
    && ((Number.isFinite(lots) && lots > 0) || (Number.isFinite(entry) && entry > 0))
}

/**
 * Fresh live-position read for the terminal-cancel proof.
 *   `true`  — two independent, complete reads both report no match for the trade;
 *   `false` — the trade still resolves to (or is ambiguous with) a live position;
 *   `null`  — a read failed, was not a complete list, or the trade row cannot be
 *             recognised, so absence cannot be established.
 *
 * Two reads because a single empty `OpenedOrders` answer is not proof a
 * position is gone (a live session can answer empty while syncing, or for the
 * wrong account) — the same rule `openTradeReconcile` applies. Identity is
 * resolved with `resolveCanonicalOpenPosition`, the same resolver that produced
 * the failure, so the gate cannot disagree with it about what "live" means.
 */
export async function liveTicketAbsent(
  api: FxsocketBrokerClient,
  sessionId: string,
  trade: ClassifyTradeRow,
): Promise<boolean | null> {
  // Without a stored ticket the resolver answers "missing" without ever
  // looking at the rows, so absence must not be claimed for a trade that was
  // never looked up.
  const storedRaw = Number(trade.metaapi_order_id)
  if (!Number.isFinite(storedRaw) || storedRaw <= 0) return null
  // Checked before any broker call: a trade this resolver can never recognise
  // would otherwise spend a read per attempt to reach the same conclusion.
  if (!identityAttributesUsable(trade)) return null
  let first: unknown[]
  try {
    const open = await api.openedOrders(sessionId)
    if (!Array.isArray(open)) return null
    first = open
  } catch {
    return null
  }
  if (resolveCanonicalOpenPosition({ trade, openedOrders: first }).status !== 'missing') return false

  try {
    const again = await api.openedOrders(sessionId)
    if (!Array.isArray(again)) return null
    return resolveCanonicalOpenPosition({ trade, openedOrders: again }).status === 'missing'
  } catch {
    return null
  }
}

/**
 * Positive close proof for the terminal-cancel gate.
 *   `true` — history holds a real closing row for this trade's ticket;
 *   `false` — no such row (an open-position echo does not count);
 *   `null` — the history read failed, so it proves nothing.
 */
export async function historyCloseProven(
  api: FxsocketBrokerClient,
  sessionId: string,
  trade: ClassifyTradeRow,
  provider: string = 'mtapi',
): Promise<boolean | null> {
  try {
    return historyTicketCloseMatch(trade, await loadClosedHistory(api, sessionId), provider)
  } catch {
    return null
  }
}

function mtDate(d: Date): string {
  return d.toISOString().slice(0, 19)
}

async function loadClosedHistory(api: FxsocketBrokerClient, sessionId: string): Promise<unknown[]> {
  const to = mtDate(new Date())
  const from = mtDate(new Date(Date.now() - TERMINAL_CANCEL_HISTORY_DAYS * 86_400_000))
  return (await api.orderHistory(sessionId, from, to)) ?? []
}

export class PartialTpMonitor {
  private loop: MonitorLoopHandle | null = null
  private runtimeByBroker: BrokerApiByAccountId = new Map()
  private hostId: string
  private ticking = false
  private firstTickLogged = false
  /** Heartbeat counter so we log one summary line every ~30s when there's
   *  work waiting but no triggers crossing. */
  private quietTicks = 0
  /** Per-leg retry state so a permanently-failing leg backs off instead of hot-looping. */
  private failureByPartial = new Map<string, { count: number; cls: PartialFailureClass; nextAt: number }>()
  /** Why the last attempt for a leg failed, to pick transient vs unresolvable backoff. */
  private failureClassByPartial = new Map<string, PartialFailureClass>()
  /** Per-leg cooldown so a stuck leg writes at most one failed log row per window. */
  private failureLogCooldownUntil = new Map<string, number>()
  /** Per broker|symbol cooldown for /Quote failures. Kept OUT of the per-leg
   *  failure state on purpose: a flaky quote endpoint must not reset a leg's
   *  unresolvable counter (which would delay the terminal cancel indefinitely)
   *  nor push legs that never failed into backoff. */
  private quoteBackoff = new Map<string, { count: number; cls: PartialFailureClass; nextAt: number }>()

  constructor(private readonly supabase: SupabaseClient) {
    this.hostId = `worker:${os.hostname()}:${process.pid}`
  }

  start() {
    if (this.loop) return
    const staleCutoff = () => new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    this.loop = startMonitorLoop({
      name: 'partialTpMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: async sb => {
        const pending = await hasWorkOnShard(sb, 'partial_tp_legs', q => q.eq('status', 'pending'))
        if (pending) return true
        return hasWorkOnShard(sb, 'partial_tp_legs', q =>
          q.eq('status', 'claimed').lt('claimed_at', staleCutoff()),
        )
      },
      tick: () => this.runTick(),
    })
    console.log(`[partialTpMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private markFailureClass(partialId: string, message: string): PartialFailureClass {
    const cls = partialFailureClass(message)
    this.failureClassByPartial.set(partialId, cls)
    return cls
  }

  /**
   * Push the next attempt of a leg out by an exponential delay.
   *
   * Counters are consecutive-per-class: only unresolvable failures can build up
   * to the terminal-cancel threshold, and a transient failure restarts that
   * counter, so a flapping rate limit can never authorise a cancel.
   *
   * State lives in this process's memory (same trade-off as
   * `autoManagementMonitor`): every running replica keeps its own counter, its
   * own next-attempt time and its own copy of the log throttle, so the volume
   * reduction is divided by N when N replicas pick up the same leg. Persisting
   * the counter needs a schema change and is a documented follow-up. The cancel
   * itself stays single-winner regardless, because it is CAS'd on
   * `status='pending'` in `terminateStuckLeg`.
   */
  private registerFailure(partialId: string, cls: PartialFailureClass): void {
    const prev = this.failureByPartial.get(partialId)
    const count = nextPartialFailureCount(prev, cls)
    const delay = partialRetryDelayMs(count, cls)
    // Jitter only shrinks (never exceeds `delay`) so the cap is a real cap.
    const jittered = delay * (0.75 + Math.random() * 0.25)
    this.failureByPartial.set(partialId, { count, cls, nextAt: Date.now() + jittered })
    if (cls === 'unresolvable' && count === PARK_AFTER) {
      console.warn(
        `[partialTpMonitor] parking partial=${partialId} after ${count} unresolvable attempts`
        + ` (no closure proof yet; will retry every ~${Math.round(PARK_DELAY_MS / 60_000)}min)`,
      )
    }
  }

  private clearFailure(partialId: string): void {
    this.failureByPartial.delete(partialId)
    this.failureClassByPartial.delete(partialId)
    this.failureLogCooldownUntil.delete(partialId)
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

  private async tick(): Promise<void> {
    // Re-claim stuck rows so a crashed worker can't strand a partial. Same
    // 30s threshold as virtualPendingMonitor.
    const staleCutoff = new Date(Date.now() - STALE_CLAIM_AFTER_MS).toISOString()
    await this.supabase
      .from('partial_tp_legs')
      .update({ status: 'pending', claimed_at: null, claimed_by: null })
      .eq('status', 'claimed')
      .lt('claimed_at', staleCutoff)

    const legsQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('partial_tp_legs')
        .select('id,trade_id,signal_id,user_id,broker_account_id,metaapi_account_id,symbol,is_buy,tp_idx,trigger_price,close_lots,status')
        .eq('status', 'pending')
        .limit(500),
    )
    if (!legsQ) return
    const { data, error } = await legsQ
    if (error) {
      console.error('[partialTpMonitor] select failed:', error.message)
      return
    }
    // Every pending row, before any filtering. Retry state is pruned against
    // this set, not against the paused-filtered one: a paused copier must not
    // wipe that user's backoff counters (the unresolvable count toward the
    // terminal-cancel threshold would restart at 1 on unpause).
    const pendingRows = (data ?? []) as PartialRow[]
    const rows = pendingRows.filter(r => !isUserCopierPausedCached(r.user_id))
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[partialTpMonitor] first tick ok pending_rows=${rows.length}`)
    }

    // Drop retry state for legs that are no longer pending (and cooldowns for
    // groups with no pending leg), so these maps stay bounded over the process
    // lifetime. Runs before the empty check: no pending rows means nothing to
    // remember.
    const liveIds = new Set(pendingRows.map(r => r.id))
    for (const key of this.failureByPartial.keys()) if (!liveIds.has(key)) this.failureByPartial.delete(key)
    for (const key of this.failureClassByPartial.keys()) if (!liveIds.has(key)) this.failureClassByPartial.delete(key)
    for (const key of this.failureLogCooldownUntil.keys()) if (!liveIds.has(key)) this.failureLogCooldownUntil.delete(key)
    const liveGroupKeys = new Set(pendingRows.map(r => `${r.broker_account_id}|${r.symbol}`))
    for (const key of this.quoteBackoff.keys()) if (!liveGroupKeys.has(key)) this.quoteBackoff.delete(key)

    if (!rows.length) {
      this.quietTicks = 0
      return
    }

    // Skip legs still inside their backoff window BEFORE any broker call: a
    // leg that keeps failing must not produce a /Quote, an /OpenedOrders read
    // or a failed log row on every tick.
    const tickNow = Date.now()
    const workRows = rows.filter(r => (this.failureByPartial.get(r.id)?.nextAt ?? 0) <= tickNow)
    if (!workRows.length) return

    // A removed dormant-subscription session intentionally remains as a broker
    // row/trade history. Never turn that known cleanup state into /Quote spam.
    const brokerIds = [...new Set(workRows.map(r => r.broker_account_id).filter(Boolean))]
    const { data: brokers, error: brokerErr } = await this.supabase
      .from('broker_accounts')
      .select('id,fxsocket_status,connection_status,terminal_connected,trade_allowed')
      .in('id', brokerIds)
    if (brokerErr) {
      console.warn(`[partialTpMonitor] broker load failed: ${brokerErr.message}`)
      return
    }
    const unavailableBrokerIds = new Set(
      ((brokers ?? []) as BrokerRow[])
        .filter(isExplicitlyUnavailableRemoteBroker)
        .map(broker => broker.id),
    )

    // A pending parent has no live broker position. Filter before grouping so
    // it cannot produce a quote request or mutate the partial leg.
    const tradeIds = [...new Set(workRows.map(r => r.trade_id))]
    const { data: parents, error: parentErr } = await this.supabase
      .from('trades')
      .select('id,status')
      .in('id', tradeIds)
    if (parentErr) {
      console.warn(`[partialTpMonitor] parent trade load failed: ${parentErr.message}`)
      return
    }
    const openParentIds = new Set(
      ((parents ?? []) as ParentTradeRow[]).filter(parent => parent.status === 'open').map(parent => parent.id),
    )
    const monitorableRows = workRows.filter(row =>
      shouldMonitorPartialTpLeg(row, unavailableBrokerIds, openParentIds),
    )
    if (!monitorableRows.length) return

    // Resolve each account's live connection at execution time, so a leg is
    // only grouped when its broker has a stable, current writer.
    this.runtimeByBroker = await loadBrokerApiByAccountId(this.supabase, brokerIds)

    // Group by current broker-account authority and symbol → at most ONE /Quote per group
    // per tick. Same shape as the other monitors for consistency.
    const groups = new Map<string, PartialRow[]>()
    for (const r of monitorableRows) {
      if (!brokerRuntimeForAccount(this.runtimeByBroker, r.broker_account_id)) continue
      const key = `${r.broker_account_id}|${r.symbol}`
      const list = groups.get(key) ?? []
      list.push(r)
      groups.set(key, list)
    }

    let triggeredTotal = 0
    let firedOkTotal = 0
    let firedErrTotal = 0
    const distances: Array<{ symbol: string; bid: number; ask: number; gap: number; legs: number }> = []

    await Promise.all(Array.from(groups.entries()).map(async ([key, partials]) => {
      const [brokerAccountId, symbol] = key.split('|')
      if (!brokerAccountId || !symbol) return
      // A group whose quote endpoint just failed waits it out here: no per-leg
      // failure state is touched, so a flaky /Quote cannot reset a leg's
      // unresolvable counter or delay legs that never failed.
      const quoteState = this.quoteBackoff.get(key)
      if (quoteState && quoteState.nextAt > Date.now()) return
      const runtime = brokerRuntimeForAccount(this.runtimeByBroker, brokerAccountId)
      if (!runtime) return
      const { api, sessionId: uuid } = runtime
      let q
      try {
        q = await api.quote(uuid, symbol)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const count = nextPartialFailureCount(quoteState, 'transient')
        const delay = partialRetryDelayMs(count, 'transient')
        this.quoteBackoff.set(key, { count, cls: 'transient', nextAt: Date.now() + delay * (0.75 + Math.random() * 0.25) })
        console.warn(`[partialTpMonitor] /Quote failed for ${symbol} (account=${uuid}), retrying group in ~${Math.round(delay / 1000)}s: ${msg}`)
        return
      }
      this.quoteBackoff.delete(key)
      let nearestGap = Number.POSITIVE_INFINITY
      for (const partial of partials) {
        const ref = partial.is_buy ? q.bid : q.ask
        // For buys: positive gap = bid still BELOW trigger (waiting for rise).
        // For sells: positive gap = ask still ABOVE trigger (waiting for fall).
        const gap = partial.is_buy ? partial.trigger_price - ref : ref - partial.trigger_price
        if (Number.isFinite(gap) && gap < nearestGap) nearestGap = gap
        if (!isPartialTpTriggered(partial.is_buy, partial.trigger_price, q.bid, q.ask)) continue
        triggeredTotal += 1
        const result = await this.firePartial(partial, api, uuid, q.bid, q.ask)
        if (result === 'fired') {
          firedOkTotal += 1
          this.clearFailure(partial.id)
        } else if (result === 'failed') {
          firedErrTotal += 1
          this.registerFailure(partial.id, this.failureClassByPartial.get(partial.id) ?? 'transient')
          const state = this.failureByPartial.get(partial.id)
          // Only after the backoff has been given a fair chance: prove the
          // parent closed, or keep waiting.
          if (state && state.cls === 'unresolvable' && state.count >= TERMINAL_CANCEL_AFTER) {
            // Same resolution as `apiForBrokerAccount` (`providerResolver`), so the
            // label used to judge history can never diverge from the API it came from.
            await this.terminateStuckLeg(partial, api, uuid, state.count, runtime.provider || 'fxsocket')
          }
        }
        // 'skipped' = another worker won the race, or the leg was cancelled by
        // the parent-not-open check. No failure state is recorded.
      }
      distances.push({ symbol, bid: q.bid, ask: q.ask, gap: nearestGap, legs: partials.length })
    }))

    if (triggeredTotal > 0) {
      console.log(
        `[partialTpMonitor] tick rows=${rows.length} groups=${groups.size} triggered=${triggeredTotal} fired=${firedOkTotal}_ok ${firedErrTotal}_err`,
      )
      this.quietTicks = 0
    } else {
      this.quietTicks += 1
      if (this.quietTicks % 20 === 1) {
        const summary = distances
          .map(d => `${d.symbol} bid=${d.bid} ask=${d.ask} nearest_gap=${Number.isFinite(d.gap) ? d.gap.toFixed(5) : 'n/a'} (${d.legs} legs)`)
          .join('; ')
        console.log(
          `[partialTpMonitor] heartbeat rows=${rows.length} groups=${groups.size} no triggers crossed yet — ${summary}`,
        )
      }
    }
  }

  /**
   * Close one partial slice.
   *
   *   'fired'   — the partial close went through (or the broker reported the
   *               trade already gone, which is the same end state).
   *   'skipped' — no attempt was ours to judge: another worker claimed the row,
   *               or the leg was cancelled because the parent is not open.
   *   'failed'  — the attempt failed; the caller records backoff and, once the
   *               evidence threshold is reached, may attempt a terminal cancel.
   *
   * Failures roll the row back to 'pending' so the next (backed-off) tick retries.
   *
   * Order of operations (CAS-first so duplicate workers can't both fire):
   *   1. CAS UPDATE status: 'pending' → 'claimed'. Lose ⇒ bail.
   *   2. Look up the parent trade's ticket. If the parent is closed
   *      already (SL hit, manual close, etc.), cancel the partial leg.
   *   3. /OrderClose with `lots = close_lots`.
   *   4. UPDATE status: 'claimed' → 'fired'.
   */
  /**
   * Record a successful broker close on the leg row.
   *
   * The row must not be left `claimed`: the stale-claim reaper would reset it
   * to `pending` and the next tick would close the same slice a second time
   * (the reason `mtapiProvider.orderClose` refuses to re-send partial closes).
   * So the write is retried, and every state this row can legitimately be in
   * right now is attempted:
   *   1. `claimed` by us (the normal path);
   *   2. `pending` with no owner — only reachable when the reaper reset our
   *      claim while the close was in flight, so it is still ours to record;
   * a row re-claimed by another host stays `claimed` with a different
   * `claimed_by` and matches neither, which is reported as `superseded`.
   *
   *   'ok'        — recorded (possibly after a reaper reset);
   *   'superseded' — no row matched: another worker owns it now;
   *   'error'     — every attempt failed at the database.
   */
  private async markFired(partialId: string, firedAt: string): Promise<'ok' | 'superseded' | 'error'> {
    const write = (status: 'claimed' | 'pending') => {
      let q = this.supabase
        .from('partial_tp_legs')
        .update({ status: 'fired', fired_at: firedAt })
        .eq('id', partialId)
        .eq('status', status)
      if (status === 'claimed') q = q.eq('claimed_by', this.hostId)
      else q = q.is('claimed_by', null)
      return q.select('id').maybeSingle()
    }

    let sawSuperseded = false
    for (let attempt = 0; attempt < FIRE_WRITE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, FIRE_WRITE_RETRY_MS * attempt))
      const primary = await write('claimed')
      if (primary.error) {
        console.warn(`[partialTpMonitor] fired write error partial=${partialId} attempt=${attempt + 1}: ${primary.error.message}`)
        continue
      }
      if (primary.data) return 'ok'
      const reaperReset = await write('pending')
      if (reaperReset.error) {
        console.warn(`[partialTpMonitor] fired write error partial=${partialId} attempt=${attempt + 1}: ${reaperReset.error.message}`)
        continue
      }
      if (reaperReset.data) {
        console.warn(
          `[partialTpMonitor] fired after stale-claim reset partial=${partialId}`
          + ' (claim had expired while the close was in flight)',
        )
        return 'ok'
      }
      sawSuperseded = true
    }
    if (sawSuperseded) return 'superseded'
    // Left `claimed` on purpose: returning 'failed' would make the next tick
    // re-send a close that already succeeded, which is the worse outcome.
    console.error(
      `[partialTpMonitor] fired write FAILED after ${FIRE_WRITE_ATTEMPTS} attempts partial=${partialId}`
      + ' — row stays claimed and will be reaped; monitor for a duplicate close',
    )
    return 'error'
  }

  private async firePartial(
    partial: PartialRow,
    api: FxsocketBrokerClient,
    sessionId: string,
    bid: number,
    ask: number,
  ): Promise<'fired' | 'skipped' | 'failed'> {

    // CAS claim.
    const { data: claimed, error: claimErr } = await this.supabase
      .from('partial_tp_legs')
      .update({ status: 'claimed', claimed_at: new Date().toISOString(), claimed_by: this.hostId })
      .eq('id', partial.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (claimErr) {
      console.warn(`[partialTpMonitor] CAS claim error partial=${partial.id}: ${claimErr.message}`)
      return 'skipped'
    }
    if (!claimed) return 'skipped'  // another worker won the race

    // Parent trade lookup — if it's already closed we cancel this partial
    // (no position to slice) so the row doesn't keep retrying forever.
    const { data: parent } = await this.supabase
      .from('trades')
      .select('id,metaapi_order_id,status,symbol,direction,lot_size,entry_price')
      .eq('id', partial.trade_id)
      .maybeSingle()
    const parentRow = (parent ?? null) as ParentTradeRow | null
    if (!parentRow || parentRow.status !== 'open') {
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: 'parent trade not open' })
        .eq('id', partial.id)
        .eq('status', 'claimed')
        .eq('claimed_by', this.hostId)
      return 'skipped'
    }
    const ticketNum = Number(parentRow.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'cancelled', fired_at: new Date().toISOString(), error_message: 'parent ticket missing' })
        .eq('id', partial.id)
        .eq('status', 'claimed')
        .eq('claimed_by', this.hostId)
      return 'skipped'
    }

    const t0 = Date.now()
    const refPrice = partial.is_buy ? bid : ask
    try {
      const resolution = await resolveCurrentLivePosition({
        supabase: this.supabase,
        api,
        sessionId,
        trade: parentRow,
      })
      if (resolution.status !== 'resolved') {
        throw new Error(`partial close reconciliation required: ${resolution.reason}`)
      }
      const effectiveTicket = resolution.ticket
      const result = await api.orderClose(sessionId, {
        ticket: effectiveTicket,
        lots: partial.close_lots,
        // price=0 lets the broker fill at market (same as a manual partial
        // close from the terminal). refPrice is reported in logs only.
      })
      const latencyMs = Date.now() - t0
      console.log(
        `[partialTpMonitor] partial fired signal=${partial.signal_id} symbol=${partial.symbol} ticket=${effectiveTicket}`
        + ` TP${partial.tp_idx}@${partial.trigger_price} ref=${refPrice} close=${partial.close_lots} latency=${latencyMs}ms`,
      )
      // Guarded like every other status write, so a row this worker no longer
      // owns is never overwritten. If the primary CAS misses, the ONLY state
      // this close can still legitimately claim is the stale-claim reaper's
      // reset (`pending` + `claimed_by = null`): the reaper runs before the
      // fetch and its 30s window is shorter than a slow /OrderClose, so a row
      // reset mid-flight would otherwise stay `pending` and be closed a second
      // time by the next tick. A row already re-claimed by another host keeps
      // `status = claimed` with a different `claimed_by`, so neither write
      // matches it — reported below instead. The broker close happened either
      // way, so it is still logged.
      const mark = await this.markFired(partial.id, new Date().toISOString())
      if (mark === 'superseded') {
        console.warn(
          `[partialTpMonitor] fired state superseded partial=${partial.id} ticket=${effectiveTicket}`
          + ' (claim lost); close is logged but this worker no longer owns the row',
        )
      }
      await this.supabase.from('trade_execution_logs').insert({
        user_id: partial.user_id,
        signal_id: partial.signal_id,
        broker_account_id: partial.broker_account_id,
        action: 'partial_tp_fired',
        status: 'success',
        request_payload: {
          partial_id: partial.id,
          trade_id: partial.trade_id,
          tp_idx: partial.tp_idx,
          trigger_price: partial.trigger_price,
          close_lots: partial.close_lots,
          ref_price: refPrice,
        } as unknown as Record<string, unknown>,
        response_payload: { ticket: result.ticket, latency_ms: latencyMs, claimed_by: this.hostId },
      })
      if (partial.signal_id && partial.broker_account_id) {
        await stopRangeLayeringUnlessEnabled(
          this.supabase,
          {
            signalId: partial.signal_id,
            brokerAccountId: partial.broker_account_id,
            symbol: partial.symbol,
            userId: partial.user_id,
          },
          'partial_tp_close',
        )
      }
      return 'fired'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // "trade not found" / "position already closed" — the parent trade
      // closed under us (SL, broker TP, manual). The row needs reconciliation
      // rather than another blind retry, so classify it as unresolvable.
      const benign = isPartialTpBenignBrokerError(msg)
      if (benign) {
        console.log(
          `[partialTpMonitor] close ambiguous signal=${partial.signal_id} ticket=${ticketNum}: ${msg}`,
        )
        this.failureClassByPartial.set(partial.id, 'unresolvable')
        await this.supabase
          .from('partial_tp_legs')
          .update({ status: 'pending', claimed_at: null, claimed_by: null, error_message: `reconciliation required: ${msg}` })
          .eq('id', partial.id)
          .eq('status', 'claimed')
          .eq('claimed_by', this.hostId)
        return 'failed'
      }
      console.error(
        `[partialTpMonitor] fire failed partial=${partial.id} ticket=${ticketNum}: ${msg}`,
      )
      this.markFailureClass(partial.id, msg)
      // Roll back to 'pending' so the next (backed-off) tick retries.
      await this.supabase
        .from('partial_tp_legs')
        .update({ status: 'pending', claimed_at: null, claimed_by: null, error_message: msg })
        .eq('id', partial.id)
        .eq('status', 'claimed')
        .eq('claimed_by', this.hostId)
      // One failed log row per leg per throttle window: a stuck leg used to
      // write one row every ~7s (571 rows in 70 minutes for a single leg).
      const now = Date.now()
      if (now >= (this.failureLogCooldownUntil.get(partial.id) ?? 0)) {
        this.failureLogCooldownUntil.set(partial.id, now + FAILURE_LOG_THROTTLE_MS)
        await this.supabase.from('trade_execution_logs').insert({
          user_id: partial.user_id,
          signal_id: partial.signal_id,
          broker_account_id: partial.broker_account_id,
          action: 'partial_tp_fired',
          status: 'failed',
          request_payload: {
            partial_id: partial.id,
            trade_id: partial.trade_id,
            tp_idx: partial.tp_idx,
            trigger_price: partial.trigger_price,
            close_lots: partial.close_lots,
            ref_price: refPrice,
          } as unknown as Record<string, unknown>,
          error_message: msg,
        })
      }
      return 'failed'
    }
  }

  /**
   * Cancel a partial leg whose stored ticket maps to no live position and that
   * has kept failing long enough for backoff to have had its chance.
   *
   * The cancel is ONLY allowed with positive proof, in this order:
   *   1. the session answers a health probe (an unhealthy session proves nothing);
   *   2. a fresh live-position read is complete and no longer holds the ticket
   *      (absence — a false-empty snapshot fails this);
   *   3. history holds a REAL CLOSE row for that ticket (an open-position echo
   *      carries the ticket but no close time, so it fails this).
   * If any check fails the leg stays exactly as it is and keeps backing off.
   *
   * The parent `trades` row is deliberately untouched — closing stale open
   * trades is `openTradeReconcile`'s job, with its own proof gate.
   */
  private async terminateStuckLeg(
    partial: PartialRow,
    api: FxsocketBrokerClient,
    sessionId: string,
    unresolvableCount: number,
    provider: string = 'mtapi',
  ): Promise<void> {
    const healthOk = await sessionIsHealthy(() => api.checkConnect(sessionId))
    if (!healthOk) {
      console.warn(`[partialTpMonitor] terminal cancel deferred partial=${partial.id}: session health check failed`)
      return
    }

    const { data: parent } = await this.supabase
      .from('trades')
      .select('id,metaapi_order_id,signal_id,symbol,direction,lot_size,entry_price')
      .eq('id', partial.trade_id)
      .maybeSingle()
    const parentRow = (parent ?? null) as ClassifyTradeRow | null
    if (!parentRow) return
    const ticketNum = Number(parentRow.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) return

    const absentFromLive = await liveTicketAbsent(api, sessionId, parentRow)
    if (absentFromLive === null) {
      console.warn(`[partialTpMonitor] terminal cancel deferred partial=${partial.id}: live-position read failed or incomplete`)
      return
    }
    const historyCloseMatched = await historyCloseProven(api, sessionId, parentRow, provider)
    if (historyCloseMatched === null) {
      console.warn(`[partialTpMonitor] terminal cancel deferred partial=${partial.id}: closed-history read failed`)
      return
    }

    // The gate decides; the warn says exactly which proof is missing.
    if (!shouldTerminatePartialLeg({ unresolvableCount, healthOk, absentFromLive, historyCloseMatched })) {
      console.warn(
        `[partialTpMonitor] terminal cancel deferred partial=${partial.id} ticket=${ticketNum}`
        + ` after ${unresolvableCount} attempts (need ${TERMINAL_CANCEL_AFTER}+)`
        + ` — live_absent=${absentFromLive} history_close=${historyCloseMatched}`,
      )
      return
    }

    const { data: cancelled, error } = await this.supabase
      .from('partial_tp_legs')
      .update({
        status: 'cancelled',
        fired_at: new Date().toISOString(),
        error_message: `parent position confirmed closed in broker history after ${unresolvableCount} failed attempts`,
      })
      .eq('id', partial.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (error) {
      console.warn(`[partialTpMonitor] terminal cancel failed partial=${partial.id}: ${error.message}`)
      return
    }
    if (!cancelled) {
      // The row is no longer ours to judge (claimed by someone else between
      // the proof reads and the write) — say so, the same as every other
      // deferral path here.
      console.warn(`[partialTpMonitor] terminal cancel skipped partial=${partial.id} ticket=${ticketNum}: row no longer pending`)
      return
    }

    console.warn(
      `[partialTpMonitor] cancelled stuck partial=${partial.id} ticket=${ticketNum}`
      + ` after ${unresolvableCount} unresolvable attempts (parent found closed in broker history)`,
    )
    await this.supabase.from('trade_execution_logs').insert({
      user_id: partial.user_id,
      signal_id: partial.signal_id,
      broker_account_id: partial.broker_account_id,
      action: 'partial_tp_fired',
      status: 'failed',
      request_payload: {
        partial_id: partial.id,
        trade_id: partial.trade_id,
        tp_idx: partial.tp_idx,
        trigger_price: partial.trigger_price,
        close_lots: partial.close_lots,
        parent_ticket: parentRow.metaapi_order_id,
        outcome: 'cancelled',
      } as unknown as Record<string, unknown>,
      error_message: `cancelled: parent position confirmed closed in broker history after ${unresolvableCount} failed attempts`,
    })
    this.clearFailure(partial.id)
  }
}
