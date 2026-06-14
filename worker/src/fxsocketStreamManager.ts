import {
  FxsocketWsClient,
  type FxsocketWsMessageHandler,
  type FxsocketWsServerMessage,
  type FxsocketWsSubscribeFrame,
  type FxsocketWsTopic,
} from './fxsocketWsClient'

export type FxsocketStreamHandler = FxsocketWsMessageHandler

export interface FxsocketStreamSubscription {
  topic: FxsocketWsTopic
  symbol?: string
  timeframe?: string
}

interface AccountStream {
  client: FxsocketWsClient
  handlers: Set<FxsocketStreamHandler>
  topicRefCounts: Map<string, number>
}

function topicKey(sub: FxsocketStreamSubscription): string {
  const parts: string[] = [sub.topic]
  if (sub.symbol) parts.push(sub.symbol)
  if (sub.timeframe) parts.push(sub.timeframe)
  return parts.join(':')
}

function frameFromSubscription(sub: FxsocketStreamSubscription): Omit<FxsocketWsSubscribeFrame, 'action'> {
  return {
    topic: sub.topic,
    symbol: sub.symbol,
    timeframe: sub.timeframe,
  }
}

/**
 * Manages one upstream FxSocket WebSocket per account and fans out messages
 * to multiple in-process subscribers. Topic subscriptions are reference-counted
 * so the upstream socket only subscribes once per unique topic/symbol/timeframe.
 */
export class FxsocketStreamManager {
  private readonly apiKey: string
  private readonly baseUrl?: string
  private readonly streams = new Map<string, AccountStream>()

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    const key = (opts?.apiKey ?? process.env.FXSOCKET_API_KEY ?? '').trim()
    if (!key) throw new Error('FxsocketStreamManager: FXSOCKET_API_KEY required')
    this.apiKey = key
    this.baseUrl = opts?.baseUrl?.trim() || process.env.FXSOCKET_BASE_URL?.trim() || undefined
  }

  /**
   * Subscribe to stream messages for an account. Returns an unsubscribe function.
   * Pass `subscriptions` to auto-subscribe upstream topics (reference-counted).
   */
  subscribe(
    accountId: string,
    handler: FxsocketStreamHandler,
    subscriptions: FxsocketStreamSubscription[] = [],
  ): () => void {
    const id = String(accountId ?? '').trim()
    if (!id) throw new Error('FxsocketStreamManager.subscribe: accountId required')

    let stream = this.streams.get(id)
    if (!stream) {
      const client = new FxsocketWsClient({
        accountId: id,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        onConnectionChange: (connected) => {
          if (connected) return
          if (!this.streams.has(id)) return
          const current = this.streams.get(id)
          if (current && current.handlers.size === 0) {
            this.teardownAccount(id)
          }
        },
      })
      const relay: FxsocketWsMessageHandler = (msg) => {
        for (const h of stream!.handlers) {
          try { h(msg) } catch (e) {
            console.warn('[fxsocketStreamManager] handler error:', e instanceof Error ? e.message : e)
          }
        }
      }
      client.onMessage(relay)
      stream = { client, handlers: new Set(), topicRefCounts: new Map() }
      this.streams.set(id, stream)
    }

    stream.handlers.add(handler)
    for (const sub of subscriptions) {
      this.addTopicRef(stream, sub)
    }
    stream.client.connect()

    return () => {
      this.unsubscribe(id, handler, subscriptions)
    }
  }

  unsubscribe(
    accountId: string,
    handler: FxsocketStreamHandler,
    subscriptions: FxsocketStreamSubscription[] = [],
  ): void {
    const id = String(accountId ?? '').trim()
    const stream = this.streams.get(id)
    if (!stream) return

    stream.handlers.delete(handler)
    for (const sub of subscriptions) {
      this.releaseTopicRef(stream, sub)
    }

    if (stream.handlers.size === 0) {
      this.teardownAccount(id)
    }
  }

  /** Explicit upstream topic subscribe without adding a message handler. */
  ensureTopic(accountId: string, sub: FxsocketStreamSubscription): () => void {
    const id = String(accountId ?? '').trim()
    let stream = this.streams.get(id)
    if (!stream) {
      const noop = () => {}
      const unsub = this.subscribe(id, noop, [sub])
      stream = this.streams.get(id)
      return () => {
        unsub()
      }
    }
    this.addTopicRef(stream, sub)
    stream.client.connect()
    return () => {
      this.releaseTopicRef(stream!, sub)
      if (stream!.handlers.size === 0) this.teardownAccount(id)
    }
  }

  subscribePrices(accountId: string, symbol: string, handler: FxsocketStreamHandler): () => void {
    return this.subscribe(accountId, handler, [{ topic: 'prices', symbol }])
  }

  subscribePositions(accountId: string, handler: FxsocketStreamHandler): () => void {
    return this.subscribe(accountId, handler, [{ topic: 'positions' }])
  }

  subscribeAccount(accountId: string, handler: FxsocketStreamHandler): () => void {
    return this.subscribe(accountId, handler, [{ topic: 'account' }])
  }

  subscribeTrades(accountId: string, handler: FxsocketStreamHandler): () => void {
    return this.subscribe(accountId, handler, [{ topic: 'trades' }])
  }

  subscribeTerminal(accountId: string, handler: FxsocketStreamHandler): () => void {
    return this.subscribe(accountId, handler, [{ topic: 'terminal' }])
  }

  isConnected(accountId: string): boolean {
    return this.streams.get(accountId)?.client.connected ?? false
  }

  closeAll(): void {
    for (const id of [...this.streams.keys()]) {
      this.teardownAccount(id)
    }
  }

  closeAccount(accountId: string): void {
    this.teardownAccount(String(accountId ?? '').trim())
  }

  private addTopicRef(stream: AccountStream, sub: FxsocketStreamSubscription): void {
    const key = topicKey(sub)
    const prev = stream.topicRefCounts.get(key) ?? 0
    stream.topicRefCounts.set(key, prev + 1)
    if (prev === 0) {
      stream.client.subscribe(frameFromSubscription(sub))
    }
  }

  private releaseTopicRef(stream: AccountStream, sub: FxsocketStreamSubscription): void {
    const key = topicKey(sub)
    const prev = stream.topicRefCounts.get(key) ?? 0
    if (prev <= 1) {
      stream.topicRefCounts.delete(key)
      stream.client.unsubscribe(frameFromSubscription(sub))
    } else {
      stream.topicRefCounts.set(key, prev - 1)
    }
  }

  private teardownAccount(accountId: string): void {
    const stream = this.streams.get(accountId)
    if (!stream) return
    this.streams.delete(accountId)
    stream.client.close()
  }
}

let managerSingleton: FxsocketStreamManager | null | undefined

export function getFxsocketStreamManager(): FxsocketStreamManager | null {
  if (managerSingleton !== undefined) return managerSingleton
  try {
    managerSingleton = new FxsocketStreamManager()
    return managerSingleton
  } catch {
    managerSingleton = null
    return null
  }
}

export type { FxsocketWsServerMessage }
