"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeCwOverrideTp = computeCwOverrideTp;
/**
 * Compute the single CWE close-threshold price (`anchor ± cwePips × pip`).
 * Returns `null` when CWE is off or the inputs aren't sufficient.
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
