import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

export function percentileMs(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx] ?? 0
}

export function benchmarkSync(fn: () => void, iterations: number): number[] {
  // Warm up JIT / module caches before measuring.
  for (let i = 0; i < Math.min(20, iterations); i++) fn()

  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  return samples
}

export async function benchmarkAsync(fn: () => Promise<void>, iterations: number): Promise<number[]> {
  for (let i = 0; i < Math.min(10, iterations); i++) await fn()

  const samples: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  return samples
}

/** Assert p50 latency stays under budget (ms). Scale budget in CI via WORKER_PERF_BUDGET_MULTIPLIER. */
export function assertLatencyBudget(label: string, samples: number[], maxMedianMs: number): void {
  const multiplier = Number(process.env.WORKER_PERF_BUDGET_MULTIPLIER ?? '1')
  const budget = maxMedianMs * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1)
  const median = percentileMs(samples, 50)
  const p95 = percentileMs(samples, 95)
  assert.ok(
    median <= budget,
    `${label}: median ${median.toFixed(2)}ms (p95 ${p95.toFixed(2)}ms) exceeds ${budget.toFixed(2)}ms budget`,
  )
}
