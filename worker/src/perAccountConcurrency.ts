/**
 * Per-key concurrency gate.
 *
 * An MT4/MT5 terminal executes trade operations serially; firing many
 * OrderSend/OrderModify/OrderClose at one terminal in parallel makes the bridge
 * queue them and return "timed out". This gate bounds the number of in-flight
 * operations per account (key) regardless of how wide callers parallelize, so a
 * single terminal is never overwhelmed.
 *
 * Also used as a global MTAPI order lane (`__mtapi_global_order__`) so many
 * brokers share one bridge without stampeding into 50s AbortError storms.
 */

type Waiter = {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

type Slot = { active: number; queue: Waiter[] }

export class ConcurrencyBusyError extends Error {
  readonly code = 'CONCURRENCY_BUSY'
  constructor(
    readonly key: string,
    readonly waitMs: number,
  ) {
    super(`concurrency busy key=${key} wait_ms=${waitMs}`)
    this.name = 'ConcurrencyBusyError'
  }
}

export type ConcurrencyGate = {
  acquire(key: string, limit: number): Promise<() => void>
  /**
   * Like acquire, but if a slot is not available within `waitMs`, reject with
   * ConcurrencyBusyError (waiter removed from the queue). waitMs <= 0 waits forever.
   */
  acquireWithDeadline(key: string, limit: number, waitMs: number): Promise<() => void>
  /** Test/introspection helper: active in-flight count for a key. */
  activeCount(key: string): number
  waitingCount(key: string): number
}

export function createConcurrencyGate(): ConcurrencyGate {
  const slots = new Map<string, Slot>()

  function slotFor(key: string): Slot {
    let slot = slots.get(key)
    if (!slot) {
      slot = { active: 0, queue: [] }
      slots.set(key, slot)
    }
    return slot
  }

  function makeRelease(key: string, s: Slot): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = s.queue.shift()
      if (next) {
        if (next.timer) clearTimeout(next.timer)
        next.resolve() // hand our slot directly to the next waiter; active unchanged
      } else {
        s.active -= 1
        if (s.active <= 0 && s.queue.length === 0) slots.delete(key)
      }
    }
  }

  async function acquire(key: string, limit: number): Promise<() => void> {
    return acquireWithDeadline(key, limit, 0)
  }

  async function acquireWithDeadline(key: string, limit: number, waitMs: number): Promise<() => void> {
    const max = Math.max(1, Math.floor(limit) || 1)
    const s = slotFor(key)
    if (s.active < max) {
      s.active += 1
      return makeRelease(key, s)
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null }
      if (waitMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = s.queue.indexOf(waiter)
          if (idx >= 0) s.queue.splice(idx, 1)
          reject(new ConcurrencyBusyError(key, waitMs))
        }, waitMs)
      }
      s.queue.push(waiter)
    })
    return makeRelease(key, s)
  }

  function activeCount(key: string): number {
    return slots.get(key)?.active ?? 0
  }

  function waitingCount(key: string): number {
    return slots.get(key)?.queue.length ?? 0
  }

  return { acquire, acquireWithDeadline, activeCount, waitingCount }
}

/** Run `fn` while holding a concurrency slot for `key`. */
export async function runWithAccountLimit<T>(
  gate: ConcurrencyGate,
  key: string,
  limit: number,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await gate.acquire(key, limit)
  try {
    return await fn()
  } finally {
    release()
  }
}
