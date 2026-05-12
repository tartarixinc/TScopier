import type { MtOperation, OrderSendArgs } from './metatraderapi'

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
  /** Broker-reported min SL/TP distance from market, in MT points (0 = no enforcement). */
  stopsLevel?: number
  /** Default lot size as a final fallback. */
  defaultLot: number
  /** Last known balance for `dynamic_balance_percent` sizing. */
  lastBalance: number | null
  /** Current wall-clock time, accepts an injected value for tests. */
  now?: Date
}

export interface PlannerResult {
  /** Concrete OrderSend payloads to issue. Empty array means "drop this signal". */
  orders: OrderSendArgs[]
  /** Reason for an empty plan, suitable for logging. */
  skip_reason?: string
  /** Non-fatal note when the planner had to soften its strategy (e.g. multi-trade
   *  fell back to a single position because the per-leg target was below minLot). */
  fallback_reason?: string
  /** Delay (ms) to wait before sending, derived from channel_keywords.additional.delay_msec. */
  delay_ms: number
}

/** MT pip size convention: 5/3-digit FX quotes treat one pip as 10 points; the rest treat one pip == point. */
function pipSize(point: number, digits: number): number {
  if (!Number.isFinite(point) || point <= 0) return 0.0001
  if (digits === 3 || digits === 5) return point * 10
  return point
}

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
  let entry: number | null = parsed.entry_price ?? null
  if (entry == null && parsed.entry_zone_low != null && parsed.entry_zone_high != null) {
    const lo = Number(parsed.entry_zone_low)
    const hi = Number(parsed.entry_zone_high)
    const prefer = channelKeywords?.additional?.prefer_entry ?? 'first_price'
    entry = prefer === 'last_price' ? Math.max(lo, hi) : Math.min(lo, hi)
  }

  // ── 4. SL/TP derivation ─────────────────────────────────────────────────
  const pip = pipSize(ctx.point, ctx.digits)
  const slInPips = channelKeywords?.additional?.sl_in_pips === true
  const tpInPips = channelKeywords?.additional?.tp_in_pips === true

  // Channel reported pip distances rather than prices — convert.
  let parsedSl: number | null = parsed.sl ?? null
  let parsedTps: number[] = (parsed.tp ?? []).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (slInPips && parsedSl != null && entry != null) {
    parsedSl = isBuy ? entry - parsedSl * pip : entry + parsedSl * pip
  }
  if (tpInPips && parsedTps.length && entry != null) {
    parsedTps = parsedTps.map(t => (isBuy ? entry + t * pip : entry - t * pip))
  }

  // Apply manual_settings overrides for SL/TP when enabled.
  let finalSl = parsedSl
  let finalTps = parsedTps
  if (manual.use_predefined_sl_pips && Number.isFinite(manual.predefined_sl_pips ?? NaN) && entry != null) {
    const sl_pips = Number(manual.predefined_sl_pips)
    finalSl = isBuy ? entry - sl_pips * pip : entry + sl_pips * pip
  }
  if (manual.use_predefined_tp_pips && Array.isArray(manual.predefined_tp_pips) && entry != null) {
    const tps = manual.predefined_tp_pips
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
    if (tps.length) {
      finalTps = tps.map(t => (isBuy ? entry + t * pip : entry - t * pip))
    }
  }

  // R:R derivation when only one side is known.
  if (manual.rr_for_sl_enabled && Number.isFinite(manual.rr_for_sl ?? NaN) && entry != null && finalTps.length && finalSl == null) {
    const rr = Number(manual.rr_for_sl)
    if (rr > 0) {
      const tpDist = Math.abs(finalTps[0] - entry)
      const slDist = tpDist / rr
      finalSl = isBuy ? entry - slDist : entry + slDist
    }
  }
  if (manual.rr_for_tps_enabled && Array.isArray(manual.rr_for_tps) && entry != null && finalSl != null && finalTps.length === 0) {
    const slDist = Math.abs(entry - finalSl)
    finalTps = manual.rr_for_tps
      .map(Number)
      .filter(n => Number.isFinite(n) && n > 0)
      .map(rr => (isBuy ? entry + rr * slDist : entry - rr * slDist))
  }

  const roundPrice = (v: number | null | undefined): number => {
    if (v == null || !Number.isFinite(v)) return 0
    const d = Math.max(0, Math.min(8, Number.isFinite(ctx.digits) ? ctx.digits : 5))
    return Number(v.toFixed(d))
  }

  // ── 5. Multi-Trade lot splitting ────────────────────────────────────────
  const tradeStyle = manual.trade_style === 'multi' ? 'multi' : 'single'

  const orderBase = {
    symbol: resolvedSymbol,
    operation,
    price: roundPrice(entry),
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

  const buildSingleOrder = (fallbackReason?: string): PlannerResult => ({
    orders: [{
      ...orderBase,
      volume: manualLot,
      stoploss: roundPrice(finalSl),
      takeprofit: roundPrice(finalTps[0] ?? null),
      ...expirationFields,
    }],
    delay_ms,
    ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
  })

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
  // When on, a configurable share of the planned legs is reserved as pending
  // Limit orders stepping away from entry by `range_step_pips`, bounded by
  // `range_distance_pips`. Immediates fire at entry; pendings fill as price
  // moves into the range. The effective leg count can shrink when the
  // distance / step cap bites — by design, per the user spec.
  const rangeOn = manual.range_trading === true
  const baseIsPendingSignal = operation.includes('Limit') || operation.includes('Stop')
  const rangePct = Math.max(0, Math.min(100, Number(manual.range_percent ?? 0)))
  const stepPips = Math.max(0, Number(manual.range_step_pips ?? 0))
  const distPips = Math.max(0, Number(manual.range_distance_pips ?? 0))

  let immediateLegs = totalLegs
  let effectiveRangeLegs = 0
  let effectiveStepPips = stepPips
  let rangeFallbackReason: string | undefined

  if (rangeOn && baseIsPendingSignal) {
    // Signal already carries its own pending entry — skip the range branch.
    rangeFallbackReason = 'range_trading_skip_pending_signal'
  } else if (rangeOn) {
    if (stepPips <= 0 || distPips <= 0) {
      rangeFallbackReason = 'range_trading_invalid'
    } else {
      // If the configured pip step would land Limit prices inside the broker's
      // stops zone (e.g. 2 pips on XAUUSD where stops_level ≈ $1), grow the
      // step to the broker minimum instead of silently dropping the feature.
      const stopsLevel = Number(ctx.stopsLevel ?? 0) || 0
      const minStepUnits = stopsLevel > 0 ? (stopsLevel + 2) * ctx.point : 0
      if (minStepUnits > 0 && pip > 0 && stepPips * pip < minStepUnits) {
        effectiveStepPips = Math.max(stepPips, Math.ceil(minStepUnits / pip))
        rangeFallbackReason = 'range_trading_step_auto_expanded'
      }
      const reservedLegs = Math.round((totalLegs * rangePct) / 100)
      const maxByDistance = Math.floor(distPips / effectiveStepPips)
      const effective = Math.min(reservedLegs, maxByDistance)
      if (effective <= 0) {
        // Reserved 0 is intentional (user picked 0%); cap-to-0 is misconfig.
        if (reservedLegs > 0) rangeFallbackReason = 'range_trading_invalid'
      } else {
        effectiveRangeLegs = effective
        immediateLegs = Math.max(0, totalLegs - reservedLegs)
      }
    }
  }

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

  // ── 8. Emit immediate legs ──────────────────────────────────────────────
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

  // ── 9. Emit range pendings ──────────────────────────────────────────────
  // Pendings always carry an expiration if `pending_expiry_hours` is set,
  // independent of whether the immediate leg path was already a pending.
  if (effectiveRangeLegs > 0 && entry != null) {
    const pendingOp: MtOperation = isBuy ? 'BuyLimit' : 'SellLimit'
    const pendingExpiration: { expiration?: string; expirationType?: OrderSendArgs['expirationType'] } = {}
    const pendHours = Number(manual.pending_expiry_hours ?? 0)
    if (Number.isFinite(pendHours) && pendHours > 0) {
      const exp = new Date(now.getTime() + pendHours * 60 * 60 * 1000)
      pendingExpiration.expiration = exp.toISOString()
      pendingExpiration.expirationType = 'Specified'
    }

    let stepIdx = 1
    for (let b = 0; b < bucketRows.length; b++) {
      const tpPrice = tpForBucket(b)
      for (let k = 0; k < (rangeCounts[b] ?? 0); k++) {
        const legPrice = isBuy
          ? entry - stepIdx * effectiveStepPips * pip
          : entry + stepIdx * effectiveStepPips * pip
        orders.push({
          ...orderBase,
          operation: pendingOp,
          volume: targetLeg,
          price: roundPrice(legPrice),
          stoploss: roundPrice(finalSl),
          takeprofit: roundPrice(tpPrice),
          ...pendingExpiration,
          comment: `${commentPrefix}:rg${stepIdx}.tp${b + 1}`,
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

  // ── 11. Close-worse-entries override (range-only) ───────────────────────
  // All immediates plus the first N shallowest pendings get a tight TP at
  // `legEntry ± close_worse_entries_pips * pip`, so they take a small profit
  // while the deeper (best-priced) range legs ride for the percent-row TPs.
  if (effectiveRangeLegs > 0 && manual.close_worse_entries === true) {
    const cwPips = Math.max(0, Number(manual.close_worse_entries_pips ?? 0))
    if (cwPips > 0) {
      const extraPendings = Math.max(
        0,
        Math.min(effectiveRangeLegs, Math.floor(Number(manual.close_worse_extra_pendings ?? 0))),
      )
      const dir = isBuy ? 1 : -1
      const overrideUpTo = immediateLegs + extraPendings
      const fallbackEntry = roundPrice(entry ?? 0)
      for (let k = 0; k < orders.length && k < overrideUpTo; k++) {
        const legPrice = orders[k]!.price ?? fallbackEntry
        const overriddenTp = roundPrice(legPrice + dir * cwPips * pip)
        orders[k] = {
          ...orders[k]!,
          takeprofit: overriddenTp,
          comment: `${orders[k]!.comment ?? ''}.cw`,
        }
      }
    }
  }

  if (orders.length === 0) {
    // Defensive: shouldn't happen given totalLegs >= 1.
    return buildSingleOrder('multi_trade_fallback_zero_legs')
  }

  return {
    orders,
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
