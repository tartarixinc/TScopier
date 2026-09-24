import type {
  AccountSummary, FxsocketMtStatus, FxsocketTerminalStatus, MtPlatform,
  OrderCloseArgs, OrderModifyArgs, OrderResult, OrderSendArgs, QuoteResult, SymbolParams,
} from './fxsocketClient'
import { normalizeOrderResponse, isTransientMtApiError, isOrderOpTimedOutMessage } from './fxsocketClient'
import type { BrokerProvider } from './brokerProvider'
import { ingestMtHistoryRows, type MtHistoryProfile } from './mtTradeFields'
import { auditOrderClose } from './orderCloseAudit'
import { createConcurrencyGate } from './perAccountConcurrency'

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
  recoveryHandler?: RecoveryHandler
}

export class MtapiProvider implements BrokerProvider {
  readonly name = 'mtapi' as const
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly platformBySession = new Map<string, MtPlatform>()
  private readonly canonicalSession = new Map<string, string>()
  private recoveryHandler?: RecoveryHandler

  constructor(options: MtapiProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs
      ?? Math.max(1_000, Number(process.env.MTAPI_HTTP_TIMEOUT_MS ?? 20_000))
    this.recoveryHandler = options.recoveryHandler
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
    options: { platform?: MtPlatform; sessionId?: string; method?: 'GET' | 'POST'; form?: FormData } = {},
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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
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
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try { body = JSON.parse(text) } catch { /* caller validates shape */ }
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
    const body = await this.request('ConnectEx', {
      user: args.login, password: args.password, server: args.server,
    }, { platform })
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
    const body = await this.request('Connect', {
      user: args.login, password: args.password, host: args.host, port: args.port,
    }, { platform })
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
    if (typeof body === 'string' && body.trim().toUpperCase() === 'OK') return
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
      const platform = this.platform(id)
      const endpoint = platform === 'MT5' ? 'OrderSendSafe' : 'OrderSend'
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

      const raw = await this.requestWithRetry(endpoint, params, id, platform === 'MT5')
      return normalizeOrderResponse(raw)
    } finally {
      release()
    }
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const release = await tradeOpGate.acquire(id, perAccountTradeConcurrency())
    try {
      const platform = this.platform(id)
      const endpoint = platform === 'MT5' ? 'OrderModifySafe' : 'OrderModify'
      const params: Record<string, string | number> = {
        ticket: args.ticket,
      }
      if (args.stoploss != null) params.stoploss = args.stoploss
      if (args.takeprofit != null) params.takeprofit = args.takeprofit
      if (args.price != null) params.price = args.price

      const raw = await this.requestWithRetry(endpoint, params, id)
      return normalizeOrderResponse(raw)
    } finally {
      release()
    }
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const release = await tradeOpGate.acquire(id, perAccountTradeConcurrency())
    try {
      const platform = this.platform(id)
      const endpoint = platform === 'MT5' ? 'OrderCloseSafe' : 'OrderClose'
      const params: Record<string, string | number> = {
        ticket: args.ticket,
      }
      if (args.lots != null && args.lots > 0) params.volume = args.lots
      if (args.price != null && args.price > 0) params.price = args.price
      if (args.slippage != null) params.slippage = args.slippage

      const raw = await this.requestWithRetry(endpoint, params, id)
      const result = normalizeOrderResponse(raw)
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
  ): Promise<unknown> {
    const MAX_ATTEMPTS = Math.max(1, Number(process.env.MT_ORDERSEND_MAX_ATTEMPTS ?? 3) || 3)
    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await this.request(endpoint, params, { sessionId })
      } catch (error) {
        lastErr = error
        if (isSessionGone(error)) {
          await this.ensureConnected(sessionId)
          continue
        }
        const msg = error instanceof Error ? error.message : String(error)
        const retryable = isTransientMtApiError(error)
          || (allowTimeoutRetry && isOrderOpTimedOutMessage(msg))
        if (!retryable || attempt >= MAX_ATTEMPTS - 1) throw error
        const jitterMs = 600 + Math.random() * 900 + attempt * 400
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
      { from, to, pageNumber, ordersPerPage },
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
    const row = object(await this.readRequest('GetQuote', { symbol }, id))
    const bid = numberValue(row.bid ?? row.Bid)
    const ask = numberValue(row.ask ?? row.Ask)
    if (bid == null || ask == null || bid <= 0 || ask <= 0) {
      throw new MtapiApiError('GetQuote returned invalid prices', 502, 'INVALID_RESPONSE')
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
