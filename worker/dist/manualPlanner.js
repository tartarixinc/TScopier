"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.planSinglePartialTps = planSinglePartialTps;
exports.planRangeSplit = planRangeSplit;
exports.computeCwOverrideTp = computeCwOverrideTp;
exports.planManualOrders = planManualOrders;
const pipCalculator_1 = require("./pipCalculator");
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
function planSinglePartialTps(args) {
    const { manualLot, minLot, lotStep, finalTps, bucketRows } = args;
    if (!Number.isFinite(manualLot) || manualLot <= 0) {
        return { brokerTp: null, partials: [], fallbackReason: 'partial_tp_invalid_lot' };
    }
    if (!Array.isArray(finalTps) || finalTps.length < 2 || !bucketRows.length) {
        return { brokerTp: finalTps[0] ?? null, partials: [] };
    }
    // Pair buckets with TPs positionally and clamp to whichever side is shorter.
    const bucketCount = Math.min(bucketRows.length, finalTps.length);
    const pairedTps = finalTps.slice(0, bucketCount);
    const pairedBuckets = bucketRows.slice(0, bucketCount);
    // The LAST paired TP is the broker's takeprofit. The earlier ones are
    // worker-managed partials.
    const brokerTp = pairedTps[bucketCount - 1] ?? null;
    if (bucketCount < 2 || brokerTp == null) {
        return { brokerTp, partials: [] };
    }
    const FP_EPS = 1e-9;
    const toUnits = (v) => {
        if (!Number.isFinite(v) || v <= 0)
            return 0;
        return Math.max(0, Math.floor(v / lotStep + FP_EPS));
    };
    const unitsToLot = (u) => Number((u * lotStep).toFixed(8));
    const manualUnits = toUnits(manualLot);
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    // Reserve at least one minLot's worth of units for the final broker-TP
    // slice. Without this a 100%-sum schedule on a 1.0 lot would leave the
    // broker TP riding 0.0 lots — i.e. nothing — and the deepest target would
    // never trigger because there's no position left to close.
    const usableUnits = Math.max(0, manualUnits - minUnits);
    let remainingUnits = usableUnits;
    const partials = [];
    let fallbackReason;
    for (let i = 0; i < bucketCount - 1; i++) {
        const tp = pairedTps[i];
        if (tp == null || !Number.isFinite(tp) || tp <= 0)
            continue;
        const pctRaw = Number(pairedBuckets[i]?.percent);
        const pct = Number.isFinite(pctRaw) && pctRaw > 0 ? Math.min(100, pctRaw) : 0;
        if (pct <= 0)
            continue;
        let units = toUnits(manualLot * (pct / 100));
        if (units < minUnits) {
            // Percentage too small relative to broker minimum lot; skip this
            // partial. Surface it once so the user can see why their 5% TP1
            // didn't fire on a 0.10 lot trade with 0.01 minLot.
            fallbackReason = fallbackReason ?? 'partial_tp_below_min_lot';
            continue;
        }
        if (units > remainingUnits) {
            // Cap so the cumulative partials never exceed manualLot - minLot.
            units = remainingUnits;
            fallbackReason = fallbackReason ?? 'partial_tp_capped_remainder';
            if (units < minUnits)
                continue;
        }
        remainingUnits -= units;
        partials.push({
            tpIdx: i + 1,
            triggerPrice: tp,
            closeLots: unitsToLot(units),
            percent: pct,
        });
        if (remainingUnits < minUnits) {
            // No room left for any further partials — the rest goes to broker TP.
            break;
        }
    }
    return { brokerTp, partials, fallbackReason };
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
function planRangeSplit(args) {
    const { totalLegs, baseIsPendingSignal, rangeOn, rangePct, stepPips, distPips, pip, minStepPriceUnits, hasSignalAnchor } = args;
    const safe = (n) => Number.isFinite(n) && n > 0;
    const baseResult = {
        immediateLegs: totalLegs,
        pendingLegs: 0,
        effectiveStepPips: stepPips,
        stepPriceOffset: 0,
    };
    if (!rangeOn)
        return baseResult;
    if (baseIsPendingSignal)
        return { ...baseResult, fallbackReason: 'range_trading_skip_pending_signal' };
    if (!safe(stepPips) || !safe(distPips)) {
        return { ...baseResult, fallbackReason: 'range_trading_invalid' };
    }
    let effectiveStepPips = stepPips;
    let fallbackReason;
    if (minStepPriceUnits > 0 && pip > 0 && stepPips * pip < minStepPriceUnits) {
        effectiveStepPips = Math.max(stepPips, Math.ceil(minStepPriceUnits / pip));
        fallbackReason = 'range_trading_step_auto_expanded';
    }
    const stepPriceOffset = effectiveStepPips * pip;
    const reservedLegs = Math.max(0, Math.round((totalLegs * rangePct) / 100));
    if (reservedLegs <= 0) {
        return { ...baseResult, effectiveStepPips, stepPriceOffset, fallbackReason };
    }
    const immediateLegs = Math.max(0, totalLegs - reservedLegs);
    // Executor needs SOMETHING to anchor against. If the signal has no entry and
    // we have no immediates, the executor still has /Quote as a fallback, so we
    // proceed and rely on the runtime anchor. We only drop the range when there
    // is literally no path to an anchor (no signal entry AND no immediate fills),
    // which the executor will detect explicitly.
    return { immediateLegs, pendingLegs: reservedLegs, effectiveStepPips, stepPriceOffset, fallbackReason: fallbackReason ?? (!hasSignalAnchor && immediateLegs === 0 ? 'range_trading_anchor_runtime_only' : undefined) };
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
function computeCwOverrideTp(args) {
    const { policy, anchor, isBuy, pip, digits } = args;
    if (!policy || policy.pipsFromAnchor <= 0)
        return null;
    if (!Number.isFinite(anchor) || anchor <= 0)
        return null;
    const dir = isBuy ? 1 : -1;
    const tp = anchor + dir * policy.pipsFromAnchor * pip;
    const d = Math.max(0, Math.min(8, Math.floor(digits)));
    return Number(tp.toFixed(d));
}
// Pip math now lives in ./pipMath. The old `pipSize(point, digits)` helper has
// been replaced by `smartPipSize(symbol, point, digits)` which classifies the
// instrument (FX vs metal vs index vs crypto vs other) before picking the
// pip multiplier. This is what fixes "10 pips on XAUUSD" being interpreted as
// $0.10 (inside stops_level) instead of $1.00.
function withinTimeWindow(start, end, now) {
    // Times are HH:MM strings in the user's local browser TZ. We approximate by
    // comparing against the server's local time here; for global accuracy we'd
    // need to store the user's TZ alongside the settings (TODO).
    const toMinutes = (s) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
        if (!m)
            return null;
        const h = Number(m[1]);
        const mm = Number(m[2]);
        if (!Number.isFinite(h) || !Number.isFinite(mm))
            return null;
        return h * 60 + mm;
    };
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (s == null || e == null)
        return true;
    const cur = now.getHours() * 60 + now.getMinutes();
    // Window can wrap midnight (e.g. 22:00 → 06:00).
    if (s <= e)
        return cur >= s && cur <= e;
    return cur >= s || cur <= e;
}
/** Build the order plan. Returns an empty plan with skip_reason when filtered out. */
function planManualOrders(args) {
    const { parsed, resolvedSymbol, baseOperation, manual, channelKeywords, manualLot, ctx, commentPrefix, expertId, slippage, } = args;
    const now = ctx.now ?? new Date();
    const delay_ms = Math.max(0, Number(channelKeywords?.additional?.delay_msec ?? 0) | 0);
    // ── 1. Filters ──────────────────────────────────────────────────────────
    if (manual.days_filter_enabled) {
        const allowed = (manual.trade_days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number);
        if (!allowed.includes(now.getDay())) {
            return { orders: [], skip_reason: 'filtered_day', delay_ms };
        }
    }
    if (manual.time_filter_enabled && manual.trade_start_time && manual.trade_end_time) {
        if (!withinTimeWindow(manual.trade_start_time, manual.trade_end_time, now)) {
            return { orders: [], skip_reason: 'filtered_time', delay_ms };
        }
    }
    // ── 2. Reverse direction ────────────────────────────────────────────────
    const opSplit = manual.reverse_signal ? flipOperation(baseOperation) : baseOperation;
    const isBuy = opSplit.startsWith('Buy');
    // ── 3. Resolve entry price (with channel prefer_entry on zones) ─────────
    let entry = parsed.entry_price != null ? Number(parsed.entry_price) : null;
    if (entry != null && !Number.isFinite(entry))
        entry = null;
    if (entry == null && parsed.entry_zone_low != null && parsed.entry_zone_high != null) {
        const lo = Number(parsed.entry_zone_low);
        const hi = Number(parsed.entry_zone_high);
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
            const prefer = channelKeywords?.additional?.prefer_entry ?? 'first_price';
            entry = prefer === 'last_price' ? Math.max(lo, hi) : Math.min(lo, hi);
        }
    }
    const entryOk = entry != null && Number.isFinite(entry) && entry > 0;
    const entryAnchor = entryOk ? entry : null;
    // ── 4. SL/TP derivation ─────────────────────────────────────────────────
    // Single source of truth for both pip price (used immediately below for
    // SL/TP/range step math) and pip value per std/mini/micro lot (surfaced
    // on PlannerResult.pipQuote for the executor's summary log and the UI).
    const pipQuote = (0, pipCalculator_1.pipCalculator)(resolvedSymbol, ctx.point, ctx.digits, ctx.contractSize ?? null);
    const pip = pipQuote.pipPrice;
    const slInPips = channelKeywords?.additional?.sl_in_pips === true;
    const tpInPips = channelKeywords?.additional?.tp_in_pips === true;
    // Channel reported pip distances rather than prices — convert.
    let parsedSl = parsed.sl ?? null;
    let parsedTps = (parsed.tp ?? []).filter((n) => typeof n === 'number' && Number.isFinite(n));
    if (slInPips && parsedSl != null && entryAnchor != null) {
        parsedSl = isBuy ? entryAnchor - parsedSl * pip : entryAnchor + parsedSl * pip;
    }
    if (tpInPips && parsedTps.length && entryAnchor != null) {
        parsedTps = parsedTps.map(t => (isBuy ? entryAnchor + t * pip : entryAnchor - t * pip));
    }
    // Apply manual_settings overrides for SL/TP when enabled.
    let finalSl = parsedSl;
    let finalTps = parsedTps;
    if (manual.use_predefined_sl_pips && Number.isFinite(manual.predefined_sl_pips ?? NaN) && entryAnchor != null) {
        const sl_pips = Number(manual.predefined_sl_pips);
        finalSl = isBuy ? entryAnchor - sl_pips * pip : entryAnchor + sl_pips * pip;
    }
    if (manual.use_predefined_tp_pips && Array.isArray(manual.predefined_tp_pips) && entryAnchor != null) {
        const tps = manual.predefined_tp_pips
            .map(Number)
            .filter(n => Number.isFinite(n) && n > 0);
        if (tps.length) {
            finalTps = tps.map(t => (isBuy ? entryAnchor + t * pip : entryAnchor - t * pip));
        }
    }
    // R:R derivation when only one side is known.
    if (manual.rr_for_sl_enabled && Number.isFinite(manual.rr_for_sl ?? NaN) && entryAnchor != null && finalTps.length && finalSl == null) {
        const rr = Number(manual.rr_for_sl);
        if (rr > 0) {
            const tpDist = Math.abs(finalTps[0] - entryAnchor);
            const slDist = tpDist / rr;
            finalSl = isBuy ? entryAnchor - slDist : entryAnchor + slDist;
        }
    }
    if (manual.rr_for_tps_enabled && Array.isArray(manual.rr_for_tps) && entryAnchor != null && finalSl != null && finalTps.length === 0) {
        const slDist = Math.abs(entryAnchor - finalSl);
        finalTps = manual.rr_for_tps
            .map(Number)
            .filter(n => Number.isFinite(n) && n > 0)
            .map(rr => (isBuy ? entryAnchor + rr * slDist : entryAnchor - rr * slDist));
    }
    const roundPrice = (v) => {
        if (v == null || !Number.isFinite(v))
            return 0;
        const d = Math.max(0, Math.min(8, Number.isFinite(ctx.digits) ? ctx.digits : 5));
        return Number(v.toFixed(d));
    };
    // ── 4b. Clamp SL/TP outside the broker's stops_level band, using `entry`
    //   as the market proxy. Without this, signals that quote tight TPs (e.g.
    //   XAUUSD TP only 20 "pips" = $0.20 away on a 2-digit broker) get rejected
    //   with "Invalid stops in the request". The tradeExecutor clamp also runs
    //   per-order, but doing it here ensures every derived order (immediate,
    //   range pending, close-worse-entries override) inherits a safe baseline.
    const stopsLevel = Number(ctx.stopsLevel ?? 0) || 0;
    const freezeLevel = Number(ctx.freezeLevel ?? 0) || 0;
    const safeLevel = Math.max(stopsLevel, freezeLevel);
    const minStopDist = safeLevel > 0 ? (safeLevel + 2) * ctx.point : 0;
    const clampToStops = (price, isTp, ref) => {
        if (price == null || !Number.isFinite(price) || ref == null || ref <= 0 || minStopDist <= 0) {
            return price;
        }
        const wantAbove = isTp ? isBuy : !isBuy;
        if (wantAbove) {
            const floorPrice = ref + minStopDist;
            return price < floorPrice ? Number(floorPrice.toFixed(ctx.digits)) : price;
        }
        const ceilPrice = ref - minStopDist;
        return price > ceilPrice ? Number(ceilPrice.toFixed(ctx.digits)) : price;
    };
    if (entryAnchor != null && minStopDist > 0) {
        finalSl = clampToStops(finalSl, false, entryAnchor);
        finalTps = finalTps.map(tp => clampToStops(tp, true, entryAnchor) ?? tp);
    }
    // ── 4c. Signal entry strictness: market vs limit execution ─────────────
    // `opSplit` drives range-split semantics (pending-shaped signals skip virtual range).
    // `opExec` is what we actually send: market when quote is still inside tolerance.
    let opExec = opSplit;
    const tolPips = Number(manual.signal_entry_pip_tolerance ?? 10);
    if (manual.use_signal_entry_price === true
        && entryAnchor != null
        && pip > 0
        && Number.isFinite(tolPips)
        && tolPips >= 0
        && ctx.liveBid != null
        && ctx.liveAsk != null
        && Number.isFinite(ctx.liveBid)
        && Number.isFinite(ctx.liveAsk)) {
        if (isBuy) {
            const maxBuy = entryAnchor + tolPips * pip;
            opExec = ctx.liveAsk <= maxBuy ? 'Buy' : 'BuyLimit';
        }
        else {
            const minSell = entryAnchor - tolPips * pip;
            opExec = ctx.liveBid >= minSell ? 'Sell' : 'SellLimit';
        }
    }
    // ── 5. Multi-Trade lot splitting ────────────────────────────────────────
    const tradeStyle = manual.trade_style === 'multi' ? 'multi' : 'single';
    const isMarketExec = opExec === 'Buy' || opExec === 'Sell';
    const orderBase = {
        symbol: resolvedSymbol,
        operation: opExec,
        price: isMarketExec
            ? 0
            : (entryAnchor != null ? roundPrice(entryAnchor) : roundPrice(entry)),
        slippage: slippage ?? 20,
        comment: commentPrefix,
        expertID: expertId,
    };
    const expirationFields = {};
    if (opExec.includes('Limit') || opExec.includes('Stop')) {
        const hours = Number(manual.pending_expiry_hours ?? 0);
        if (Number.isFinite(hours) && hours > 0) {
            const exp = new Date(now.getTime() + hours * 60 * 60 * 1000);
            expirationFields.expiration = exp.toISOString();
            expirationFields.expirationType = 'Specified';
        }
    }
    const minLot = Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01;
    const lotStep = Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01;
    // Work in integer "lot-step units" to dodge floating-point drift on things like
    // 14 × 0.07 = 0.9800000000000001 (which would otherwise eat a 0.01 remainder).
    const FP_EPS = 1e-9;
    const toUnits = (v) => {
        if (!Number.isFinite(v) || v <= 0)
            return 0;
        return Math.max(0, Math.floor(v / lotStep + FP_EPS));
    };
    const unitsToLot = (u) => Number((u * lotStep).toFixed(8));
    const buildSingleOrder = (fallbackReason) => {
        // Per-TP partial-close schedule. When the user configured `tp_lots`
        // percentages AND the signal carries ≥ 2 TPs, the single trade rides
        // to the LAST configured-bucket TP at the broker, and the EARLIER
        // buckets become `partial_tp_legs` rows that `partialTpMonitor`
        // /OrderCloses at each trigger. When the schedule doesn't apply we
        // fall back to legacy "broker TP = TP1, no partials" behavior so
        // single-TP signals keep working.
        const enabledForSingle = (manual.tp_lots ?? []).filter(r => r && r.enabled);
        const partialPlan = planSinglePartialTps({
            manualLot,
            minLot: Number.isFinite(ctx.minLot) && ctx.minLot > 0 ? ctx.minLot : 0.01,
            lotStep: Number.isFinite(ctx.lotStep) && ctx.lotStep > 0 ? ctx.lotStep : 0.01,
            finalTps,
            bucketRows: enabledForSingle,
        });
        const brokerTp = partialPlan.brokerTp ?? finalTps[0] ?? null;
        const combinedFallback = fallbackReason ?? partialPlan.fallbackReason;
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
        };
    };
    if (tradeStyle !== 'multi') {
        return buildSingleOrder();
    }
    const legPct = Math.max(0.1, Math.min(100, Number(manual.multi_trade_leg_percent ?? 5)));
    /** Hard safety cap on concurrent OrderSend payloads per signal. */
    const ABS_MAX_LEGS = 500;
    const manualUnits = toUnits(manualLot);
    const targetUnits = toUnits(manualLot * (legPct / 100));
    const minUnits = Math.max(1, Math.round(minLot / lotStep));
    if (targetUnits < minUnits) {
        return buildSingleOrder('multi_trade_fallback_min_lot');
    }
    if (manualUnits < minUnits) {
        // Even a full-size order can't clear the broker minimum — let the caller drop it.
        return { orders: [], skip_reason: 'lot_below_symbol_min', delay_ms };
    }
    const totalLegs = Math.max(1, Math.min(ABS_MAX_LEGS, Math.floor(manualUnits / targetUnits)));
    const targetLeg = unitsToLot(targetUnits);
    // ── 6. Range Trading split ──────────────────────────────────────────────
    // Delegates to the exported `planRangeSplit` helper so the immediate/pending
    // math stays pure and testable. The planner only decides COUNTS here; pending
    // PRICES are computed at the executor against the live anchor (signal entry
    // → /Quote bid/ask → first-fill openPrice).
    // Range split must follow whether the *signal* is pending-shaped (`opSplit`),
    // not the downgraded market `opExec` used for immediate OrderSend — otherwise
    // entry signals would incorrectly enable virtual range legs.
    const baseIsPendingSignal = opSplit.includes('Limit') || opSplit.includes('Stop');
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
    });
    const immediateLegs = split.immediateLegs;
    const effectiveRangeLegs = split.pendingLegs;
    const effectiveStepPips = split.effectiveStepPips;
    const stepPriceOffset = split.stepPriceOffset;
    const rangeFallbackReason = split.fallbackReason;
    // ── 7. TP bucket setup (shared by immediate + range distributions) ──────
    const enabledRows = (manual.tp_lots ?? []).filter(r => r && r.enabled);
    const bucketCount = finalTps.length > 0
        ? Math.max(1, Math.min(enabledRows.length || 1, finalTps.length))
        : 1;
    const bucketRows = (enabledRows.length ? enabledRows : [{ label: 'TP1', lot: 0, percent: 100, enabled: true }])
        .slice(0, bucketCount);
    const rawWeights = bucketRows.map(r => {
        const p = Number(r.percent);
        return Number.isFinite(p) && p > 0 ? p : 0;
    });
    const weights = rawWeights.every(w => w === 0) ? bucketRows.map(() => 1) : rawWeights;
    const sumW = weights.reduce((a, b) => a + b, 0) || bucketRows.length;
    /** Distribute `count` legs across the TP buckets, folding rounding drift into the last bucket. */
    const distributeCount = (count) => {
        const out = bucketRows.map(() => 0);
        if (count <= 0 || bucketRows.length === 0)
            return out;
        for (let i = 0; i < weights.length; i++) {
            out[i] = Math.round((count * weights[i]) / sumW);
        }
        let drift = count - out.reduce((a, b) => a + b, 0);
        let idx = out.length - 1;
        let guard = out.length * 2;
        while (drift !== 0 && guard-- > 0) {
            if (drift > 0) {
                out[idx] += 1;
                drift -= 1;
            }
            else if (out[idx] > 0) {
                out[idx] -= 1;
                drift += 1;
            }
            idx = (idx - 1 + out.length) % out.length;
            if (drift < 0 && out.every(c => c === 0))
                break;
        }
        return out;
    };
    const tpForBucket = (b) => {
        if (finalTps.length === 0)
            return null;
        return finalTps[b] ?? finalTps[finalTps.length - 1] ?? null;
    };
    const immediateCounts = distributeCount(immediateLegs);
    const rangeCounts = distributeCount(effectiveRangeLegs);
    // ── 8. Emit immediate legs (MARKET orders sent right away) ──────────────
    const orders = [];
    for (let b = 0; b < bucketRows.length; b++) {
        const tpPrice = tpForBucket(b);
        for (let k = 0; k < (immediateCounts[b] ?? 0); k++) {
            orders.push({
                ...orderBase,
                volume: targetLeg,
                stoploss: roundPrice(finalSl),
                takeprofit: roundPrice(tpPrice),
                ...expirationFields,
                comment: `${commentPrefix}:tp${b + 1}.${k + 1}`,
            });
        }
    }
    // ── 9. Build virtual range pendings (persisted, not sent to broker) ─────
    // These are NOT placed at the broker as BuyLimit/SellLimit. The executor
    // INSERTs them into `range_pending_legs` with a computed `trigger_price`;
    // the worker's virtualPendingMonitor (1.5s) and the range-pending-sweep
    // edge function (60s) poll /Quote and fire each leg as a MARKET order the
    // moment its trigger price is hit. This sidesteps every broker rejection
    // class (stops_level / freeze_level / min-Limit-distance).
    const virtualPendings = [];
    if (effectiveRangeLegs > 0) {
        const pendHours = Number(manual.pending_expiry_hours ?? 0);
        const expiryHours = Number.isFinite(pendHours) && pendHours > 0 ? pendHours : undefined;
        let stepIdx = 1;
        for (let b = 0; b < bucketRows.length; b++) {
            const tpPrice = tpForBucket(b);
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
                });
                stepIdx += 1;
            }
        }
    }
    // ── 10. Remainder leg (legacy exact-lot behaviour, skipped in range mode) ─
    // In range mode the user explicitly accepts that the effective lot can be
    // less than manualLot, so we don't tack on a fractional remainder leg.
    if (effectiveRangeLegs === 0) {
        const remainderUnits = manualUnits - totalLegs * targetUnits;
        if (remainderUnits >= minUnits && orders.length < ABS_MAX_LEGS) {
            const tpPrice = tpForBucket(bucketRows.length - 1);
            orders.push({
                ...orderBase,
                volume: unitsToLot(remainderUnits),
                stoploss: roundPrice(finalSl),
                takeprofit: roundPrice(tpPrice),
                ...expirationFields,
                comment: `${commentPrefix}:tp${bucketRows.length}.rem`,
            });
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
    let closeWorseEntries;
    if (effectiveRangeLegs > 0 && manual.close_worse_entries === true) {
        const cwPips = Math.max(0, Number(manual.close_worse_entries_pips ?? 0));
        if (cwPips > 0) {
            const extraPendings = Math.max(0, Math.min(effectiveRangeLegs, Math.floor(Number(manual.close_worse_extra_pendings ?? 0))));
            closeWorseEntries = {
                immediates: immediateLegs,
                extraPendings,
                pipsFromAnchor: cwPips,
            };
        }
    }
    if (orders.length === 0 && virtualPendings.length === 0) {
        // Defensive: shouldn't happen given totalLegs >= 1.
        return buildSingleOrder('multi_trade_fallback_zero_legs');
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
    };
}
function flipOperation(op) {
    switch (op) {
        case 'Buy': return 'Sell';
        case 'Sell': return 'Buy';
        case 'BuyLimit': return 'SellLimit';
        case 'SellLimit': return 'BuyLimit';
        case 'BuyStop': return 'SellStop';
        case 'SellStop': return 'BuyStop';
        case 'BuyStopLimit': return 'SellStopLimit';
        case 'SellStopLimit': return 'BuyStopLimit';
        default: return op;
    }
}
