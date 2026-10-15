/**
 * Broker gateway rate pacer with a priority lane.
 *
 * Every MTAPI HTTP call is issued through MtapiProvider.request(), so pacing
 * here is a single chokepoint that protects the bridge from any caller
 * (health sweeps, management, reconciliation, entries). Calls are split into
 * two independent channels:
 *
 *   - 'order'      — order operations (send/modify/close)
 *   - 'background' — health, reads, management, reconciliation
 *
 * The channels are separate so a background burst can never delay an order;
 * each has its own global start rate, and together they stay under the
 * bridge's capacity. Background calls are additionally paced per account.
 *
 * Deliberately a pacer, not a rejector: acquire() waits its turn and never
 * throws, so a rate limit can delay work but can never fail an order.
 */

export type BrokerPriority = 'order' | 'background'

export type BrokerGateway = {
  acquire(accountKey: string, priority?: BrokerPriority): Promise<void>
  /** Test/introspection helper. */
  stats(): { trackedAccounts: number; orderNextAt: number; backgroundNextAt: number }
}

export type BrokerGatewayOptions = {
  /** Global start rate for order operations. */
  orderRps?: number
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
  const orderRps = options.orderRps ?? resolveRps(process.env.MTAPI_ORDER_RPS, 6)
  const backgroundRps = options.backgroundRps ?? resolveRps(process.env.MTAPI_BACKGROUND_RPS, 3)
  const perAccountRps = options.perAccountRps ?? resolveRps(process.env.MTAPI_PER_ACCOUNT_RPS, 6)
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  const orderInterval = orderRps > 0 ? 1000 / orderRps : 0
  const backgroundInterval = backgroundRps > 0 ? 1000 / backgroundRps : 0
  const perAccountInterval = perAccountRps > 0 ? 1000 / perAccountRps : 0
  const accountNextAt = new Map<string, number>()
  let orderNextAt = 0
  let backgroundNextAt = 0

  async function acquire(accountKey: string, priority: BrokerPriority = 'background'): Promise<void> {
    const key = accountKey || '__global__'
    const t = now()
    let start = t
    if (priority === 'order') {
      // Orders use their own channel only: never wait behind background pacing.
      start = Math.max(t, orderNextAt)
      if (orderInterval > 0) orderNextAt = start + orderInterval
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
  }

  function stats() {
    return { trackedAccounts: accountNextAt.size, orderNextAt, backgroundNextAt }
  }

  return { acquire, stats }
}
