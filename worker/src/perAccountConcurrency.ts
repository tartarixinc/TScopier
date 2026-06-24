/**
 * Per-key concurrency gate.
 *
 * An MT4/MT5 terminal executes trade operations serially; firing many
 * OrderSend/OrderModify/OrderClose at one terminal in parallel makes the bridge
 * queue them and return "timed out". This gate bounds the number of in-flight
 * operations per account (key) regardless of how wide callers parallelize, so a
 * single terminal is never overwhelmed.
 */

type Slot = { active: number; queue: Array<() => void> }

export type ConcurrencyGate = {
  acquire(key: string, limit: number): Promise<() => void>
  /** Test/introspection helper: active in-flight count for a key. */
  activeCount(key: string): number
}

export function createConcurrencyGate(): ConcurrencyGate {
  const slots = new Map<string, Slot>()

  async function acquire(key: string, limit: number): Promise<() => void> {
    const max = Math.max(1, Math.floor(limit) || 1)
    let slot = slots.get(key)
    if (!slot) {
      slot = { active: 0, queue: [] }
      slots.set(key, slot)
    }
    const s = slot
    if (s.active < max) {
      s.active += 1
    } else {
      // Wait for a slot to be handed off (active is kept on handoff, not ++'d).
      await new Promise<void>(resolve => s.queue.push(resolve))
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = s.queue.shift()
      if (next) {
        next() // hand our slot directly to the next waiter; active unchanged
      } else {
        s.active -= 1
        if (s.active <= 0 && s.queue.length === 0) slots.delete(key)
      }
    }
  }

  function activeCount(key: string): number {
    return slots.get(key)?.active ?? 0
  }

  return { acquire, activeCount }
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
