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
 *   4. Multi-TP fan-out — when `trade_style === 'multi'`, splits the order across
 *      every enabled `tp_lots[]` entry so each TP level is a separate position with
 *      its own lot allocation and `takeprofit`.
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
  trade_style?: 'single' | 'multi'
  range_trading?: boolean
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

  // ── 5. Multi-TP fan-out ─────────────────────────────────────────────────
  const tradeStyle = manual.trade_style === 'multi' ? 'multi' : 'single'
  const enabledTpLots = (manual.tp_lots ?? []).filter(t => t && t.enabled && Number.isFinite(t.lot) && t.lot > 0)

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

  const orders: OrderSendArgs[] = []
  if (tradeStyle === 'multi' && enabledTpLots.length && finalTps.length) {
    // Pair each enabled tp_lots entry with a TP price by index, falling back to the last TP if we run out.
    for (let i = 0; i < enabledTpLots.length; i++) {
      const tpLot = enabledTpLots[i]
      const tpPrice = finalTps[i] ?? finalTps[finalTps.length - 1]
      orders.push({
        ...orderBase,
        volume: tpLot.lot,
        stoploss: roundPrice(finalSl),
        takeprofit: roundPrice(tpPrice),
        ...expirationFields,
        comment: `${commentPrefix}:tp${i + 1}`,
      })
    }
  } else {
    const tpPrice = finalTps[0] ?? null
    orders.push({
      ...orderBase,
      volume: manualLot,
      stoploss: roundPrice(finalSl),
      takeprofit: roundPrice(tpPrice),
      ...expirationFields,
    })
  }

  return { orders, delay_ms }
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
