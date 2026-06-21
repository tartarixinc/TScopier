"use strict";
/** Lightweight in-process counters for logs and /health (no external metrics stack required). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.incMetric = incMetric;
exports.getMetricsSnapshot = getMetricsSnapshot;
const counters = new Map();
function incMetric(name, delta = 1) {
    counters.set(name, (counters.get(name) ?? 0) + delta);
}
function getMetricsSnapshot() {
    return Object.fromEntries(counters.entries());
}
