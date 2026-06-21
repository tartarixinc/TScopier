"use strict";
/** Bounded-concurrency async map for multi-leg management (CWE, close, modify). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mgmtLegConcurrency = mgmtLegConcurrency;
exports.parallelMap = parallelMap;
function mgmtLegConcurrency() {
    return Math.max(1, Math.min(12, Number(process.env.MGMT_LEG_CONCURRENCY ?? 6)));
}
async function parallelMap(items, concurrency, fn) {
    if (!items.length)
        return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const i = nextIndex;
            nextIndex += 1;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
}
