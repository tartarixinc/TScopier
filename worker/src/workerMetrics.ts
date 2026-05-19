/** Lightweight in-process counters for logs and /health (no external metrics stack required). */

const counters = new Map<string, number>()

export function incMetric(name: string, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta)
}

export function getMetricsSnapshot(): Record<string, number> {
  return Object.fromEntries(counters.entries())
}

export function resetMetrics(): void {
  counters.clear()
}
