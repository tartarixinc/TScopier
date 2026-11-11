/**
 * Broker gateway rate pacer with a priority lane.
 *
 * Every MTAPI HTTP call is issued through MtapiProvider.request(), so pacing
 * here is a single chokepoint that protects the bridge from any caller
 * (health sweeps, management, reconciliation, entries). Calls are split into
 * two independent channels:
 *
 *   - 'order'      — order operations (send/modify/close) and entry-critical
 *                    reads (Quote / OpenedOrders during prepare+send)
 *   - 'background' — health, monitor reads, reconciliation
 *
 * The channels are separate so a background burst can never delay an order;
 * each has its own global start rate, and together they stay under the
 * bridge's capacity. Background calls are additionally paced per account.
 *
 * Deliberately a pacer, not a rejector: acquire() waits its turn and never
 * throws, so a rate limit can delay work but can never fail an order.
 * Returns the milliseconds spent waiting so callers can attribute latency.
 */

export type BrokerPriority = 'order' | 'background'

export type BrokerGateway = {
  /** Resolves with the milliseconds spent waiting for the lane (0 when immediate). */
  acquire(accountKey: string, priority?: BrokerPriority): Promise<number>
  /** Test/introspection helper. */
  stats(): { trackedAccounts: number; orderNextAt: number; backgroundNextAt: number }
}

export type BrokerGatewayOptions = {
  /** Global start rate for order operations (ceiling across all accounts). */
  orderRps?: number
  /** Per-account start rate for order operations (default = orderRps; avoids one account blocking others). */
  orderPerAccountRps?: number
  /** Global start rate for background calls. */
  backgroundRps?: number
  /** Per-account start rate for background calls. */
  perAccountRps?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

function resolveRps(raw: unknown, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function createBrokerGateway(options: BrokerGatewayOptions = {}): BrokerGateway {
  const orderRps = options.orderRps ?? resolveRps(process.env.MTAPI_ORDER_RPS, 12)
  const orderPerAccountRps = options.orderPerAccountRps
    ?? resolveRps(process.env.MTAPI_ORDER_PER_ACCOUNT_RPS, orderRps > 0 ? Math.min(orderRps, 8) : 8)
  const backgroundRps = options.backgroundRps ?? resolveRps(process.env.MTAPI_BACKGROUND_RPS, 3)
  const perAccountRps = options.perAccountRps ?? resolveRps(process.env.MTAPI_PER_ACCOUNT_RPS, 6)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  const orderInterval = orderRps > 0 ? 1000 / orderRps : 0
  const orderPerAccountInterval = orderPerAccountRps > 0 ? 1000 / orderPerAccountRps : 0
  const backgroundInterval = backgroundRps > 0 ? 1000 / backgroundRps : 0
  const perAccountInterval = perAccountRps > 0 ? 1000 / perAccountRps : 0
  const accountNextAt = new Map<string, number>()
  const orderAccountNextAt = new Map<string, number>()
  let orderNextAt = 0
  let backgroundNextAt = 0

  async function acquire(accountKey: string, priority: BrokerPriority = 'background'): Promise<number> {
    const key = accountKey || '__global__'
    const t = now()
    let start = t
    if (priority === 'order') {
      // Orders use a global ceiling plus a per-account lane so a 34-leg close on
      // one account does not starve another account's OrderSend/Close.
      const aNext = orderAccountNextAt.get(key) ?? 0
      start = Math.max(t, orderNextAt, aNext)
      if (orderInterval > 0) orderNextAt = start + orderInterval
      if (orderPerAccountInterval > 0) orderAccountNextAt.set(key, start + orderPerAccountInterval)
    } else {
      const aNext = accountNextAt.get(key) ?? 0
      start = Math.max(t, aNext, backgroundNextAt)
      if (perAccountInterval > 0) accountNextAt.set(key, start + perAccountInterval)
      if (backgroundInterval > 0) backgroundNextAt = start + backgroundInterval
    }
    const wait = start - t
    if (wait > 0) await sleep(wait)
    if (accountNextAt.size > 4096) {
      for (const [k, v] of accountNextAt) if (v < t) accountNextAt.delete(k)
    }
    if (orderAccountNextAt.size > 4096) {
      for (const [k, v] of orderAccountNextAt) if (v < t) orderAccountNextAt.delete(k)
    }
    return wait > 0 ? wait : 0
  }

  function stats() {
    return { trackedAccounts: accountNextAt.size, orderNextAt, backgroundNextAt }
  }

  return { acquire, stats }
}
