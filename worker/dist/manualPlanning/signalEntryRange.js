"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.signalRangeBoundary = signalRangeBoundary;
exports.signalZoneWidthPips = signalZoneWidthPips;
exports.resolveRangeDistancePips = resolveRangeDistancePips;
exports.buildRangeEntryWait = buildRangeEntryWait;
exports.quoteOverlapsEntryZone = quoteOverlapsEntryZone;
exports.signalRangeEntryQuoteAllowsImmediate = signalRangeEntryQuoteAllowsImmediate;
exports.virtualLegTriggerInZone = virtualLegTriggerInZone;
exports.virtualLegTriggerAllowed = virtualLegTriggerAllowed;
const parsedEntry_1 = require("./parsedEntry");
const executionShape_1 = require("./executionShape");
const manualSettings_1 = require("./manualSettings");
/** Far edge of the entry zone in the layering direction (buy → low, sell → high). */
function signalRangeBoundary(parsed, isBuy) {
    const z = (0, parsedEntry_1.resolvedParsedEntryZone)(parsed);
    if (!z)
        return null;
    return isBuy ? z.lo : z.hi;
}
/** Entry zone span in pips (hi − lo). */
function signalZoneWidthPips(parsed, pip) {
    const z = (0, parsedEntry_1.resolvedParsedEntryZone)(parsed);
    if (!z || !Number.isFinite(pip) || pip <= 0)
        return null;
    const width = Math.abs(z.hi - z.lo);
    if (!Number.isFinite(width) || width <= 0)
        return null;
    return width / pip;
}
function resolveRangeDistancePips(args) {
    const manualDist = Math.max(0, Number(args.manual.range_distance_pips ?? 0));
    if (args.manual.use_signal_entry_range !== true) {
        return { distPips: manualDist, boundary: null, source: 'manual' };
    }
    const widthPips = signalZoneWidthPips(args.parsed, args.pip);
    const boundary = signalRangeBoundary(args.parsed, args.isBuy);
    if (widthPips != null && widthPips > 0 && boundary != null) {
        return { distPips: widthPips, boundary, source: 'signal_zone' };
    }
    return { distPips: manualDist, boundary: null, source: 'manual' };
}
function buildRangeEntryWait(args) {
    if (!(0, manualSettings_1.signalEntryRangeStrictEnabled)(args.manual))
        return undefined;
    const zone = (0, parsedEntry_1.resolvedParsedEntryZone)(args.parsed);
    const entryPrice = (0, parsedEntry_1.resolvedParsedEntryPrice)(args.parsed);
    return {
        isBuy: args.isBuy,
        entryPrice,
        zoneLo: zone?.lo ?? null,
        zoneHi: zone?.hi ?? null,
        tolerancePips: Math.max(0, Number(args.manual.signal_entry_pip_tolerance ?? 10)),
    };
}
/**
 * True when the live BBO bracket overlaps the entry zone band.
 * Uses spread overlap (bid <= hi + tol AND ask >= lo - tol) so entry fires when
 * either side of the market touches the zone — not delayed by full spread width.
 */
function quoteOverlapsEntryZone(args) {
    const { bid, ask } = args;
    if (!Number.isFinite(bid) || !Number.isFinite(ask))
        return false;
    const tolPx = Math.max(0, Number(args.tolPx ?? 0));
    const lo = Math.min(args.zoneLo, args.zoneHi) - tolPx;
    const hi = Math.max(args.zoneLo, args.zoneHi) + tolPx;
    return bid <= hi && ask >= lo;
}
/**
 * True when live quote is inside the signal entry band.
 * Zone: BBO overlap with [zone_lo − tol, zone_hi + tol] (works for any spread).
 * Point-only entry (no zone): buy ask ≤ entry + tol; sell bid ≥ entry − tol.
 */
function signalRangeEntryQuoteAllowsImmediate(args) {
    const { wait, bid, ask } = args;
    if (!Number.isFinite(bid) || !Number.isFinite(ask))
        return false;
    const pip = Number(args.pipSize ?? 0);
    const tolPips = Math.max(0, Number(wait.tolerancePips ?? 0));
    const tolPx = tolPips > 0 && pip > 0 ? tolPips * pip : 0;
    const zone = wait.zoneLo != null && wait.zoneHi != null
        ? { lo: Math.min(wait.zoneLo, wait.zoneHi), hi: Math.max(wait.zoneLo, wait.zoneHi) }
        : null;
    if (zone) {
        return quoteOverlapsEntryZone({
            bid,
            ask,
            zoneLo: zone.lo,
            zoneHi: zone.hi,
            tolPx,
        });
    }
    const entryPrice = wait.entryPrice;
    if (entryPrice == null || !Number.isFinite(entryPrice) || entryPrice <= 0)
        return false;
    return (0, executionShape_1.strictSignalEntryQuoteAllowsImmediate)({
        isBuy: wait.isBuy,
        entryPrice,
        bid,
        ask,
        tolerancePips: wait.tolerancePips,
        pipSize: pip,
    });
}
/** True when a virtual leg trigger price is still inside the signal entry zone. */
function virtualLegTriggerInZone(args) {
    const { trigger, zoneLo, zoneHi } = args;
    if (zoneLo == null || zoneHi == null)
        return true;
    if (!Number.isFinite(trigger))
        return false;
    const lo = Math.min(zoneLo, zoneHi);
    const hi = Math.max(zoneLo, zoneHi);
    return trigger >= lo && trigger <= hi;
}
/** True when a virtual leg trigger price is still inside the signal entry zone. */
function virtualLegTriggerAllowed(args) {
    const { trigger, boundary, isBuy, zoneLo, zoneHi, useFullZone } = args;
    if (useFullZone && zoneLo != null && zoneHi != null) {
        return virtualLegTriggerInZone({ trigger, zoneLo, zoneHi });
    }
    if (boundary == null || !Number.isFinite(boundary))
        return true;
    if (!Number.isFinite(trigger))
        return false;
    return isBuy ? trigger >= boundary : trigger <= boundary;
}
