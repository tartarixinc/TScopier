"use strict";
/** Optional queue metrics hook for /health (trade workers). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setQueueMetricsProvider = setQueueMetricsProvider;
exports.getQueueHealthMetrics = getQueueHealthMetrics;
let metricsProvider = null;
function setQueueMetricsProvider(provider) {
    metricsProvider = provider;
}
async function getQueueHealthMetrics() {
    if (!metricsProvider)
        return [];
    try {
        return await metricsProvider();
    }
    catch {
        return [];
    }
}
