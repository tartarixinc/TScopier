import type {
  AccountSummary, FxsocketMtStatus, FxsocketTerminalStatus, MtPlatform,
  OrderCloseArgs, OrderModifyArgs, OrderResult, OrderSendArgs, QuoteResult, SymbolParams,
} from './fxsocketClient'
import { normalizeOrderResponse, isTransientMtApiError, isOrderOpTimedOutMessage, orderListResponseIsIncomplete, isApiThrottleError } from './fxsocketClient'
import type { BrokerProvider } from './brokerProvider'
import { ingestMtHistoryRows, type MtHistoryProfile } from './mtTradeFields'
import { auditOrderClose } from './orderCloseAudit'
import { createConcurrencyGate } from './perAccountConcurrency'
import { createBrokerGateway, type BrokerGateway, type BrokerPriority } from './brokerGateway'

type FetchLike = typeof fetch
type RecoveryHandler = (sessionId: string) => Promise<string | null>

export class MtapiApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'MtapiApiError'
  }
}

function env(name: string): string {
  return String(process.env[name] ?? '').trim()
}

function baseUrl(platform: MtPlatform): string {
  const specific = env(platform === 'MT4' ? 'MTAPI_MT4_BASE_URL' : 'MTAPI_MT5_BASE_URL')
  return (specific || env('MTAPI_BASE_URL')).replace(/\/+$/, '')
}

function object(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numberValue(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

function boolValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
  }
  return undefined
}

/** MT5 ACCOUNT_TRADE_MODE: 0=demo, 1=contest, 2=real. MTAPI may also send strings. */
function tradeModeValue(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim().toLowerCase()
  if (text === 'demo' || text === '0') return 0
  if (text === 'contest' || text === '1') return 1
  if (text === 'real' || text === 'live' || text === '2') return 2
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function errorDetails(value: unknown): { code?: string; message?: string } {
  const row = object(value)
  const rawError = row.error ?? row.Error
  const nested = object(rawError)
  const code = row.code ?? row.Code ?? nested.code ?? nested.Code
    ?? (typeof rawError === 'string' ? rawError : undefined)
  const message = row.message ?? row.Message ?? row.errorMessage ?? nested.message ?? nested.Message
  return {
    code: code == null ? undefined : String(code),
    message: message == null ? undefined : String(message),
  }
}

function list(value: unknown, keys: string[], endpoint: string): unknown[] {
  if (Array.isArray(value)) return value
  const row = object(value)
  for (const key of keys) if (Array.isArray(row[key])) return row[key] as unknown[]
  const result = row.result ?? row.Result
  if (Array.isArray(result)) return result
  const nested = object(result)
  for (const key of keys) if (Array.isArray(nested[key])) return nested[key] as unknown[]
  throw new MtapiApiError(endpoint + ' returned an invalid list response', 502, 'INVALID_RESPONSE')
}

function isSessionGone(error: unknown): boolean {
  if (!(error instanceof MtapiApiError)) return false
  const text = (String(error.code ?? '') + ' ' + error.message).toUpperCase()
  return text.includes('INVALID_TOKEN') || text.includes('CLIENT WITH ID')
}

const tradeOpGate = createConcurrencyGate()
function perAccountTradeConcurrency(): number {
  return Math.max(1, Number(process.env.MT_TRADE_OP_CONCURRENCY ?? 3) || 3)
}

export interface MtapiProviderOptions {
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Timeout for order operations; must exceed a read timeout and sit under nginx's 60s. */
  orderTimeoutMs?: number
  recoveryHandler?: RecoveryHandler
  /** Shared rate pacer for all bridge calls (injectable for tests). */
  gateway?: BrokerGateway
}

export class MtapiProvider implements BrokerProvider {
  readonly name = 'mtapi' as const
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly orderTimeoutMs: number
  private readonly gateway: BrokerGateway
  private readonly platformBySession = new Map<string, MtPlatform>()
  private readonly canonicalSession = new Map<string, string>()
  private recoveryHandler?: RecoveryHandler

  constructor(options: MtapiProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs
      ?? Math.max(1_000, Number(process.env.MTAPI_HTTP_TIMEOUT_MS ?? 20_000))
    // Order sends wait longer than reads: the bridge/terminal may take tens of
    // seconds, and giving up early turns a successful send into a false
    // "ambiguous" outcome. Clamp strictly below nginx's proxy_read_timeout
    // (60s) so the client can never outlive the bridge and retry a 504.
    this.orderTimeoutMs = Math.min(
      55_000,
      options.orderTimeoutMs
        ?? Math.max(this.timeoutMs, Number(process.env.MTAPI_ORDER_TIMEOUT_MS ?? 50_000)),
    )
    this.recoveryHandler = options.recoveryHandler
    this.gateway = options.gateway ?? createBrokerGateway()
  }

  setRecoveryHandler(handler: RecoveryHandler | undefined): void {
    this.recoveryHandler = handler
  }

  seedPlatformCache(id: string, platform: MtPlatform | string | null | undefined): void {
    const key = String(id ?? '').trim()
    if (!key) return
    this.platformBySession.set(key, String(platform ?? '').toUpperCase() === 'MT4' ? 'MT4' : 'MT5')
  }

  private platform(id: string, explicit?: MtPlatform): MtPlatform {
    return explicit ?? this.platformBySession.get(id) ?? 'MT5'
  }

  private resolvedId(id: string): string {
    return this.canonicalSession.get(id) ?? id
  }

  private async request(
    endpoint: string,
    params: Record<string, string | number | boolean | null | undefined>,
    options: {
      platform?: MtPlatform
      sessionId?: string
      method?: 'GET' | 'POST'
      form?: FormData
      timeoutMs?: number
      priority?: BrokerPriority
    } = {},
  ): Promise<unknown> {
    const sessionId = options.sessionId ? this.resolvedId(options.sessionId) : ''
    const urlBase = baseUrl(this.platform(options.sessionId ?? '', options.platform))
    if (!urlBase) throw new MtapiApiError('MTAPI base URL is not configured', 503, 'NOT_CONFIGURED')
    const url = new URL(urlBase + '/' + endpoint)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    if (sessionId) url.searchParams.set('id', sessionId)

    if ('password' in params) {
      console.warn(`[mtapiProvider] request "${endpoint}" sends password via URL query — MTAPI protocol limitation, ensure server access logs are secured`)
    }

    // Pace BEFORE arming the request timeout: queue wait must not consume the
    // operation's time budget, or a busy gateway could itself abort an order.
    await this.gateway.acquire(sessionId || 'global', options.priority ?? 'background')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs)
    try {
      const headers: Record<string, string> = { accept: 'application/json, text/plain' }
      const proxyKey = env('MTAPI_PROXY_KEY') || env('MTAPI_API_KEY')
      if (proxyKey) headers['Authorization'] = 'Bearer ' + proxyKey
      const internalToken = env('MTAPI_INTERNAL_TOKEN')
      if (internalToken) headers['X-Internal-Token'] = internalToken
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.form,
        signal: controller.signal,
      })
      const text = await response.text()
      let body: unknown = text
      const trimmed = text.trim()
      const contentType = response.headers.get('content-type') ?? ''
      // The bridge content-negotiates: with `Accept: application/json` it returns
      // JSON, including bare JSON scalars. CheckConnect answers `"OK"` (a quoted
      // JSON string), which the old `{`/`[`-only sniff left as the literal `"OK"`
      // and made the health probe fail on every account — blocking reconciliation
      // from ever closing a flat account's stale trades. Parse by content-type too.
      if (trimmed.startsWith('{') || trimmed.startsWith('[') || contentType.includes('json')) {
        try { body = JSON.parse(trimmed) } catch { /* caller validates shape */ }
      }
      const details = errorDetails(body)
      if (!response.ok || details.code) {
        throw new MtapiApiError(
          details.message || details.code || ('MTAPI ' + endpoint + ' failed'),
          response.status,
          details.code,
        )
      }
      return body
    } catch (error) {
      if (error instanceof MtapiApiError) throw error
      const message = error instanceof Error && error.name === 'AbortError'
        ? 'MTAPI ' + endpoint + ' timed out'
        : 'MTAPI ' + endpoint + ' request failed'
      throw new MtapiApiError(message, 503, 'TRANSPORT_ERROR')
    } finally {
      clearTimeout(timer)
    }
  }

  /** Read calls retry once after token recovery; a second failure remains non-authoritative. */
  private async readRequest(
    endpoint: string,
    params: Record<string, string | number | boolean | null | undefined>,
    sessionId: string,
  ): Promise<unknown> {
    try {
      return await this.request(endpoint, params, { sessionId })
    } catch (error) {
      if (!isSessionGone(error)) throw error
      await this.ensureConnected(sessionId)
      return this.request(endpoint, params, { sessionId })
    }
  }

  async connectEx(args: {
    id: string; server: string; login: string; password: string; platform?: MtPlatform
  }): Promise<string> {
    const platform = args.platform ?? this.platform(args.id)
    const params: Record<string, string | number | boolean> = {
      user: args.login, password: args.password, server: args.server,
    }
    if (platform === 'MT4') params.downloadOrderHistory = true
    const body = await this.request('ConnectEx', params, { platform })
    const token = String(body ?? '').trim().replace(/^["']|["']$/g, '')
    if (!token) throw new MtapiApiError('MTAPI ConnectEx returned no session token', 502, 'INVALID_RESPONSE')
    this.seedPlatformCache(token, platform)
    if (args.id) this.canonicalSession.set(args.id, token)
    return token
  }

  async connect(args: {
    id?: string; login: string; password: string; host: string; port: number; platform?: MtPlatform
  }): Promise<string> {
    const platform = args.platform ?? this.platform(args.id ?? '')
    const params: Record<string, string | number | boolean> = {
      user: args.login, password: args.password, host: args.host, port: args.port,
    }
    if (platform === 'MT4') params.downloadOrderHistory = true
    const body = await this.request('Connect', params, { platform })
    const token = String(body ?? '').trim().replace(/^["']|["']$/g, '')
    if (!token) throw new MtapiApiError('MTAPI Connect returned no session token', 502, 'INVALID_RESPONSE')
    this.seedPlatformCache(token, platform)
    if (args.id) this.canonicalSession.set(args.id, token)
    return token
  }

  async connectByToken(id: string): Promise<void> {
    const body = await this.request('ConnectByToken', {}, { sessionId: id })
    const token = String(body ?? '').trim().replace(/^["']|["']$/g, '')
    if (token && token.toUpperCase() !== 'OK') {
      this.canonicalSession.set(id, token)
      this.seedPlatformCache(token, this.platform(id))
    }
  }

  async checkConnect(id: string): Promise<void> {
    const body = await this.request('CheckConnect', {}, { sessionId: id })
    // Tolerate both `OK` and the bridge's JSON-encoded `"OK"` regardless of how
    // the request layer parsed it.
    const text = typeof body === 'string' ? body.trim().replace(/^["']|["']$/g, '').toUpperCase() : ''
    if (text === 'OK') return
    throw new MtapiApiError('MTAPI CheckConnect returned an invalid response', 502, 'INVALID_RESPONSE')
  }

  async ensureConnected(id: string): Promise<void> {
    try {
      await this.checkConnect(id)
      return
    } catch (checkError) {
      try {
        await this.connectByToken(id)
        return
      } catch (tokenError) {
        if (!this.recoveryHandler || (!isSessionGone(checkError) && !isSessionGone(tokenError))) {
          throw tokenError
        }
        const recovered = await this.recoveryHandler(id)
        if (!recovered) throw tokenError
        this.canonicalSession.set(id, recovered)
        this.seedPlatformCache(recovered, this.platform(id))
      }
    }
  }

  async disconnect(id: string): Promise<void> {
    await this.request('Disconnect', {}, { sessionId: id })
  }

  async keepSessionAlive(id: string): Promise<boolean> {
    try { await this.ensureConnected(id); return true } catch { return false }
  }

  async keepSessionAliveDetailed(id: string): Promise<'alive' | 'session_gone' | 'token_reconnect_failed'> {
    try { await this.ensureConnected(id); return 'alive' } catch (error) {
      return isSessionGone(error) ? 'session_gone' : 'token_reconnect_failed'
    }
  }

  async verifyTradingReady(id: string): Promise<boolean> {
    try {
      const summary = await this.accountSummary(id)
      if (summary.synced === false) return false
      await this.openedOrders(id)
      return true
    } catch { return false }
  }

  async disconnectOrphans(
    knownSessionIds: string[],
    dryRun = false,
    platform: MtPlatform = 'MT5',
  ): Promise<unknown> {
    const form = new FormData()
    form.set('ids', JSON.stringify([...new Set(knownSessionIds.filter(Boolean))]))
    form.set('dryRun', String(dryRun))
    return this.request('DisconnectOrphans', {}, { method: 'POST', form, platform })
  }

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const release = await tradeOpGate.acquire(id, perAccountTradeConcurrency())
    try {
      const params: Record<string, string | number> = {
        symbol: args.symbol,
        operation: args.operation,
        volume: args.volume,
      }
      if (args.price != null && args.price > 0) params.price = args.price
      if (args.stoploss != null && args.stoploss !== 0) params.stoploss = args.stoploss
      if (args.takeprofit != null && args.takeprofit !== 0) params.takeprofit = args.takeprofit
      if (args.slippage != null) params.slippage = args.slippage
      if (args.comment) params.comment = args.comment

      // Never resend an orderSend on a client timeout: the terminal may have
      // accepted it, and MT5 OrderSendSafe idempotency is not proven. Throttle
      // retry is opt-in (`MTAPI_ORDER_THROTTLE_RETRY=true`) until it is.
      const orderThrottleRetry = env('MTAPI_ORDER_THROTTLE_RETRY') === 'true' ? 'pre_accept' : 'off'
      const raw = await this.requestWithRetry('OrderSendSafe', params, id, false, orderThrottleRetry)
      return normalizeOrderResponse(raw, { platform: this.platform(id), operation: args.operation })
    } finally {
      release()
    }
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const release = await tradeOpGate.acquire(id, perAccountTradeConcurrency())
    try {
      const params: Record<string, string | number> = {
        ticket: args.ticket,
      }
      if (args.stoploss != null) params.stoploss = args.stoploss
      if (args.takeprofit != null) params.takeprofit = args.takeprofit
      if (args.price != null) params.price = args.price

      const raw = await this.requestWithRetry('OrderModifySafe', params, id)
      return normalizeOrderResponse(raw, { platform: this.platform(id) })
    } finally {
      release()
    }
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const release = await tradeOpGate.acquire(id, perAccountTradeConcurrency())
    try {
      const params: Record<string, string | number> = {
        ticket: args.ticket,
      }
      if (args.lots != null && args.lots > 0) params.lots = args.lots
      if (args.price != null && args.price > 0) params.price = args.price
      if (args.slippage != null) params.slippage = args.slippage

      // A partial close must not be resent on a timeout (it could over-close);
      // a full close is idempotent (an already-closed ticket is "not found").
      const fullClose = args.lots == null || args.lots <= 0
      const raw = await this.requestWithRetry('OrderCloseSafe', params, id, fullClose)
      const result = normalizeOrderResponse(raw, { platform: this.platform(id) })
      auditOrderClose({
        source: 'mtapi',
        accountId: id,
        ticket: args.ticket,
        volume: args.lots,
        slippage: args.slippage,
        ok: true,
        message: result.state ?? null,
      })
      return result
    } catch (err) {
      auditOrderClose({
        source: 'mtapi',
        accountId: id,
        ticket: args.ticket,
        volume: args.lots,
        slippage: args.slippage,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      release()
    }
  }

  private async requestWithRetry(
    endpoint: string,
    params: Record<string, string | number>,
    sessionId: string,
    allowTimeoutRetry = true,
    // 'pre_accept' restricts throttle retries to the pre-accept 429 signature
    // (`code=rate_limited`); 'any' also retries a bare 429; 'off' never retries
    // a throttle. OrderSend uses 'off' by default because its idempotency is not
    // proven (see MTAPI_ORDER_THROTTLE_RETRY); idempotent calls use 'any'.
    throttleRetry: 'any' | 'pre_accept' | 'off' = 'any',
  ): Promise<unknown> {
    const MAX_ATTEMPTS = Math.max(1, Number(process.env.MT_ORDERSEND_MAX_ATTEMPTS ?? 3) || 3)
    const rawThrottleBase = (process.env.MT_RATE_LIMIT_BACKOFF_MS ?? '').trim()
    const configuredThrottleBase = rawThrottleBase === '' ? Number.NaN : Number(rawThrottleBase)
    const throttleBaseMs = Number.isFinite(configuredThrottleBase) && configuredThrottleBase >= 0
      ? configuredThrottleBase
      : 1_000
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        // Order operations get the longer order timeout and the priority lane,
        // so background reads never delay them.
        return await this.request(endpoint, params, {
          sessionId,
          timeoutMs: this.orderTimeoutMs,
          priority: 'order',
        })
      } catch (error) {
        lastErr = error
        if (isSessionGone(error)) {
          await this.ensureConnected(sessionId)
          continue
        }
        const msg = error instanceof Error ? error.message : String(error)
        // A 429 / `rate_limited` is a clean pre-accept rejection: the bridge (or
        // the broker) refused the request before executing it, so retrying an
        // order send cannot duplicate a fill. It is safe and expected to retry
        // with a longer, jittered backoff — unlike a timeout, which may have
        // reached the terminal (gated by allowTimeoutRetry).
        const preAcceptThrottle = error instanceof MtapiApiError && error.code === 'rate_limited'
        const throttled = throttleRetry !== 'off'
          && (preAcceptThrottle
            || (throttleRetry === 'any'
              && (isApiThrottleError(error)
                || (error instanceof MtapiApiError && error.status === 429))))
        const retryable = isTransientMtApiError(error)
          || throttled
          || (allowTimeoutRetry && isOrderOpTimedOutMessage(msg))
        if (!retryable || attempt >= MAX_ATTEMPTS - 1) throw error
        const jitterMs = throttled
          ? throttleBaseMs * (1 + Math.random() * 1.5) + attempt * 750
          : 600 + Math.random() * 900 + attempt * 400
        console.warn(
          `[mtapiProvider] ${endpoint} retry id=${sessionId} attempt=${attempt + 1}/${MAX_ATTEMPTS}: ${msg}`,
        )
        await new Promise(r => setTimeout(r, jitterMs))
      }
    }
    throw lastErr instanceof Error ? lastErr : new MtapiApiError(String(lastErr), 502)
  }

  async openedOrders(id: string): Promise<unknown[]> {
    const raw = await this.readRequest('OpenedOrders', {}, id)
    if (orderListResponseIsIncomplete(raw)) {
      throw new MtapiApiError('OpenedOrders returned an incomplete response', 502, 'INCOMPLETE_RESPONSE')
    }
    return list(raw, ['orders', 'Orders'], 'OpenedOrders')
  }

  async closedOrders(id: string): Promise<unknown[]> {
    const raw = await this.readRequest('ClosedOrders', {}, id)
    return list(raw, ['orders', 'Orders'], 'ClosedOrders')
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.readRequest('OrderHistory', { from, to }, id)
    return list(raw, ['orders', 'Orders'], 'OrderHistory')
  }

  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    const raw = await this.readRequest('HistoryPositions', { from, to }, id)
    return list(raw, ['positions', 'Positions', 'orders', 'Orders'], 'HistoryPositions')
  }

  async orderHistoryPage(
    id: string,
    from: string,
    to: string,
    pageNumber: number,
    ordersPerPage = 500,
  ): Promise<{ orders: unknown[]; pagesCount: number }> {
    const raw = await this.readRequest(
      'OrderHistoryPagination',
      // ascending pinned so newest-window selection never depends on the
      // bridge default (matches the edge's orderHistory pagination).
      { from, to, pageNumber, ordersPerPage, ascending: true },
      id,
    )
    const row = object(raw)
    return {
      orders: list(raw, ['orders', 'Orders'], 'OrderHistoryPagination'),
      pagesCount: Math.max(
        1,
        numberValue(row.pagesCount ?? row.PagesCount ?? row.totalPages) ?? 1,
      ),
    }
  }

  async closedOrdersHistory(
    id: string,
    from: string,
    to: string,
    profile: MtHistoryProfile = 'dashboard',
  ): Promise<unknown[]> {
    const byKey = new Map<string, Record<string, unknown>>()
    const results = await Promise.allSettled([
      this.closedOrders(id),
      this.historyPositions(id, from, to),
      this.orderHistory(id, from, to),
    ])
    for (const result of results) {
      if (result.status === 'fulfilled') ingestMtHistoryRows(byKey, result.value, profile)
    }
    if (results.every(result => result.status === 'rejected')) {
      throw (results[0] as PromiseRejectedResult).reason
    }
    return [...byKey.values()]
  }

  async closedOrdersHistoryLite(
    id: string,
    from: string,
    to: string,
    profile: MtHistoryProfile = 'dashboard',
    maxPages = 2,
    ordersPerPage = 200,
  ): Promise<unknown[]> {
    const byKey = new Map<string, Record<string, unknown>>()
    let successfulRead = false
    try {
      ingestMtHistoryRows(byKey, await this.closedOrders(id), profile)
      successfulRead = true
    } catch (err) {
      console.warn(`[mtapiProvider] closedOrders failed for ${id}: ${err instanceof Error ? err.message : err}`)
    }
    try {
      const first = await this.orderHistoryPage(id, from, to, 0, ordersPerPage)
      successfulRead = true
      const start = Math.max(0, first.pagesCount - maxPages)
      for (let page = start; page < first.pagesCount; page += 1) {
        const current = page === 0
          ? first
          : await this.orderHistoryPage(id, from, to, page, ordersPerPage)
        ingestMtHistoryRows(byKey, current.orders, profile)
      }
    } catch (err) {
      console.warn(`[mtapiProvider] orderHistoryPage failed for ${id}: ${err instanceof Error ? err.message : err}`)
    }
    if (!successfulRead) {
      throw new MtapiApiError('MTAPI history reads failed', 502, 'HISTORY_READ_FAILED')
    }
    return [...byKey.values()]
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const row = object(await this.readRequest('AccountSummary', {}, id))
    if (Object.keys(row).length === 0) {
      throw new MtapiApiError('AccountSummary returned an invalid response', 502, 'INVALID_RESPONSE')
    }
    return {
      balance: numberValue(row.balance ?? row.Balance),
      credit: numberValue(row.credit ?? row.Credit),
      profit: numberValue(row.profit ?? row.Profit),
      equity: numberValue(row.equity ?? row.Equity),
      margin: numberValue(row.margin ?? row.Margin),
      freeMargin: numberValue(row.freeMargin ?? row.FreeMargin),
      marginLevel: numberValue(row.marginLevel ?? row.MarginLevel),
      leverage: numberValue(row.leverage ?? row.Leverage),
      currency: row.currency == null ? undefined : String(row.currency),
      type: tradeModeValue(row.type ?? row.Type ?? row.tradeMode ?? row.TradeMode),
      synced: boolValue(row.synced ?? row.Synced),
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const endpoint = this.platform(id) === 'MT4' ? 'Quote' : 'GetQuote'
    const row = object(await this.readRequest(endpoint, { symbol }, id))
    const bid = numberValue(row.bid ?? row.Bid)
    const ask = numberValue(row.ask ?? row.Ask)
    if (bid == null || ask == null || bid <= 0 || ask <= 0) {
      throw new MtapiApiError(endpoint + ' returned invalid prices', 502, 'INVALID_RESPONSE')
    }
    return {
      symbol: String(row.symbol ?? row.Symbol ?? symbol),
      bid,
      ask,
      time: row.time == null ? undefined : String(row.time),
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const raw = await this.readRequest('Symbols', {}, id)
    if (Array.isArray(raw)) return raw
    const row = object(raw)
    if (Object.keys(row).length === 0) return []
    return Object.entries(row).map(([symbol, value]) => ({ symbol, ...object(value) }))
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const row = object(await this.readRequest('SymbolParams', { symbol }, id))
    const info = object(row.symbolInfo ?? row.SymbolInfo)
    const group = object(row.symbolGroup ?? row.SymbolGroup)
    if (Object.keys(row).length === 0) {
      throw new MtapiApiError('SymbolParams returned an invalid response', 502, 'INVALID_RESPONSE')
    }
    return {
      ...row,
      symbolName: String(row.symbol ?? row.Symbol ?? symbol),
      symbol: {
        digits: numberValue(info.digits ?? info.Digits),
        point: numberValue(info.points ?? info.point ?? info.Point),
        contractSize: numberValue(info.contractSize ?? info.ContractSize),
        stopsLevel: numberValue(info.stopsLevel ?? info.StopsLevel),
        freezeLevel: numberValue(info.freezeLevel ?? info.FreezeLevel),
      },
      groupParams: {
        minLot: numberValue(group.minLots ?? group.minLot ?? group.MinLots),
        maxLot: numberValue(group.maxLots ?? group.maxLot ?? group.MaxLots),
        lotStep: numberValue(group.lotsStep ?? group.lotStep ?? group.LotsStep),
      },
    }
  }

  async mtStatus(id: string, platformHint?: MtPlatform): Promise<FxsocketMtStatus> {
    if (platformHint) this.seedPlatformCache(id, platformHint)
    const row = object(await this.readRequest('ConnectionStatus', {}, id))
    const connected = boolValue(row.isConnected ?? row.connected)
    return {
      status: connected === true ? 'ready' : 'disconnected',
      serverTime: row.lastQuoteTimeUTC == null ? undefined : String(row.lastQuoteTimeUTC),
      terminal: { alive: connected },
      broker: { connected },
      account: { loggedIn: connected },
      bridge: { tradeEaReady: connected, symbolsSynced: connected },
    }
  }

  async terminalStatus(id: string, platformHint?: MtPlatform): Promise<FxsocketTerminalStatus> {
    const status = await this.mtStatus(id, platformHint)
    return {
      connected: status.broker?.connected,
      loggedIn: status.account?.loggedIn,
      serverTime: status.serverTime,
    }
  }

  async getV1Account(id: string): Promise<{
    id: string; platform: string; status: string; error: string
  }> {
    try {
      const status = await this.mtStatus(id)
      return {
        id,
        platform: this.platform(id),
        status: status.broker?.connected ? 'connected' : 'disconnected',
        error: '',
      }
    } catch (error) {
      return {
        id,
        platform: this.platform(id),
        status: 'error',
        error: error instanceof Error ? error.message : 'MTAPI status failed',
      }
    }
  }
}

let singleton: MtapiProvider | undefined

export function getMtapiProvider(): MtapiProvider {
  if (!singleton) singleton = new MtapiProvider()
  return singleton
}

export function setMtapiProviderForTests(provider: MtapiProvider | undefined): void {
  singleton = provider
}
