/** Bounded-concurrency async map for multi-leg management (CWE, close, modify). */

export function mgmtLegConcurrency(): number {
  return Math.max(1, Math.min(12, Number(process.env.MGMT_LEG_CONCURRENCY ?? 6)))
}

export async function parallelMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex
      nextIndex += 1
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}
