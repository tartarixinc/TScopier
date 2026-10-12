import type {
  AccountSummary,
  FxsocketMtStatus,
  FxsocketTerminalStatus,
  MtPlatform,
  OrderCloseArgs,
  OrderModifyArgs,
  OrderResult,
  OrderSendArgs,
  QuoteResult,
  SymbolParams,
} from './fxsocketClient'
import type { MtHistoryProfile } from './mtTradeFields'
import type { BrokerProvider } from './brokerProvider'
import {
  CTRADER_FULL_ACCESS,
  CTRADER_ORDER_TYPE,
  CTRADER_PAYLOAD,
  CTRADER_REJECTED_EXECUTION,
  ctraderErrorMessage,
  ctraderSocketUrl,
  ctraderTokenUrl,
  ctraderVolumeToLots,
  lotsToCtraderVolume,
  mapCtraderOrder,
  moneyFromCents,
  operationFromCtrader,
  priceToRelative,
  readCtraderTokenResponse,
  relativeToPrice,
} from './ctrader/protocol'
import { CtraderSession, openCtraderWebSocket, type CtraderSocket } from './ctrader/session'

export interface CtraderCredential {
  accountId: string
  environment: 'demo' | 'live'
  accessToken: string
  refreshToken: string
  expiresAt: string | null
  clientId: string
  clientSecret: string
}

export interface CtraderProviderOptions {
  openSocket?: (url: string) => Promise<CtraderSocket>
  loadCredentials?: (accountId: string) => Promise<CtraderCredential | null>
  saveCredentials?: (credential: CtraderCredential) => Promise<void>
  fetchImpl?: typeof fetch
  now?: () => number
}

type SymbolInfo = {
  symbolId: number
  name: string
  digits: number
  lotSize: number
  minVolume?: number
  maxVolume?: number
  stepVolume?: number
}

type LiveSession = {
  session: CtraderSession
  symbols: Map<string, SymbolInfo>
  symbolsById: Map<number, SymbolInfo>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord)
  if (value && typeof value === 'object') return [asRecord(value)]
  return []
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return asArray(value)[0]
}

function accountNumber(id: string): number {
  const value = Number(id)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('cTrader account id is invalid')
  }
  return value
}

function finite(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export class CtraderProvider implements BrokerProvider {
  readonly name = 'ctrader' as const
  private readonly sessions = new Map<string, LiveSession>()
  private readonly openSocket: (url: string) => Promise<CtraderSocket>
  private readonly loadCredentials?: (accountId: string) => Promise<CtraderCredential | null>
  private readonly saveCredentials?: (credential: CtraderCredential) => Promise<void>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(options: CtraderProviderOptions = {}) {
    this.openSocket = options.openSocket ?? openCtraderWebSocket
    this.loadCredentials = options.loadCredentials
    this.saveCredentials = options.saveCredentials
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
  }

  seedPlatformCache(_id: string, _platform: MtPlatform | string | null | undefined): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return {
        id,
        platform: 'cTrader',
        status: status.broker?.connected ? 'connected' : 'disconnected',
        error: '',
      }
    } catch (error) {
      return {
        id,
        platform: 'cTrader',
        status: 'error',
        error: error instanceof Error ? error.message : 'cTrader status failed',
      }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('cTrader accounts connect through Open API')
  }

  async connectByToken(id: string): Promise<void> {
    await this.ensureConnected(id)
  }

  async ensureConnected(id: string): Promise<void> {
    await this.live(id)
  }

  async checkConnect(id: string): Promise<void> {
    await this.trader(id)
  }

  async disconnect(id: string): Promise<void> {
    this.sessions.get(id)?.session.close()
    this.sessions.delete(id)
  }

  async keepSessionAlive(id: string): Promise<boolean> {
    try {
      await this.trader(id)
      return true
    } catch {
      return false
    }
  }

  async keepSessionAliveDetailed(id: string): Promise<'alive' | 'session_gone' | 'token_reconnect_failed'> {
    try {
      await this.trader(id)
      return 'alive'
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      return /not configured|account id/i.test(message) ? 'token_reconnect_failed' : 'session_gone'
    }
  }

  async verifyTradingReady(id: string): Promise<boolean> {
    const status = await this.mtStatus(id)
    return status.account?.tradeAllowed === true
  }

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const live = await this.live(id)
    const symbol = await this.symbolInfo(live, id, args.symbol)
    const mapped = mapCtraderOrder(args.operation)
    const volume = lotsToCtraderVolume(args.volume, symbol.lotSize)
    const payload: Record<string, unknown> = {
      ctidTraderAccountId: accountNumber(id),
      symbolId: symbol.symbolId,
      orderType: mapped.orderType,
      tradeSide: mapped.tradeSide,
      volume,
      comment: args.comment ?? '',
    }
    this.writeProtection(payload, symbol.digits, args.stoploss, args.takeprofit)
    if (mapped.orderType === CTRADER_ORDER_TYPE.LIMIT || mapped.orderType === CTRADER_ORDER_TYPE.STOP_LIMIT) {
      payload.limitPrice = this.requirePrice(args.price, symbol.digits)
    }
    if (mapped.orderType === CTRADER_ORDER_TYPE.STOP || mapped.orderType === CTRADER_ORDER_TYPE.STOP_LIMIT) {
      payload.stopPrice = this.requirePrice(args.price, symbol.digits)
    }
    const execution = await live.session.request(
      CTRADER_PAYLOAD.NEW_ORDER_REQ,
      payload,
      [CTRADER_PAYLOAD.EXECUTION_EVENT],
    )
    return this.resultFromExecution(execution, symbol, args.comment)
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const live = await this.live(id)
    const found = await this.findTicket(live, id, args.ticket)
    const digits = found.symbol?.digits ?? 5
    if (found.kind === 'position') {
      const payload: Record<string, unknown> = {
        ctidTraderAccountId: accountNumber(id),
        positionId: args.ticket,
      }
      this.writeProtection(payload, digits, args.stoploss, args.takeprofit)
      const execution = await live.session.request(
        CTRADER_PAYLOAD.AMEND_POSITION_SLTP_REQ,
        payload,
        [CTRADER_PAYLOAD.EXECUTION_EVENT],
      )
      return this.resultFromExecution(execution, found.symbol, undefined, args.ticket)
    }
    const payload: Record<string, unknown> = {
      ctidTraderAccountId: accountNumber(id),
      orderId: args.ticket,
    }
    this.writeProtection(payload, digits, args.stoploss, args.takeprofit)
    if (args.price != null && Number(args.price) > 0) {
      const relative = priceToRelative(Number(args.price), digits)
      payload.limitPrice = relative
      payload.stopPrice = relative
    }
    const execution = await live.session.request(
      CTRADER_PAYLOAD.AMEND_ORDER_REQ,
      payload,
      [CTRADER_PAYLOAD.EXECUTION_EVENT],
    )
    return this.resultFromExecution(execution, found.symbol, undefined, args.ticket)
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const live = await this.live(id)
    const found = await this.findTicket(live, id, args.ticket)
    if (found.kind === 'order') {
      const execution = await live.session.request(
        CTRADER_PAYLOAD.CANCEL_ORDER_REQ,
        { ctidTraderAccountId: accountNumber(id), orderId: args.ticket },
        [CTRADER_PAYLOAD.EXECUTION_EVENT],
      )
      return this.resultFromExecution(execution, found.symbol, undefined, args.ticket)
    }
    const lotSize = found.symbol?.lotSize
    const volume = args.lots != null && args.lots > 0 && lotSize
      ? lotsToCtraderVolume(args.lots, lotSize)
      : found.volume
    if (!volume || volume <= 0) throw new Error('cTrader position volume is missing')
    const execution = await live.session.request(
      CTRADER_PAYLOAD.CLOSE_POSITION_REQ,
      {
        ctidTraderAccountId: accountNumber(id),
        positionId: args.ticket,
        volume,
      },
      [CTRADER_PAYLOAD.EXECUTION_EVENT],
    )
    return this.resultFromExecution(execution, found.symbol, undefined, args.ticket)
  }

  async openedOrders(id: string): Promise<unknown[]> {
    const live = await this.live(id)
    await this.ensureSymbolIndex(live, id)
    const snapshot = await this.reconcile(live, id)
    const rows: unknown[] = []
    for (const position of asArray(snapshot.position)) {
      rows.push(this.positionRow(live, position))
    }
    for (const order of asArray(snapshot.order)) {
      rows.push(this.pendingRow(live, order))
    }
    return rows
  }

  async closedOrders(id: string): Promise<unknown[]> {
    const to = new Date()
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
    return this.orderHistory(id, from.toISOString(), to.toISOString())
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const live = await this.live(id)
    await this.ensureSymbolIndex(live, id)
    const payload = await live.session.request(
      CTRADER_PAYLOAD.DEAL_LIST_REQ,
      {
        ctidTraderAccountId: accountNumber(id),
        fromTimestamp: Date.parse(from),
        toTimestamp: Date.parse(to),
      },
      [CTRADER_PAYLOAD.DEAL_LIST_RES],
    )
    return asArray(payload.deal).map(deal => this.dealRow(live, deal))
  }

  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    return this.orderHistory(id, from, to)
  }

  async orderHistoryPage(
    id: string,
    from: string,
    to: string,
    _pageNumber: number,
  ): Promise<{ orders: unknown[]; pagesCount: number }> {
    const orders = await this.orderHistory(id, from, to)
    return { orders, pagesCount: 1 }
  }

  async closedOrdersHistory(
    id: string,
    from: string,
    to: string,
    _profile?: MtHistoryProfile,
  ): Promise<unknown[]> {
    return this.orderHistory(id, from, to)
  }

  async closedOrdersHistoryLite(
    id: string,
    from: string,
    to: string,
    profile?: MtHistoryProfile,
  ): Promise<unknown[]> {
    return this.closedOrdersHistory(id, from, to, profile)
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const trader = await this.trader(id)
    const balance = moneyFromCents(trader.balance)
    const equity = moneyFromCents(trader.equity) ?? balance
    const leverage = finite(trader.leverageInCents)
    return {
      balance,
      equity,
      profit: moneyFromCents(trader.unrealizedGrossProfit),
      margin: moneyFromCents(trader.usedMargin),
      freeMargin: moneyFromCents(trader.freeMargin),
      leverage: leverage == null ? undefined : leverage / 100,
      currency: trader.depositCurrency == null ? undefined : String(trader.depositCurrency),
      synced: true,
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const live = await this.live(id)
    const info = await this.symbolInfo(live, id, symbol)
    const spot = await live.session.request(
      CTRADER_PAYLOAD.SUBSCRIBE_SPOTS_REQ,
      { ctidTraderAccountId: accountNumber(id), symbolId: [info.symbolId] },
      [CTRADER_PAYLOAD.SPOT_EVENT],
    )
    const bid = finite(spot.bid)
    const ask = finite(spot.ask)
    if (bid == null || ask == null) throw new Error('cTrader quote is missing prices')
    return {
      symbol: info.name,
      bid: relativeToPrice(bid, info.digits),
      ask: relativeToPrice(ask, info.digits),
    }
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const live = await this.live(id)
    const info = await this.symbolInfo(live, id, symbol)
    const point = info.digits > 0 ? 1 / 10 ** info.digits : undefined
    return {
      symbolName: info.name,
      symbol: {
        digits: info.digits,
        point,
        contractSize: info.lotSize > 0 ? info.lotSize / 100 : undefined,
      },
      groupParams: {
        minLot: info.minVolume && info.lotSize ? info.minVolume / info.lotSize : undefined,
        maxLot: info.maxVolume && info.lotSize ? info.maxVolume / info.lotSize : undefined,
        lotStep: info.stepVolume && info.lotSize ? info.stepVolume / info.lotSize : undefined,
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const live = await this.live(id)
    await this.ensureSymbolIndex(live, id)
    return [...live.symbols.values()].map(symbol => symbol.name)
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const trader = await this.trader(id)
    const access = finite(trader.accessRights)
    const tradeAllowed = access == null || access === CTRADER_FULL_ACCESS
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true },
      account: {
        loggedIn: true,
        tradeAllowed,
        login: finite(trader.traderLogin),
        currency: trader.depositCurrency == null ? undefined : String(trader.depositCurrency),
      },
      bridge: { tradeEaReady: true, symbolsSynced: true },
    }
  }

  async terminalStatus(id: string): Promise<FxsocketTerminalStatus> {
    const status = await this.mtStatus(id)
    return {
      connected: status.broker?.connected,
      tradeAllowed: status.account?.tradeAllowed,
      loggedIn: status.account?.loggedIn,
    }
  }

  private async live(id: string): Promise<LiveSession> {
    const existing = this.sessions.get(id)
    if (existing) return existing
    const credential = await this.credential(id)
    const socket = await this.openSocket(ctraderSocketUrl(credential.environment))
    const session = new CtraderSession(socket)
    const live: LiveSession = { session, symbols: new Map(), symbolsById: new Map() }
    try {
      await session.request(
        CTRADER_PAYLOAD.APPLICATION_AUTH_REQ,
        { clientId: credential.clientId, clientSecret: credential.clientSecret },
        [CTRADER_PAYLOAD.APPLICATION_AUTH_RES],
      )
      await session.request(
        CTRADER_PAYLOAD.ACCOUNT_AUTH_REQ,
        { ctidTraderAccountId: accountNumber(id), accessToken: credential.accessToken },
        [CTRADER_PAYLOAD.ACCOUNT_AUTH_RES],
      )
    } catch (error) {
      session.close()
      throw error
    }
    this.sessions.set(id, live)
    return live
  }

  private async credential(id: string): Promise<CtraderCredential> {
    if (!this.loadCredentials) throw new Error('cTrader is not configured')
    const loaded = await this.loadCredentials(id)
    if (!loaded?.accessToken || !loaded.clientId || !loaded.clientSecret) {
      throw new Error('cTrader is not configured')
    }
    return this.refreshIfNeeded(loaded)
  }

  private async refreshIfNeeded(credential: CtraderCredential): Promise<CtraderCredential> {
    const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN
    if (!credential.refreshToken || !Number.isFinite(expiresAt) || expiresAt - this.now() > 60_000) {
      return credential
    }
    const response = await this.fetchImpl(ctraderTokenUrl({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
    }))
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(ctraderErrorMessage(body) || 'cTrader token refresh failed')
    const token = readCtraderTokenResponse(body)
    const next: CtraderCredential = {
      ...credential,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken || credential.refreshToken,
      expiresAt: token.expiresIn > 0
        ? new Date(this.now() + token.expiresIn * 1000).toISOString()
        : credential.expiresAt,
    }
    await this.saveCredentials?.(next)
    return next
  }

  private async trader(id: string): Promise<Record<string, unknown>> {
    const live = await this.live(id)
    const payload = await live.session.request(
      CTRADER_PAYLOAD.TRADER_REQ,
      { ctidTraderAccountId: accountNumber(id) },
      [CTRADER_PAYLOAD.TRADER_RES],
    )
    return asRecord(payload.trader)
  }

  private async reconcile(live: LiveSession, id: string): Promise<Record<string, unknown>> {
    return live.session.request(
      CTRADER_PAYLOAD.RECONCILE_REQ,
      { ctidTraderAccountId: accountNumber(id) },
      [CTRADER_PAYLOAD.RECONCILE_RES],
    )
  }

  private async ensureSymbolIndex(live: LiveSession, id: string): Promise<void> {
    if (live.symbols.size > 0) return
    const payload = await live.session.request(
      CTRADER_PAYLOAD.SYMBOLS_LIST_REQ,
      { ctidTraderAccountId: accountNumber(id) },
      [CTRADER_PAYLOAD.SYMBOLS_LIST_RES],
    )
    for (const row of asArray(payload.symbol ?? payload.symbols)) {
      const info = this.readSymbol(row)
      if (!info) continue
      live.symbols.set(info.name.toUpperCase(), info)
      live.symbolsById.set(info.symbolId, info)
    }
  }

  private async symbolInfo(live: LiveSession, id: string, name: string): Promise<SymbolInfo> {
    const key = name.trim().toUpperCase()
    const cached = live.symbols.get(key)
    if (cached?.lotSize) return cached
    await this.ensureSymbolIndex(live, id)
    const listed = live.symbols.get(key)
    if (!listed) throw new Error(`Symbol ${name} is not on this cTrader account`)
    if (listed.lotSize) return listed
    const payload = await live.session.request(
      CTRADER_PAYLOAD.SYMBOL_BY_ID_REQ,
      { ctidTraderAccountId: accountNumber(id), symbolId: [listed.symbolId] },
      [CTRADER_PAYLOAD.SYMBOL_BY_ID_RES],
    )
    // The full symbol carries lotSize and digits. It does not repeat symbolName.
    const detailed = this.readSymbol(firstRecord(payload.symbol ?? payload.symbols), listed)
    const info = detailed ?? listed
    live.symbols.set(key, info)
    live.symbolsById.set(info.symbolId, info)
    return info
  }

  private readSymbol(
    row: Record<string, unknown> | undefined,
    fallback?: SymbolInfo,
  ): SymbolInfo | null {
    if (!row) return null
    const symbolId = finite(row.symbolId) ?? fallback?.symbolId
    const name = String(row.symbolName ?? row.name ?? fallback?.name ?? '').trim()
    if (symbolId == null || !name) return null
    return {
      symbolId,
      name,
      digits: finite(row.digits) ?? fallback?.digits ?? 5,
      lotSize: finite(row.lotSize ?? row.lot_size) ?? fallback?.lotSize ?? 0,
      minVolume: finite(row.minVolume ?? row.min_volume) ?? fallback?.minVolume,
      maxVolume: finite(row.maxVolume ?? row.max_volume) ?? fallback?.maxVolume,
      stepVolume: finite(row.stepVolume ?? row.step_volume) ?? fallback?.stepVolume,
    }
  }

  private async findTicket(live: LiveSession, id: string, ticket: number): Promise<{
    kind: 'position' | 'order'
    volume?: number
    symbol?: SymbolInfo
  }> {
    await this.ensureSymbolIndex(live, id)
    const snapshot = await this.reconcile(live, id)
    for (const position of asArray(snapshot.position)) {
      if (finite(position.positionId) !== ticket) continue
      const trade = asRecord(position.tradeData)
      return {
        kind: 'position',
        volume: finite(trade.volume ?? position.volume),
        symbol: live.symbolsById.get(finite(trade.symbolId) ?? -1),
      }
    }
    for (const order of asArray(snapshot.order)) {
      if (finite(order.orderId) !== ticket) continue
      const trade = asRecord(order.tradeData)
      return {
        kind: 'order',
        volume: finite(trade.volume ?? order.volume),
        symbol: live.symbolsById.get(finite(trade.symbolId) ?? -1),
      }
    }
    throw new Error(`cTrader order ${ticket} was not found`)
  }

  private writeProtection(
    payload: Record<string, unknown>,
    digits: number,
    stopLoss: number | null | undefined,
    takeProfit: number | null | undefined,
  ): void {
    if (stopLoss != null && Number(stopLoss) > 0) payload.stopLoss = priceToRelative(Number(stopLoss), digits)
    if (takeProfit != null && Number(takeProfit) > 0) payload.takeProfit = priceToRelative(Number(takeProfit), digits)
  }

  private requirePrice(price: number | null | undefined, digits: number): number {
    if (price == null || !Number.isFinite(Number(price)) || Number(price) <= 0) {
      throw new Error('cTrader pending order is missing a price')
    }
    return priceToRelative(Number(price), digits)
  }

  private resultFromExecution(
    payload: Record<string, unknown>,
    symbol: SymbolInfo | undefined,
    comment: string | undefined,
    fallbackTicket?: number,
  ): OrderResult {
    const executionType = finite(payload.executionType)
    if (executionType != null && CTRADER_REJECTED_EXECUTION.has(executionType)) {
      throw new Error(ctraderErrorMessage(payload))
    }
    const position = asRecord(payload.position)
    const order = asRecord(payload.order)
    const trade = asRecord(position.tradeData ?? order.tradeData)
    const digits = symbol?.digits ?? 5
    const lotSize = symbol?.lotSize ?? 0
    const ticket = finite(position.positionId ?? order.orderId) ?? fallbackTicket ?? 0
    if (!ticket) throw new Error('cTrader did not return an order id')
    const volume = finite(trade.volume)
    const openPrice = finite(position.price ?? order.executionPrice ?? order.limitPrice)
    const stopLoss = finite(position.stopLoss ?? order.stopLoss)
    const takeProfit = finite(position.takeProfit ?? order.takeProfit)
    return {
      ticket,
      positionTicket: finite(position.positionId),
      orderTicket: finite(order.orderId),
      openPrice: openPrice == null ? undefined : relativeToPrice(openPrice, digits),
      stopLoss: stopLoss == null ? undefined : relativeToPrice(stopLoss, digits),
      takeProfit: takeProfit == null ? undefined : relativeToPrice(takeProfit, digits),
      lots: volume == null ? undefined : ctraderVolumeToLots(volume, lotSize),
      symbol: symbol?.name,
      comment: trade.comment == null ? comment : String(trade.comment),
    }
  }

  private positionRow(live: LiveSession, position: Record<string, unknown>): Record<string, unknown> {
    const trade = asRecord(position.tradeData)
    const symbol = live.symbolsById.get(finite(trade.symbolId) ?? -1)
    const digits = symbol?.digits ?? 5
    const ticket = finite(position.positionId) ?? 0
    const volume = finite(trade.volume) ?? 0
    const openPrice = finite(position.price)
    const stopLoss = finite(position.stopLoss)
    const takeProfit = finite(position.takeProfit)
    return {
      ticket,
      positionTicket: ticket,
      symbol: symbol?.name ?? '',
      operation: operationFromCtrader(CTRADER_ORDER_TYPE.MARKET, finite(trade.tradeSide) ?? 1),
      lots: ctraderVolumeToLots(volume, symbol?.lotSize ?? 0),
      volume: ctraderVolumeToLots(volume, symbol?.lotSize ?? 0),
      openPrice: openPrice == null ? undefined : relativeToPrice(openPrice, digits),
      stopLoss: stopLoss == null ? undefined : relativeToPrice(stopLoss, digits),
      takeProfit: takeProfit == null ? undefined : relativeToPrice(takeProfit, digits),
      comment: trade.comment == null ? '' : String(trade.comment),
    }
  }

  private pendingRow(live: LiveSession, order: Record<string, unknown>): Record<string, unknown> {
    const trade = asRecord(order.tradeData)
    const symbol = live.symbolsById.get(finite(trade.symbolId) ?? -1)
    const digits = symbol?.digits ?? 5
    const ticket = finite(order.orderId) ?? 0
    const volume = finite(trade.volume) ?? 0
    const price = finite(order.limitPrice ?? order.stopPrice)
    return {
      ticket,
      orderTicket: ticket,
      symbol: symbol?.name ?? '',
      operation: operationFromCtrader(finite(order.orderType) ?? CTRADER_ORDER_TYPE.LIMIT, finite(trade.tradeSide) ?? 1),
      lots: ctraderVolumeToLots(volume, symbol?.lotSize ?? 0),
      volume: ctraderVolumeToLots(volume, symbol?.lotSize ?? 0),
      openPrice: price == null ? undefined : relativeToPrice(price, digits),
      comment: trade.comment == null ? '' : String(trade.comment),
      state: 'Placed',
    }
  }

  private dealRow(live: LiveSession, deal: Record<string, unknown>): Record<string, unknown> {
    const symbol = live.symbolsById.get(finite(deal.symbolId) ?? -1)
    const close = asRecord(deal.closePositionDetail)
    const volume = finite(deal.filledVolume ?? deal.volume) ?? 0
    const price = finite(deal.executionPrice)
    return {
      ticket: finite(deal.positionId ?? deal.dealId) ?? 0,
      positionTicket: finite(deal.positionId),
      dealTicket: finite(deal.dealId),
      symbol: symbol?.name ?? '',
      operation: operationFromCtrader(CTRADER_ORDER_TYPE.MARKET, finite(deal.tradeSide) ?? 1),
      lots: ctraderVolumeToLots(volume, symbol?.lotSize ?? 0),
      openPrice: price == null ? undefined : relativeToPrice(price, symbol?.digits ?? 5),
      profit: moneyFromCents(close.grossProfit),
      swap: moneyFromCents(close.swap),
      commission: moneyFromCents(close.commission),
      comment: deal.comment == null ? '' : String(deal.comment),
    }
  }
}

export function createCtraderProvider(options?: CtraderProviderOptions): CtraderProvider {
  return new CtraderProvider(options)
}

let singleton: CtraderProvider | undefined

export function getCtraderProvider(): CtraderProvider {
  if (!singleton) {
    singleton = new CtraderProvider({
      loadCredentials: async accountId => {
        const { loadCtraderCredential } = await import('./ctrader/credentials')
        return loadCtraderCredential(accountId)
      },
      saveCredentials: async credential => {
        const { saveCtraderCredential } = await import('./ctrader/credentials')
        await saveCtraderCredential(credential)
      },
    })
  }
  return singleton
}
