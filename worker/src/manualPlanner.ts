import type { MtOperation, OrderSendArgs } from './metatraderapi'
import { pipCalculator, type PipQuote } from './pipCalculator'

/**
 * Manual-mode order planner.
 *
 * Translates a parsed signal + broker `manual_settings` + channel `channel_keywords`
 * into one or more concrete `OrderSendArgs` payloads ready for `OrderSend`.
 *
 * Responsibilities (in order):
 *   1. Time-of-day / day-of-week filter — drops the signal entirely when outside the
 *      configured trading window.
 *   2. Reverse signal — flips buy↔sell when `manual_settings.reverse_signal` is on.
 *   3. Stops & Targets — fills in / overrides parsed SL & TPs from the predefined
 *      pip values; falls back to risk:reward derivation when only one side is known.
 *   4. Multi-Trade lot splitting — when `trade_style === 'multi'`, splits `manualLot`
 *      into many smaller positions of `targetLeg = manualLot × multi_trade_leg_percent / 100`
 *      (rounded down to the broker's `lotStep`). The resulting legs are distributed across
 *      the signal's TP levels using the percent rows in `tp_lots[]` (e.g. 50/30/20 of 20 legs
 *      = 10/6/4 at TP1/TP2/TP3). Falls back to a single full-size trade when `targetLeg`
 *      drops below the broker's `minLot`.
 *   5. Pending-order expiration — sets `expiration` + `expirationType` from
 *      `pending_expiry_hours` on Limit/Stop operations.
 *   6. Channel `tp_in_pips` / `sl_in_pips` — when the channel sends raw pip distances
 *      instead of prices, converts them to absolute SL/TP using the entry price.
 *   7. Channel `prefer_entry` — chooses the first or last price from an entry zone.
 */

export interface ParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[] | null
  lot_size: number | null
  open_tp?: boolean
  partial_close_fraction?: number | null
  raw_instruction?: string
}

export interface ManualTpLot {
  label: string
  lot: number
  percent?: number
  enabled: boolean
}

export interface ManualSettings {
  symbol_mapping?: Record<string, string>
  symbol_prefix?: string
  symbol_suffix?: string
  symbol_to_trade?: string | null
  symbols_exclude?: string[]
  risk_mode?: 'fixed_lot' | 'dynamic_balance_percent'
  fixed_lot?: number
  dynamic_balance_percent?: number
  tp_lots?: ManualTpLot[]
  multi_trade_leg_percent?: number
  trade_style?: 'single' | 'multi'
  range_trading?: boolean
  range_percent?: number
  range_step_pips?: number
  range_distance_pips?: number
  close_worse_entries?: boolean
  close_worse_entries_pips?: number
  close_worse_extra_pendings?: number
  /** @deprecated Replaced by `range_percent`. */
  range_total_lot?: number
  reverse_signal?: boolean
  use_predefined_sl_pips?: boolean
  predefined_sl_pips?: number
  use_predefined_tp_pips?: boolean
  predefined_tp_pips?: number[]
  rr_for_sl_enabled?: boolean
  rr_for_sl?: number
  rr_for_tps_enabled?: boolean
  rr_for_tps?: number[]
  pending_expiry_hours?: number
  add_new_trades_to_existing?: boolean
  close_on_opposite_signal?: boolean
  time_filter_enabled?: boolean
  trade_start_time?: string
  trade_end_time?: string
  days_filter_enabled?: boolean
  trade_days?: number[]
}

export interface ChannelKeywords {
  signal_phrases?: { buy?: string; sell?: string; entry_point?: string; sl?: string; tp?: string; market_order?: string }
  additional?: {
    ignore_keyword?: string
    skip_keyword?: string
    sl_in_pips?: boolean
    tp_in_pips?: boolean
    prefer_entry?: 'first_price' | 'last_price'
    delay_msec?: number
    all_order?: boolean
    remove_sl?: string
  }
}

export interface PlannerContext {
  /** MT point size for the symbol (e.g. 0.0001 for EURUSD, 0.01 for XAUUSD). Used for pip math. */
  point: number
  /** Number of decimal places to keep on prices when rounding. */
  digits: number
  /** Broker-reported minimum lot for this symbol (e.g. 0.01). */
  minLot: number
  /** Broker-reported lot step for this symbol (e.g. 0.01). */
  lotStep: number
  /**
   * Units in 1.00 standard lot — e.g. 100,000 for FX majors, 100 oz for
   * XAUUSD. Passed to `pipCalculator` so the planner can derive the
   * dollar pip value per lot (for the manual-plan summary log and for
   * exotic contracts where the broker reports a non-standard size).
   * Omitted when /SymbolParams didn't expose it; the calculator falls
   * back to a class-conventional default.
   */
  contractSize?: number | null
  /** Broker-reported min SL/TP distance from market, in MT points (0 = no enforcement). */
  stopsLevel?: number
  /**
   * Broker-reported freeze distance in MT points. Pending orders cannot be
   * modified inside this band. Treated as a second floor alongside `stopsLevel`
   * when clamping SL/TP/CWE override prices. 0 = no enforcement.
   */
  freezeLevel?: number
  /** Default lot size as a final fallback. */
  defaultLot: number
  /** Last known balance for `dynamic_balance_percent` sizing. */
  lastBalance: number | null
  /** Current wall-clock time, accepts an injected value for tests. */
  now?: Date
}

/**
 * Virtual pending leg — averaging-down rung that the executor persists into
 * `range_pending_legs` instead of sending to the broker as a BuyLimit/SellLimit.
 *
 * The worker's `virtualPendingMonitor` (1.5s timer) and the
 * `range-pending-sweep` edge function (60s cron) race to compare the live
 * /Quote against `trigger_price = anchor + (isBuy ? -1 : +1) × stepIdx ×
 * stepPriceOffset` and fire a MARKET OrderSend the moment the trigger is hit.
 */
export interface VirtualPendingLeg {
  /** 1-based step index (1 = shallowest, N = deepest). Diagnostic + ordering for CWE. */
  stepIdx: number
  /** Price offset per step (`effectiveStepPips × pip`). Persisted only via trigger_price. */
  stepPriceOffset: number
  /** True if the parent ladder is a Buy (trigger fires when bid <= trigger_price). */
  isBuy: boolean
  volume: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string
  expertID?: number
  /** Hours-to-live; the executor converts this to an absolute `expires_at` at INSERT time. */
  expiryHours?: number
  /**
   * Worker-managed close threshold for the Close-Worse-Entries policy.
   * The planner leaves this undefined; the executor stamps it on the first
   * N shallowest pendings (where N = `closeWorseEntries.extraPendings`)
   * once the live anchor is resolved. When set:
   *   - The pending is filed with `takeprofit = 0` (no broker TP).
   *   - On fire, the resulting `trades` row inherits `cwe_close_price`
   *     so the `cweCloseMonitor` will close it the moment the bid (buy)
   *     or ask (sell) crosses the threshold.
   *   - Sibling immediates and CWE pendings share the same value, so the
   *     whole worse-entries basket closes together.
   */
  cweClosePrice?: number | null
}

/**
 * Close-Worse-Entries policy. The planner emits this so the executor can
 * compute the close trigger AFTER the live anchor (signal entry → /Quote)
 * is resolved.
 *
 * The rule (as of May-12 worker-managed-close redesign): pick a single
 * trigger price `cweClosePrice = anchor ± cwePips × pip` and stamp it on
 * every CWE-eligible leg. "CWE-eligible" = all immediate legs + the N
 * shallowest virtual pendings.
 *
 * Unlike the previous implementation we do **not** put that price on the
 * broker as a `takeprofit` — the executor sets `takeprofit = 0` on these
 * legs and persists the close threshold to `trades.cwe_close_price`
 * (and `range_pending_legs.cwe_close_price` for pendings). The
 * `cweCloseMonitor` polls /Quote and issues /OrderClose as soon as the
 * threshold is crossed, which sidesteps the "Invalid stops" rejections
 * that broker-side TPs produced when the basket was already in profit
 * or inside the stops/freeze zone.
 */
export interface PlannerCloseWorseEntries {
  /** Number of immediate legs (all of which get the override TP). */
  immediates: number
  /** How many additional shallowest virtual pendings also get the override TP (0 = immediates only). */
  extraPendings: number
  /** Pip distance from the anchor to the override TP. */
  pipsFromAnchor: number
}

/**
 * Anchor used to derive pending prices. `value` may be null when the planner
 * couldn't determine an entry from the parsed signal — in that case the
 * executor resolves the anchor at runtime via /Quote.
 */
export interface PlannerAnchor {
  /** `signal` when the parsed signal carried an explicit entry; `unknown` when not. */
  source: 'signal' | 'unknown'
  value: number | null
}

/**
 * One worker-managed partial close for a single-mode trade. Emitted by
 * `planSinglePartialTps` whenever the user configured `tp_lots` percentages
 * AND the signal has ≥ 2 take-profits. The executor INSERTs these into
 * `partial_tp_legs` after the parent OrderSend succeeds; `partialTpMonitor`
 * polls /Quote and fires `/OrderClose` with `lots = closeLots` the moment
 * `is_buy ? bid >= triggerPrice : ask <= triggerPrice`.
 *
 * The LAST configured bucket's TP is NOT in this list — the broker's own
 * takeprofit handles that one, so anything that survives the worker partials
 * rides out to the deepest target naturally.
 */
export interface PlannerPartialTp {
  /** 1-based TP index (1 = TP1, 2 = TP2, …). Diagnostic + insertion ordering. */
  tpIdx: number
  /** Absolute price at which this partial fires. */
  triggerPrice: number
  /** Volume to /OrderClose at the trigger. Already rounded to lotStep + ≥ minLot. */
  closeLots: number
  /** Source percentage used to size `closeLots` (kept for logs / UI). */
  percent: number
}

export interface PlanSinglePartialTpsArgs {
  /** Already-rounded total volume of the parent single order. */
  manualLot: number
  minLot: number
  lotStep: number
  /** All TPs in the signal, signed (already converted from pip-distance to absolute price). */
  finalTps: number[]
  /** Enabled `tp_lots` rows (ordered, paired positionally with finalTps[0..]). */
  bucketRows: Array<{ percent?: number }>
}

export interface PlanSinglePartialTpsResult {
  /** TP price the broker order should ride to (= last enabled-bucket TP). Null when there
   *  isn't enough info to derive partials — in that case the caller falls back to TP1. */
  brokerTp: number | null
  /** Per-bucket partials, excluding the last bucket (that's the broker TP). Empty when
   *  the schedule degenerates to "use TP1 with no partials". */
  partials: PlannerPartialTp[]
  /** Non-fatal note describing why partials were dropped / capped, suitable for logging. */
  fallbackReason?: string
}

/**
 * Build the per-TP partial close schedule for a `trade_style === 'single'`
 * trade.
 *
 * Rules:
 *   - When `finalTps.length >= 2` AND there are enabled bucket rows, the
 *     broker TP becomes the LAST bucket-paired TP (so the trade rides
 *     to its deepest target) and the EARLIER buckets emit partials.
 *   - When `finalTps.length < 2` OR no enabled bucket rows, partials don't
 *     apply; the caller uses TP1 as the broker TP (current legacy behavior).
 *   - `closeLots` is `floor(manualLot × percent / 100 / lotStep) × lotStep`
 *     and is dropped when the result is below `minLot`. We never close
 *     more than `manualLot - minLot` across all partials so the last
 *     slice that rides to broker TP is always >= `minLot` (otherwise the
 *     final lot would round to 0 and the broker TP becomes a no-op).
 */
export function planSinglePartialTps(args: PlanSinglePartialTpsArgs): PlanSinglePartialTpsResult {
  const { manualLot, minLot, lotStep, finalTps, bucketRows } = args

  if (!Number.isFinite(manualLot) || manualLot <= 0) {
    return { brokerTp: null, partials: [], fallbackReason: 'partial_tp_invalid_lot' }
  }
  if (!Array.isArray(finalTps) || finalTps.length < 2 || !bucketRows.length) {
    return { brokerTp: finalTps[0] ?? null, partials: [] }
  }

  // Pair buckets with TPs positionally and clamp to whichever side is shorter.
  const bucketCount = Math.min(bucketRows.length, finalTps.length)
  const pairedTps = finalTps.slice(0, bucketCount)
  const pairedBuckets = bucketRows.slice(0, bucketCount)

  // The LAST paired TP is the broker's takeprofit. The earlier ones are
  // worker-managed partials.
  const brokerTp = pairedTps[bucketCount - 1] ?? null
  if (bucketCount < 2 || brokerTp == null) {
    return { brokerTp, partials: [] }
  }

  const FP_EPS = 1e-9
  const toUnits = (v: number): number => {
    if (!Number.isFinite(v) || v <= 0) return 0
    return Math.max(0, Math.floor(v / lotStep + FP_EPS))
  }
  const unitsToLot = (u: number): number => Number((u * lotStep).toFixed(8))

  const manualUnits = toUnits(manualLot)
  const minUnits = Math.max(1, Math.round(minLot / lotStep))
  // Reserve at least one minLot's worth of units for the final broker-TP
  // slice. Without this a 100%-sum schedule on a 1.0 lot would leave the
  // broker TP riding 0.0 lots — i.e. nothing — and the deepest target would
  // never trigger because there's no position left to close.
  const usableUnits = Math.max(0, manualUnits - minUnits)
  let remainingUnits = usableUnits

  const partials: PlannerPartialTp[] = []
  let fallbackReason: string | undefined

  for (let i = 0; i < bucketCount - 1; i++) {
    const tp = pairedTps[i]
    if (tp == null || !Number.isFinite(tp) || tp <= 0) continue
    const pctRaw = Number(pairedBuckets[i]?.percent)
    const pct = Number.isFinite(pctRaw) && pctRaw > 0 ? Math.min(100, pctRaw) : 0
    if (pct <= 0) continue
    let units = toUnits(manualLot * (pct / 100))
    if (units < minUnits) {
      // Percentage too small relative to broker minimum lot; skip this
      // partial. Surface it once so the user can see why their 5% TP1
      // didn't fire on a 0.10 lot trade with 0.01 minLot.
      fallbackReason = fallbackReason ?? 'partial_tp_below_min_lot'
      continue
    }
    if (units > remainingUnits) {
      // Cap so the cumulative partials never exceed manualLot - minLot.
      units = remainingUnits
      fallbackReason = fallbackReason ?? 'partial_tp_capped_remainder'
      if (units < minUnits) continue
    }
    remainingUnits -= units
    partials.push({
      tpIdx: i + 1,
      triggerPrice: tp,
      closeLots: unitsToLot(units),
      percent: pct,
    })
    if (remainingUnits < minUnits) {
      // No room left for any further partials — the rest goes to broker TP.
      break
    }
  }

  return { brokerTp, partials, fallbackReason }
}

export interface PlannerResult {
  /** Concrete OrderSend payloads to issue immediately as MARKET orders. The
   *  range-trading "averaging-down" legs are NOT in here — they live in
   *  `virtualPendings` and are materialized into `range_pending_legs`. */
  orders: OrderSendArgs[]
  /** Range-trading legs that are NOT placed at the broker as Limit orders.
   *  The executor persists them into `range_pending_legs` with a computed
   *  `trigger_price` so a worker poller can fire them as MARKET orders when
   *  the live /Quote crosses the trigger. */
  virtualPendings?: VirtualPendingLeg[]
  /** Anchor candidate from the parsed signal; may be null when the signal didn't include one. */
  anchor?: PlannerAnchor
  /** Smart-pip size for this signal (so the executor can derive prices/CWE without
   *  recomputing classifySymbol/smartPipSize). */
  pip?: number
  /**
   * Full pip quote derived by `pipCalculator`. Exposed so the executor's
   * plan-summary log can show `pipValue` per std lot and `contractSize`
   * without re-running the calculator. `pip` above is just a shortcut for
   * `pipQuote.pipPrice` and is kept for backwards compatibility with
   * existing callers / tests.
   */
  pipQuote?: PipQuote
  /** True if this is a buy ladder (immediates Buy / pendings BuyLimit). */
  isBuy?: boolean
  /** Close-Worse-Entries policy; absent when CWE is off or there are no range legs. */
  closeWorseEntries?: PlannerCloseWorseEntries
  /**
   * Per-TP partial close schedule for `trade_style === 'single'` plans.
   * Empty when partials don't apply (no enabled bucket rows, only one TP,
   * etc.). The executor INSERTs these into `partial_tp_legs` keyed to the
   * parent trade so `partialTpMonitor` can fire `/OrderClose` slices when
   * the live quote crosses each trigger. The LAST configured bucket's TP
   * is the broker order's `takeprofit` and is intentionally NOT in this
   * list.
   */
  partialTps?: PlannerPartialTp[]
  /** Reason for an empty plan, suitable for logging. */
  skip_reason?: string
  /** Non-fatal note when the planner had to soften its strategy (e.g. multi-trade
   *  fell back to a single position because the per-leg target was below minLot). */
  fallback_reason?: string
  /** Delay (ms) to wait before sending, derived from channel_keywords.additional.delay_msec. */
  delay_ms: number
}

// ── Pure helpers (exported for tests + executor) ──────────────────────────

export interface PlanRangeSplitArgs {
  /** Total legs the multi-trade planner wants to issue. */
  totalLegs: number
  /** True if the signal already carries its own pending entry (Limit/Stop). */
  baseIsPendingSignal: boolean
  rangeOn: boolean
  /** Share of total legs reserved for pending Limit orders (0..100). */
  rangePct: number
  /** Configured pip distance between consecutive pendings. */
  stepPips: number
  /** Total pip span the range covers from the anchor. */
  distPips: number
  /** Smart-pip size in price units. */
  pip: number
  /** Broker stop/freeze floor distance in price units (already includes the +2 safety). */
  minStepPriceUnits: number
  /** True when the planner has an entry anchor available from the signal. */
  hasSignalAnchor: boolean
}

export interface PlanRangeSplitResult {
  /** How many of the total legs fire immediately (at the anchor). */
  immediateLegs: number
  /** How many pendings to emit (after distance / step capping). */
  pendingLegs: number
  /** The step in pips actually used (may be auto-expanded from `stepPips`). */
  effectiveStepPips: number
  /** Price offset per step (`effectiveStepPips × pip`). */
  stepPriceOffset: number
  /** Non-fatal note when the planner had to soften the range strategy. */
  fallbackReason?: string
}

/**
 * Decide how many of the planned legs go out as immediates vs. range pendings.
 * Pure function so the split can be unit-tested and reused by the UI estimator
 * down the line.
 *
 * **Step does NOT shrink the pending count.** Pending count is purely
 * `round(totalLegs × rangePct / 100)`. The `step` is the pip spacing the
 * planner uses to place each pending. `distPips` is an advisory target span
 * the user expects the ladder to reach — it's validated as > 0 so the user
 * has to set SOMETHING in range mode, but it no longer caps the count.
 * (Previously the count was capped at `floor(distPips / step)`, which meant
 * raising the step shrank Total Open Trades — surprising UX feedback from
 * May 12.)
 */
export function planRangeSplit(args: PlanRangeSplitArgs): PlanRangeSplitResult {
  const { totalLegs, baseIsPendingSignal, rangeOn, rangePct, stepPips, distPips, pip, minStepPriceUnits, hasSignalAnchor } = args
  const safe = (n: number) => Number.isFinite(n) && n > 0
  const baseResult: PlanRangeSplitResult = {
    immediateLegs: totalLegs,
    pendingLegs: 0,
    effectiveStepPips: stepPips,
    stepPriceOffset: 0,
  }
  if (!rangeOn) return baseResult
  if (baseIsPendingSignal) return { ...baseResult, fallbackReason: 'range_trading_skip_pending_signal' }
  if (!safe(stepPips) || !safe(distPips)) {
    return { ...baseResult, fallbackReason: 'range_trading_invalid' }
  }

  let effectiveStepPips = stepPips
  let fallbackReason: string | undefined
  if (minStepPriceUnits > 0 && pip > 0 && stepPips * pip < minStepPriceUnits) {
    effectiveStepPips = Math.max(stepPips, Math.ceil(minStepPriceUnits / pip))
    fallbackReason = 'range_trading_step_auto_expanded'
  }
  const stepPriceOffset = effectiveStepPips * pip

  const reservedLegs = Math.max(0, Math.round((totalLegs * rangePct) / 100))
  if (reservedLegs <= 0) {
    return { ...baseResult, effectiveStepPips, stepPriceOffset, fallbackReason }
  }

  const immediateLegs = Math.max(0, totalLegs - reservedLegs)
  // Executor needs SOMETHING to anchor against. If the signal has no entry and
  // we have no immediates, the executor still has /Quote as a fallback, so we
  // proceed and rely on the runtime anchor. We only drop the range when there
  // is literally no path to an anchor (no signal entry AND no immediate fills),
  // which the executor will detect explicitly.
  return { immediateLegs, pendingLegs: reservedLegs, effectiveStepPips, stepPriceOffset, fallbackReason: fallbackReason ?? (!hasSignalAnchor && immediateLegs === 0 ? 'range_trading_anchor_runtime_only' : undefined) }
}

export interface ComputeCwOverrideTpArgs {
  policy: PlannerCloseWorseEntries
  anchor: number
  isBuy: boolean
  pip: number
  digits: number
  /** Broker stops/freeze floor distance in price units (already includes +safety). */
  minStopDistance: number
}

/**
 * Compute the single CWE close-threshold price (`anchor ± cwePips × pip`).
 * Returns `null` when CWE is off or the inputs aren't sufficient.
 *
 * The executor stamps this value on the `cwe_close_price` column of every
 * CWE-eligible row — the first `policy.immediates` immediate orders (via
 * `trades.cwe_close_price`) AND the first `policy.extraPendings` virtual
 * pendings sorted by `stepIdx` ascending (via `range_pending_legs.cwe_close_price`).
 *
 * Note: unlike the previous broker-TP implementation we deliberately do
 * NOT clamp this against the broker's stops/freeze zone. The price is
 * only ever compared to a live quote inside `cweCloseMonitor` — it is
 * never sent to the broker as a TP, so the stops_level / freeze_level
 * constraints don't apply. Clamping it here would silently shift the
 * close trigger further from the anchor than the user asked for.
 *
 * `minStopDistance` is accepted for API compatibility with callers that
 * still pass it but is intentionally ignored.
 */
export function computeCwOverrideTp(args: ComputeCwOverrideTpArgs): number | null {
  const { policy, anchor, isBuy, pip, digits } = args
  if (!policy || policy.pipsFromAnchor <= 0) return null
  if (!Number.isFinite(anchor) || anchor <= 0) return null

  const dir = isBuy ? 1 : -1
  const tp = anchor + dir * policy.pipsFromAnchor * pip
  const d = Math.max(0, Math.min(8, Math.floor(digits)))
  return Number(tp.toFixed(d))
}

// Pip math now lives in ./pipMath. The old `pipSize(point, digits)` helper has
// been replaced by `smartPipSize(symbol, point, digits)` which classifies the
// instrument (FX vs metal vs index vs crypto vs other) before picking the
// pip multiplier. This is what fixes "10 pips on XAUUSD" being interpreted as
// $0.10 (inside stops_level) instead of $1.00.

function withinTimeWindow(start: string, end: string, now: Date): boolean {
  // Times are HH:MM strings in the user's local browser TZ. We approximate by
  // comparing against the server's local time here; for global accuracy we'd
  // need to store the user's TZ alongside the settings (TODO).
  const toMinutes = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
    return h * 60 + mm
  }
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s == null || e == null) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  // Window can wrap midnight (e.g. 22:00 → 06:00).
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e
}

/** Build the order plan. Returns an empty plan with skip_reason when filtered out. */
export function planManualOrders(args: {
  parsed: ParsedSignal
  resolvedSymbol: string
  baseOperation: MtOperation
  manual: ManualSettings
  channelKeywords: ChannelKeywords | null
  manualLot: number
  ctx: PlannerContext
  commentPrefix: string
  expertId?: number
  slippage?: number
}): PlannerResult {
  const {
    parsed,
    resolvedSymbol,
    baseOperation,
    manual,
    channelKeywords,
    manualLot,
    ctx,
    commentPrefix,
    expertId,
    slippage,
  } = args

  const now = ctx.now ?? new Date()
  const delay_ms = Math.max(0, Number(channelKeywords?.additional?.delay_msec ?? 0) | 0)

  // ── 1. Filters ──────────────────────────────────────────────────────────
  if (manual.days_filter_enabled) {
    const allowed = (manual.trade_days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number)
    if (!allowed.includes(now.getDay())) {
      return { orders: [], skip_reason: 'filtered_day', delay_ms }
    }
  }
  if (manual.time_filter_enabled && manual.trade_start_time && manual.trade_end_time) {
    if (!withinTimeWindow(manual.trade_start_time, manual.trade_end_time, now)) {
      return { orders: [], skip_reason: 'filtered_time', delay_ms }
    }
  }

  // ── 2. Reverse direction ────────────────────────────────────────────────
  const operation: MtOperation = manual.reverse_signal ? flipOperation(baseOperation) : baseOperation
  const isBuy = operation.startsWith('Buy')

  // ── 3. Resolve entry price (with channel prefer_entry on zones) ─────────
  let entry: number | null = parsed.entry_price != null ? Number(parsed.entry_price) : null
  if (entry != null && !Number.isFinite(entry)) entry = null
  if (entry == null && parsed.entry_zone_low != null && parsed.entry_zone_high != null) {
    const lo = Number(parsed.entry_zone_low)
    const hi = Number(parsed.entry_zone_high)
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const prefer = channelKeywords?.additional?.prefer_entry ?? 'first_price'
      entry = prefer === 'last_price' ? Math.max(lo, hi) : Math.min(lo, hi)
    }
  }
  const entryOk = entry != null && Number.isFinite(entry) && entry > 0
  const entryAnchor = entryOk ? entry : null

  // ── 4. SL/TP derivation ─────────────────────────────────────────────────
  // Single source of truth for both pip price (used immediately below for
  // SL/TP/range step math) and pip value per std/mini/micro lot (surfaced
  // on PlannerResult.pipQuote for the executor's summary log and the UI).
  const pipQuote = pipCalculator(resolvedSymbol, ctx.point, ctx.digits, ctx.contractSize ?? null)
  const pip = pipQuote.pipPrice
  const slInPips = channelKeywords?.additional?.sl_in_pips === true
  const tpInPips = channelKeywords?.additional?.tp_in_pips === true

  // Channel reported pip distances rather than prices — convert.
  let parsedSl: number | null = parsed.sl ?? null
  let parsedTps: number[] = (parsed.tp ?? []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (slInPips && parsedSl != null && entryAnchor != null) {
    parsedSl = isBuy ? entryAnchor - parsedSl * pip : entryAnchor + parsedSl * pip
  }
  if (tpInPips && parsedTps.length && entryAnchor != null) {
    parsedTps = parsedTps.map(t => (isBuy ? entryAnchor + t * pip : entryAnchor - t * pip))
  }

  // Apply manual_settings overrides for SL/TP when enabled.
  let finalSl = parsedSl
  let finalTps = parsedTps
  if (manual.use_predefined_sl_pips && Number.isFinite(manual.predefined_sl_pips ?? NaN) && entryAnchor != null) {
    const sl_pips = Number(manual.predefined_sl_pips)
    finalSl = isBuy ? entryAnchor - sl_pips * pip : entryAnchor + sl_pips * pip
  }
  if (manual.use_predefined_tp_pips && Array.isArray(manual.predefined_tp_pips) && entryAnchor != null) {
    const tps = manual.predefined_tp_pips
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
    if (tps.length) {
      finalTps = tps.map(t => (isBuy ? entryAnchor + t * pip : entryAnchor - t * pip))
    }
  }

  // R:R derivation when only one side is known.
  if (manual.rr_for_sl_enabled && Number.isFinite(manual.rr_for_sl ?? NaN) && entryAnchor != null && finalTps.length && finalSl == null) {
    const rr = Number(manual.rr_for_sl)
    if (rr > 0) {
      const tpDist = Math.abs(finalTps[0] - entryAnchor)
      const slDist = tpDist / rr
      finalSl = isBuy ? entryAnchor - slDist : entryAnchor + slDist
    }
  }
  if (manual.rr_for_tps_enabled && Array.isArray(manual.rr_for_tps) && entryAnchor != null && finalSl != null && finalTps.length === 0) {
    const slDist = Math.abs(entryAnchor - finalSl)
    finalTps = manual.rr_for_tps
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .map(rr => (isBuy ? entryAnchor + rr * slDist : entryAnchor - rr * slDist))
  }

  const roundPrice = (v: number | null | undefined): number => {
    if (v == null || !Number.isFinite(v)) return 0
    const d = Math.max(0, Math.min(8, Number.isFinite(ctx.digits) ? ctx.digits : 5))
    return Number(v.toFixed(d))
  }

  // ── 4b. Clamp SL/TP outside the broker's stops_level band, using `entry`
  //   as the market proxy. Without this, signals that quote tight TPs (e.g.
  //   XAUUSD TP only 20 "pips" = $0.20 away on a 2-digit broker) get rejected
  //   with "Invalid stops in the request". The tradeExecutor clamp also runs
  //   per-order, but doing it here ensures every derived order (immediate,
  //   range pending, close-worse-entries override) inherits a safe baseline.
  const stopsLevel = Number(ctx.stopsLevel ?? 0) || 0
  const freezeLevel = Number(ctx.freezeLevel ?? 0) || 0
  const safeLevel = Math.max(stopsLevel, freezeLevel)
  const minStopDist = safeLevel > 0 ? (safeLevel + 2) * ctx.point : 0
  const clampToStops = (price: number | null, isTp: boolean, ref: number | null): number | null => {
    if (price == null || !Number.isFinite(price) || ref == null || ref <= 0 || minStopDist <= 0) {
      return price
    }
    const wantAbove = isTp ? isBuy : !isBuy
    if (wantAbove) {
      const floorPrice = ref + minStopDist
      return price < floorPrice ? Number(floorPrice.toFixed(ctx.digits)) : price
    }
    const ceilPrice = ref - minStopDist
    return price > ceilPrice ? Number(ceilPrice.toFixed(ctx.digits)) : price
  }
  if (entryAnchor != null && minStopDist > 0) {
    finalSl = clampToStops(finalSl, false, entryAnchor)
    finalTps = finalTps.map(tp => clampToStops(tp, true, entryAnchor) ?? tp)
  }

  // ── 5. Multi-Trade lot splitting ────────────────────────────────────────
  const tradeStyle = manual.trade_style === 'multi' ? 'multi' : 'single'

  const orderBase = {
    symbol: resolvedSymbol,
    operation,
    price: entryAnchor != null ? roundPrice(entryAnchor) : roundPrice(entry),
    slippage: slippage ?? 20,
    comment: commentPrefix,
    expertID: expertId,
  } satisfies Omit<OrderSendArgs, 'volume' | 'stoploss' | 'takeprofit' | 'expiration' | 'expirationType'>

  const expirationFields: { expiration?: string; expirationType?: OrderSendArgs['expirationType'] } = {}
  if (operation.includes('Limit') || operation.includes('Stop')) {
    const hours = Number(manual.pending_expiry_hours ?? 0)
    if (Number.isFinite(hours) && hours > 0) {
      const exp = new Date(now.getTime() + hours * 60 * 60 * 1000)
      expirationFields.expiration = exp.toISOString()
      expirationFields.expirationType = 'Specified'
    }
  }

  const minLot = Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01
  const lotStep = Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01
  // Work in integer "lot-step units" to dodge floating-point drift on things like
  // 14 × 0.07 = 0.9800000000000001 (which would otherwise eat a 0.01 remainder).
  const FP_EPS = 1e-9
  const toUnits = (v: number): number => {
    if (!Number.isFinite(v) || v <= 0) return 0
    return Math.max(0, Math.floor(v / lotStep + FP_EPS))
  }
  const unitsToLot = (u: number): number => Number((u * lotStep).toFixed(8))

  const buildSingleOrder = (fallbackReason?: string): PlannerResult => {
    // Per-TP partial-close schedule. When the user configured `tp_lots`
    // percentages AND the signal carries ≥ 2 TPs, the single trade rides
    // to the LAST configured-bucket TP at the broker, and the EARLIER
    // buckets become `partial_tp_legs` rows that `partialTpMonitor`
    // /OrderCloses at each trigger. When the schedule doesn't apply we
    // fall back to legacy "broker TP = TP1, no partials" behavior so
    // single-TP signals keep working.
    const enabledForSingle = (manual.tp_lots ?? []).filter(r => r && r.enabled)
    const partialPlan = planSinglePartialTps({
      manualLot,
      minLot: Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01,
      lotStep: Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01,
      finalTps,
      bucketRows: enabledForSingle,
    })
    const brokerTp = partialPlan.brokerTp ?? finalTps[0] ?? null
    const combinedFallback = fallbackReason ?? partialPlan.fallbackReason
    return {
      orders: [{
        ...orderBase,
        volume: manualLot,
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(brokerTp),
        ...expirationFields,
      }],
      delay_ms,
      ...(combinedFallback ? { fallback_reason: combinedFallback } : {}),
      ...(partialPlan.partials.length > 0 ? { partialTps: partialPlan.partials } : {}),
    }
  }

  if (tradeStyle !== 'multi') {
    return buildSingleOrder()
  }

  const legPct = Math.max(0.1, Math.min(100, Number(manual.multi_trade_leg_percent ?? 5)))
  /** Hard safety cap on concurrent OrderSend payloads per signal. */
  const ABS_MAX_LEGS = 500

  const manualUnits = toUnits(manualLot)
  const targetUnits = toUnits(manualLot * (legPct / 100))
  const minUnits = Math.max(1, Math.round(minLot / lotStep))

  if (targetUnits < minUnits) {
    return buildSingleOrder('multi_trade_fallback_min_lot')
  }
  if (manualUnits < minUnits) {
    // Even a full-size order can't clear the broker minimum — let the caller drop it.
    return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms }
  }

  const totalLegs = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)))
  const targetLeg = unitsToLot(targetUnits)

  // ── 6. Range Trading split ──────────────────────────────────────────────
  // Delegates to the exported `planRangeSplit` helper so the immediate/pending
  // math stays pure and testable. The planner only decides COUNTS here; pending
  // PRICES are computed at the executor against the live anchor (signal entry
  // → /Quote bid/ask → first-fill openPrice).
  const baseIsPendingSignal = operation.includes('Limit') || operation.includes('Stop')
  const split = planRangeSplit({
    totalLegs,
    baseIsPendingSignal,
    rangeOn: manual.range_trading === true,
    rangePct: Math.max(0, Math.min(100, Number(manual.range_percent ?? 0))),
    stepPips: Math.max(0, Number(manual.range_step_pips ?? 0)),
    distPips: Math.max(0, Number(manual.range_distance_pips ?? 0)),
    pip,
    minStepPriceUnits: minStopDist,
    hasSignalAnchor: entryAnchor != null,
  })
  const immediateLegs = split.immediateLegs
  const effectiveRangeLegs = split.pendingLegs
  const effectiveStepPips = split.effectiveStepPips
  const stepPriceOffset = split.stepPriceOffset
  const rangeFallbackReason = split.fallbackReason

  // ── 7. TP bucket setup (shared by immediate + range distributions) ──────
  const enabledRows = (manual.tp_lots ?? []).filter(r => r && r.enabled)
  const bucketCount = finalTps.length > 0
    ? Math.max(1, Math.min(enabledRows.length || 1, finalTps.length))
    : 1
  const bucketRows = (enabledRows.length ? enabledRows : [{ label: 'TP1', lot: 0, percent: 100, enabled: true }])
    .slice(0, bucketCount)

  const rawWeights = bucketRows.map(r => {
    const p = Number(r.percent)
    return Number.isFinite(p) && p > 0 ? p : 0
  })
  const weights = rawWeights.every(w => w === 0) ? bucketRows.map(() => 1) : rawWeights
  const sumW = weights.reduce((a, b) => a + b, 0) || bucketRows.length

  /** Distribute `count` legs across the TP buckets, folding rounding drift into the last bucket. */
  const distributeCount = (count: number): number[] => {
    const out = bucketRows.map(() => 0)
    if (count <= 0 || bucketRows.length === 0) return out
    for (let i = 0; i < weights.length; i++) {
      out[i] = Math.round((count * weights[i]!) / sumW)
    }
    let drift = count - out.reduce((a, b) => a + b, 0)
    let idx = out.length - 1
    let guard = out.length * 2
    while (drift !== 0 && guard-- > 0) {
      if (drift > 0) {
        out[idx]! += 1
        drift -= 1
      } else if (out[idx]! > 0) {
        out[idx]! -= 1
        drift += 1
      }
      idx = (idx - 1 + out.length) % out.length
      if (drift < 0 && out.every(c => c === 0)) break
    }
    return out
  }

  const tpForBucket = (b: number): number | null => {
    if (finalTps.length === 0) return null
    return finalTps[b] ?? finalTps[finalTps.length - 1] ?? null
  }

  const immediateCounts = distributeCount(immediateLegs)
  const rangeCounts = distributeCount(effectiveRangeLegs)

  // ── 8. Emit immediate legs (MARKET orders sent right away) ──────────────
  const orders: OrderSendArgs[] = []
  for (let b = 0; b < bucketRows.length; b++) {
    const tpPrice = tpForBucket(b)
    for (let k = 0; k < (immediateCounts[b] ?? 0); k++) {
      orders.push({
        ...orderBase,
        volume: targetLeg,
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(tpPrice),
        ...expirationFields,
        comment: `${commentPrefix}:tp${b + 1}.${k + 1}`,
      })
    }
  }

  // ── 9. Build virtual range pendings (persisted, not sent to broker) ─────
  // These are NOT placed at the broker as BuyLimit/SellLimit. The executor
  // INSERTs them into `range_pending_legs` with a computed `trigger_price`;
  // the worker's virtualPendingMonitor (1.5s) and the range-pending-sweep
  // edge function (60s) poll /Quote and fire each leg as a MARKET order the
  // moment its trigger price is hit. This sidesteps every broker rejection
  // class (stops_level / freeze_level / min-Limit-distance).
  const virtualPendings: VirtualPendingLeg[] = []
  if (effectiveRangeLegs > 0) {
    const pendHours = Number(manual.pending_expiry_hours ?? 0)
    const expiryHours = Number.isFinite(pendHours) && pendHours > 0 ? pendHours : undefined

    let stepIdx = 1
    for (let b = 0; b < bucketRows.length; b++) {
      const tpPrice = tpForBucket(b)
      for (let k = 0; k < (rangeCounts[b] ?? 0); k++) {
        virtualPendings.push({
          stepIdx,
          stepPriceOffset,
          isBuy,
          volume: targetLeg,
          stoploss: finalSl,
          takeprofit: tpPrice,
          slippage: slippage ?? 20,
          comment: `${commentPrefix}:rg${stepIdx}.tp${b + 1}`,
          expertID: expertId,
          expiryHours,
        })
        stepIdx += 1
      }
    }
  }

  // ── 10. Remainder leg (legacy exact-lot behaviour, skipped in range mode) ─
  // In range mode the user explicitly accepts that the effective lot can be
  // less than manualLot, so we don't tack on a fractional remainder leg.
  if (effectiveRangeLegs === 0) {
    const remainderUnits = manualUnits - totalLegs * targetUnits
    if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
      const tpPrice = tpForBucket(bucketRows.length - 1)
      orders.push({
        ...orderBase,
        volume: unitsToLot(remainderUnits),
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(tpPrice),
        ...expirationFields,
        comment: `${commentPrefix}:tp${bucketRows.length}.rem`,
      })
    }
  }

  // ── 11. Close-worse-entries policy (executor applies post-anchor) ───────
  // Per user spec: "when trade is in X pip in profit from the worse (earliest)
  // entry, close those trades; keep the best entry trades." That's a SINGLE
  // trigger price = `anchor + X pips`, stamped on all immediates plus the N
  // shallowest virtual pendings. The deeper virtuals keep their percent-row TPs
  // and ride for the bigger targets.
  //
  // As of May-12 the trigger is enforced by the worker (`cweCloseMonitor`),
  // NOT by a broker-side takeprofit — see the doc on `computeCwOverrideTp`.
  // We don't compute the actual close price here because the planner anchor
  // may be null (market signals on XAUUSD often arrive without entry_price);
  // the executor will resolve a live anchor via /Quote and then call
  // `computeCwOverrideTp` and stamp `cwe_close_price` on the row.
  let closeWorseEntries: PlannerCloseWorseEntries | undefined
  if (effectiveRangeLegs > 0 && manual.close_worse_entries === true) {
    const cwPips = Math.max(0, Number(manual.close_worse_entries_pips ?? 0))
    if (cwPips > 0) {
      const extraPendings = Math.max(
        0,
        Math.min(effectiveRangeLegs, Math.floor(Number(manual.close_worse_extra_pendings ?? 0))),
      )
      closeWorseEntries = {
        immediates: immediateLegs,
        extraPendings,
        pipsFromAnchor: cwPips,
      }
    }
  }

  if (orders.length === 0 && virtualPendings.length === 0) {
    // Defensive: shouldn't happen given totalLegs >= 1.
    return buildSingleOrder('multi_trade_fallback_zero_legs')
  }

  return {
    orders,
    ...(virtualPendings.length ? { virtualPendings } : {}),
    anchor: { source: entryAnchor != null ? 'signal' : 'unknown', value: entryAnchor },
    pip,
    pipQuote,
    isBuy,
    ...(closeWorseEntries ? { closeWorseEntries } : {}),
    delay_ms,
    ...(rangeFallbackReason ? { fallback_reason: rangeFallbackReason } : {}),
  }
}

function flipOperation(op: MtOperation): MtOperation {
  switch (op) {
    case 'Buy': return 'Sell'
    case 'Sell': return 'Buy'
    case 'BuyLimit': return 'SellLimit'
    case 'SellLimit': return 'BuyLimit'
    case 'BuyStop': return 'SellStop'
    case 'SellStop': return 'BuyStop'
    case 'BuyStopLimit': return 'SellStopLimit'
    case 'SellStopLimit': return 'BuyStopLimit'
    default: return op
  }
}
