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
import type { BrokerAccountMode } from './copyShared/brokerAccountMode'
import { noteObservedClose, observedCloseRows, type ObservedClose } from './copyShared/observedCloses'
import {
  BinanceApiError,
  BinanceFuturesClient,
  type BinanceEnvironment,
  type BinanceFuturesCredential,
} from './binance/futuresClient'
import {
  BinanceSizingError,
  copierClientOrderId,
  formatPrice,
  formatQuantity,
  parseExchangeInfo,
  resolveBinanceSymbol,
  sizeBinancePosition,
  type BinanceSymbolRules,
} from './binance/symbols'

export type { BinanceFuturesCredential } from './binance/futuresClient'

export interface BinanceProviderOptions {
  loadCredentials?: (accountId: string) => Promise<BinanceFuturesCredential | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type Side = 'BUY' | 'SELL'

type Leg = {
  ticket: number
  kind: 'position' | 'pending'
  symbol: string
  side: Side
  positionSide: 'LONG' | 'SHORT' | 'BOTH'
  qty: number
  entryPrice: number
  comment: string
  stopLoss?: number
  takeProfit?: number
  slAlgoId?: number
  tpAlgoId?: number
  openedAt: number
}

type PositionRow = {
  symbol: string
  positionSide: string
  amount: number
  entryPrice: number
  markPrice: number
}

type AccountState = {
  accountId: string
  credential: BinanceFuturesCredential
  loadedAt: number
  client: BinanceFuturesClient
  legs: Map<number, Leg>
  /** Positions watched disappearing from the book — see `noteClosedPosition`. */
  closed: ObservedClose[]
  hydrated: boolean
  applied: Set<string>
  hedge?: { value: boolean; at: number }
}

const CREDENTIAL_TTL_MS = 30_000
const EXCHANGE_INFO_TTL_MS = 10 * 60_000
const HEDGE_TTL_MS = 60_000
const SL_PREFIX = 'TSL'
const TP_PREFIX = 'TST'
const CLOSE_PREFIX = 'TSX'
const BENIGN_MARGIN_CODES = new Set([-4046, -4047, -4048, -4067, -4168])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function finite(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function positive(value: number | undefined): number | undefined {
  return value != null && value > 0 ? value : undefined
}

function nonce(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

function isCopierClientId(value: unknown): boolean {
  return /^TS[Cc]opier/.test(String(value ?? ''))
}

function sideOf(operation: string): Side {
  return /^Buy/i.test(operation) ? 'BUY' : 'SELL'
}

function operationOf(leg: Pick<Leg, 'side' | 'kind'>): string {
  if (leg.kind === 'pending') return leg.side === 'BUY' ? 'BuyLimit' : 'SellLimit'
  return leg.side === 'BUY' ? 'Buy' : 'Sell'
}

function ticketFromClientId(value: unknown): number | null {
  const parts = String(value ?? '').split(':')
  if (parts.length < 2) return null
  const n = Number(parts[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export class BinanceProvider implements BrokerProvider {
  readonly name = 'binance' as const
  private readonly states = new Map<string, AccountState>()
  private readonly exchangeInfo = new Map<BinanceEnvironment, { at: number; rules: Map<string, BinanceSymbolRules> }>()
  private readonly loadCredentials?: (accountId: string) => Promise<BinanceFuturesCredential | null>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: BinanceProviderOptions = {}) {
    this.loadCredentials = options.loadCredentials
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  seedPlatformCache(_id: string, _platform: MtPlatform | string | null | undefined): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return { id, platform: 'Binance', status: status.broker?.connected ? 'connected' : 'disconnected', error: '' }
    } catch (error) {
      return {
        id,
        platform: 'Binance',
        status: 'error',
        error: error instanceof Error ? error.message : 'Binance status failed',
      }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('Binance accounts connect with an API key')
  }

  async connectByToken(id: string): Promise<void> {
    await this.state(id)
  }

  async ensureConnected(id: string): Promise<void> {
    await this.state(id)
  }

  async checkConnect(id: string): Promise<void> {
    await this.account(id)
  }

  async disconnect(id: string): Promise<void> {
    this.states.delete(id)
  }

  async keepSessionAlive(id: string): Promise<boolean> {
    try {
      await this.account(id)
      return true
    } catch {
      return false
    }
  }

  async keepSessionAliveDetailed(id: string): Promise<'alive' | 'session_gone' | 'token_reconnect_failed'> {
    try {
      await this.account(id)
      return 'alive'
    } catch (error) {
      if (error instanceof BinanceApiError && (error.status === 401 || error.code === -2015 || error.code === -2014 || error.code === -1022)) {
        return 'token_reconnect_failed'
      }
      const message = error instanceof Error ? error.message : ''
      return /not configured|could not be read/i.test(message) ? 'token_reconnect_failed' : 'session_gone'
    }
  }

  async verifyTradingReady(id: string): Promise<boolean> {
    const status = await this.mtStatus(id)
    return status.account?.tradeAllowed === true
  }

  /**
   * Account-wide dual-side position mode: hedge mode gives each side its own
   * position, one-way merges them. Read here instead of through `hedgeMode`
   * so a failed call surfaces as unknown (no mode) rather than being reported
   * as one-way and persisted as the wrong answer.
   */
  async accountMode(id: string): Promise<BrokerAccountMode | null> {
    const st = await this.state(id)
    const body = asRecord(await st.client.signed('GET', '/fapi/v1/positionSide/dual'))
    const raw = body.dualSidePosition
    if (raw === true || raw === 'true') return 'hedging'
    if (raw === false || raw === 'false') return 'netting'
    return null
  }
  /**
   * The exchange's own answer, read straight from the position list rather than
   * from the copier's leg book (which can miss a leg after a restart). A failed
   * read returns null so the caller keeps the copy open instead of guessing.
   */
  async stillHoldsPosition(id: string, symbol: string, side: 'buy' | 'sell'): Promise<boolean | null> {
    try {
      // `state()` is inside the try as well: a missing or unreadable credential is
      // just another "cannot answer", which the contract says returns null.
      const st = await this.state(id)
      const positions = await this.positions(st)
      return this.netFor(positions, symbol, side === 'buy' ? 'BUY' : 'SELL') > 0
    } catch {
      return null
    }
  }


  // ── Orders ──────────────────────────────────────────────────────────────

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const rules = await this.symbolRules(st, args.symbol)
    const side = sideOf(args.operation)
    const market = args.operation === 'Buy' || args.operation === 'Sell'
    const limit = args.operation === 'BuyLimit' || args.operation === 'SellLimit'
    if (!market && !limit) throw new Error(`Binance futures does not support ${args.operation} orders`)

    let referencePrice: number
    if (limit) {
      referencePrice = Number(args.price)
      if (!(referencePrice > 0)) throw new Error('Binance limit order is missing a price')
    } else {
      const book = await this.book(st, rules.symbol)
      referencePrice = side === 'BUY' ? book.ask : book.bid
    }

    let quantity: number
    try {
      quantity = sizeBinancePosition({
        marginUsdt: st.credential.marginUsdt,
        leverage: st.credential.leverage,
        price: referencePrice,
        rules,
      })
    } catch (error) {
      if (error instanceof BinanceSizingError) throw new Error(error.message)
      throw error
    }

    await this.prepareSymbol(st, rules.symbol)
    const hedge = await this.hedgeMode(st)
    const positionSide = hedge ? (side === 'BUY' ? 'LONG' : 'SHORT') : undefined
    const clientId = copierClientOrderId(args.comment, nonce())
    const placed = asRecord(await st.client.signed('POST', '/fapi/v1/order', {
      symbol: rules.symbol,
      side,
      type: market ? 'MARKET' : 'LIMIT',
      quantity: formatQuantity(quantity, rules),
      price: limit ? formatPrice(referencePrice, rules) : undefined,
      timeInForce: limit ? 'GTC' : undefined,
      positionSide,
      newClientOrderId: clientId,
      newOrderRespType: 'RESULT',
    }))
    const ticket = finite(placed.orderId)
    if (!ticket) throw new Error('Binance did not return an order id')

    if (limit) {
      st.legs.set(ticket, {
        ticket,
        kind: 'pending',
        symbol: rules.symbol,
        side,
        positionSide: positionSide ?? 'BOTH',
        qty: quantity,
        entryPrice: referencePrice,
        comment: clientId,
        openedAt: this.now(),
      })
      return {
        ticket,
        orderTicket: ticket,
        openPrice: referencePrice,
        lots: quantity,
        symbol: rules.symbol,
        state: 'Placed',
        comment: clientId,
      }
    }

    const filled = await this.fillOf(st, rules.symbol, ticket, placed)
    const leg: Leg = {
      ticket,
      kind: 'position',
      symbol: rules.symbol,
      side,
      positionSide: positionSide ?? 'BOTH',
      qty: filled.qty > 0 ? filled.qty : quantity,
      entryPrice: filled.price > 0 ? filled.price : referencePrice,
      comment: clientId,
      openedAt: this.now(),
    }
    st.legs.set(ticket, leg)

    const stopLoss = positive(finite(args.stoploss))
    const takeProfit = positive(finite(args.takeprofit))
    if (stopLoss != null || takeProfit != null) {
      await this.protect(st, leg, rules, hedge, stopLoss, takeProfit, true)
    }
    return {
      ticket,
      positionTicket: ticket,
      orderTicket: ticket,
      openPrice: leg.entryPrice,
      stopLoss: leg.stopLoss,
      takeProfit: leg.takeProfit,
      lots: leg.qty,
      symbol: rules.symbol,
      comment: clientId,
    }
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const leg = await this.resolveLeg(st, args.ticket)
    const rules = await this.symbolRules(st, leg.symbol)
    if (leg.kind === 'pending') {
      const price = Number(args.price)
      if (price > 0) {
        await st.client.signed('PUT', '/fapi/v1/order', {
          symbol: leg.symbol,
          orderId: leg.ticket,
          side: leg.side,
          quantity: formatQuantity(leg.qty, rules),
          price: formatPrice(price, rules),
        })
        leg.entryPrice = price
      }
      return { ticket: leg.ticket, orderTicket: leg.ticket, openPrice: leg.entryPrice, lots: leg.qty, symbol: leg.symbol, state: 'Placed' }
    }
    const hedge = await this.hedgeMode(st)
    const wantSl = args.stoploss === undefined ? undefined : (Number(args.stoploss) > 0 ? Number(args.stoploss) : 0)
    const wantTp = args.takeprofit === undefined ? undefined : (Number(args.takeprofit) > 0 ? Number(args.takeprofit) : 0)
    await this.protect(st, leg, rules, hedge, wantSl, wantTp, false)
    return {
      ticket: leg.ticket,
      positionTicket: leg.ticket,
      openPrice: leg.entryPrice,
      stopLoss: leg.stopLoss,
      takeProfit: leg.takeProfit,
      lots: leg.qty,
      symbol: leg.symbol,
    }
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const leg = await this.resolveLeg(st, args.ticket)
    const rules = await this.symbolRules(st, leg.symbol)
    if (leg.kind === 'pending') {
      await st.client.signed('DELETE', '/fapi/v1/order', { symbol: leg.symbol, orderId: leg.ticket })
      st.legs.delete(leg.ticket)
      return { ticket: leg.ticket, orderTicket: leg.ticket, symbol: leg.symbol, lots: leg.qty, state: 'position_closed' }
    }
    const hedge = await this.hedgeMode(st)
    const wanted = args.lots != null && args.lots > 0 ? Math.min(args.lots, leg.qty) : leg.qty
    const full = wanted >= leg.qty - 1e-12
    const quantity = full ? leg.qty : wanted
    const closeSide: Side = leg.side === 'BUY' ? 'SELL' : 'BUY'
    const closed = asRecord(await st.client.signed('POST', '/fapi/v1/order', {
      symbol: leg.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: formatQuantity(quantity, rules),
      positionSide: hedge ? leg.positionSide : undefined,
      reduceOnly: hedge ? undefined : 'true',
      newClientOrderId: `${CLOSE_PREFIX}:${leg.ticket}:${nonce()}`,
      newOrderRespType: 'RESULT',
    }))
    const closeId = finite(closed.orderId)
    const fill = closeId ? await this.fillOf(st, leg.symbol, closeId, closed) : { qty: quantity, price: 0 }
    const realized = closeId ? await this.realizedFor(st, leg.symbol, closeId) : {}

    if (full) {
      await this.cancelProtection(st, leg)
      st.legs.delete(leg.ticket)
    } else {
      leg.qty = Math.max(0, leg.qty - fill.qty)
      if (leg.stopLoss != null || leg.takeProfit != null) {
        await this.protect(st, leg, rules, hedge, leg.stopLoss ?? 0, leg.takeProfit ?? 0, false, true)
      }
    }
    return {
      ticket: leg.ticket,
      positionTicket: leg.ticket,
      closePrice: positive(fill.price),
      lots: fill.qty > 0 ? fill.qty : quantity,
      symbol: leg.symbol,
      state: 'position_closed',
      profit: realized.profit,
      commission: realized.commission,
    }
  }

  // ── Book ────────────────────────────────────────────────────────────────

  async openedOrders(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    await this.sync(st)
    return [...st.legs.values()]
      .sort((a, b) => a.ticket - b.ticket)
      .map(leg => ({
        ticket: leg.ticket,
        positionTicket: leg.kind === 'position' ? leg.ticket : undefined,
        orderTicket: leg.ticket,
        symbol: leg.symbol,
        operation: operationOf(leg),
        lots: leg.qty,
        volume: leg.qty,
        openPrice: positive(leg.entryPrice),
        stopLoss: leg.stopLoss,
        takeProfit: leg.takeProfit,
        comment: leg.comment,
        ...(leg.kind === 'pending' ? { state: 'Placed' } : {}),
      }))
  }

  async closedOrders(id: string): Promise<unknown[]> {
    const to = new Date()
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
    return this.orderHistory(id, from.toISOString(), to.toISOString())
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const st = await this.state(id)
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    const startTime = Number.isFinite(fromMs) ? fromMs : this.now() - 7 * 24 * 60 * 60 * 1000
    const endTime = Number.isFinite(toMs) ? toMs : this.now()
    const income = asRows(await st.client.signed('GET', '/fapi/v1/income', {
      incomeType: 'REALIZED_PNL',
      startTime,
      endTime,
      limit: 1000,
    }))
    const symbols = [...new Set(income.map(row => String(row.symbol ?? '')).filter(Boolean))].slice(0, 12)
    const rows: unknown[] = []
    for (const symbol of symbols) {
      const [fills, orders] = await Promise.all([
        st.client.signed('GET', '/fapi/v1/userTrades', { symbol, startTime, endTime, limit: 1000 }),
        st.client.signed('GET', '/fapi/v1/allOrders', { symbol, startTime, endTime, limit: 1000 }),
      ])
      const clientIds = new Map<number, string>()
      for (const order of asRows(orders)) {
        const orderId = finite(order.orderId)
        if (orderId) clientIds.set(orderId, String(order.clientOrderId ?? ''))
      }
      for (const fill of asRows(fills)) {
        const realized = finite(fill.realizedPnl) ?? 0
        if (realized === 0) continue
        const orderId = finite(fill.orderId) ?? 0
        const clientId = clientIds.get(orderId) ?? ''
        const closedTicket = clientId.startsWith(`${CLOSE_PREFIX}:`) ? ticketFromClientId(clientId) : null
        rows.push({
          ticket: closedTicket ?? orderId,
          positionTicket: closedTicket ?? orderId,
          dealTicket: finite(fill.id),
          symbol,
          operation: String(fill.side ?? '').toUpperCase() === 'BUY' ? 'Sell' : 'Buy',
          lots: finite(fill.qty) ?? 0,
          openPrice: positive(finite(fill.price)),
          profit: realized,
          commission: -(finite(fill.commission) ?? 0),
          comment: closedTicket ? this.commentForTicket(st, closedTicket) : clientId,
          // Only fills with realized PnL reach this loop, i.e. closing fills, so
          // the fill time is the close time: history readers use a close time to
          // tell a real close from an open echo (and to write the trade's fill).
          time: finite(fill.time),
          closeTime: finite(fill.time),
        })
      }
    }
    // Positions this worker watched disappear from Binance's book, reported
    // under the ticket the copier tracks (see `noteClosedPosition`).
    rows.push(...observedCloseRows(st.closed, startTime, endTime))
    return rows
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
    return { orders: await this.orderHistory(id, from, to), pagesCount: 1 }
  }

  async closedOrdersHistory(id: string, from: string, to: string, _profile?: MtHistoryProfile): Promise<unknown[]> {
    return this.orderHistory(id, from, to)
  }

  async closedOrdersHistoryLite(id: string, from: string, to: string, profile?: MtHistoryProfile): Promise<unknown[]> {
    return this.closedOrdersHistory(id, from, to, profile)
  }

  // ── Account and market ──────────────────────────────────────────────────

  async accountSummary(id: string): Promise<AccountSummary> {
    const st = await this.state(id)
    const account = await this.account(id)
    return {
      balance: finite(account.totalWalletBalance),
      equity: finite(account.totalMarginBalance),
      profit: finite(account.totalUnrealizedProfit),
      margin: finite(account.totalInitialMargin),
      freeMargin: finite(account.availableBalance),
      leverage: st.credential.leverage,
      currency: 'USDT',
      synced: true,
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const st = await this.state(id)
    const rules = await this.symbolRules(st, symbol)
    const book = await this.book(st, rules.symbol)
    return { symbol: rules.symbol, bid: book.bid, ask: book.ask }
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const st = await this.state(id)
    const rules = await this.symbolRules(st, symbol)
    return {
      symbolName: rules.symbol,
      symbol: {
        digits: rules.pricePrecision,
        point: rules.tickSize > 0 ? rules.tickSize : undefined,
        contractSize: 1,
      },
      groupParams: {
        minLot: rules.minQty || undefined,
        maxLot: rules.maxQty || undefined,
        lotStep: rules.stepSize || undefined,
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    const rules = await this.rulesFor(st.credential.environment, st.client)
    return [...rules.values()].filter(r => r.status === 'TRADING').map(r => r.symbol)
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const account = await this.account(id)
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true },
      account: {
        loggedIn: true,
        tradeAllowed: account.canTrade !== false,
        currency: 'USDT',
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

  // ── Internals ───────────────────────────────────────────────────────────

  private async state(id: string): Promise<AccountState> {
    const existing = this.states.get(id)
    if (existing && this.now() - existing.loadedAt < CREDENTIAL_TTL_MS) return existing
    if (!this.loadCredentials) throw new Error('Binance is not configured')
    const credential = await this.loadCredentials(id)
    if (!credential?.apiKey || !credential.apiSecret) throw new Error('Binance is not configured')
    if (existing && existing.credential.apiKey === credential.apiKey && existing.credential.apiSecret === credential.apiSecret
      && existing.credential.environment === credential.environment) {
      existing.credential = credential
      existing.loadedAt = this.now()
      return existing
    }
    const fresh: AccountState = {
      accountId: id,
      credential,
      loadedAt: this.now(),
      client: new BinanceFuturesClient(credential, { fetchImpl: this.fetchImpl, now: this.now }),
      legs: new Map(),
      closed: [],
      hydrated: false,
      applied: new Set(),
    }
    this.states.set(id, fresh)
    return fresh
  }

  private async account(id: string): Promise<Record<string, unknown>> {
    const st = await this.state(id)
    return asRecord(await st.client.signed('GET', '/fapi/v2/account'))
  }

  private async rulesFor(env: BinanceEnvironment, client: BinanceFuturesClient): Promise<Map<string, BinanceSymbolRules>> {
    const cached = this.exchangeInfo.get(env)
    if (cached && this.now() - cached.at < EXCHANGE_INFO_TTL_MS) return cached.rules
    const rules = parseExchangeInfo(await client.publicGet('/fapi/v1/exchangeInfo'))
    if (rules.size === 0) throw new Error('Binance did not return any futures symbols')
    this.exchangeInfo.set(env, { at: this.now(), rules })
    return rules
  }

  private async symbolRules(st: AccountState, name: string): Promise<BinanceSymbolRules> {
    const rules = await this.rulesFor(st.credential.environment, st.client)
    const exact = rules.get(String(name ?? '').trim().toUpperCase())
    if (exact) return exact
    const found = resolveBinanceSymbol(name, rules)
    if (!found) throw new Error(`Symbol ${name} is not available on Binance futures`)
    return found
  }

  private async book(st: AccountState, symbol: string): Promise<{ bid: number; ask: number }> {
    const body = asRecord(await st.client.publicGet('/fapi/v1/ticker/bookTicker', { symbol }))
    const bid = finite(body.bidPrice)
    const ask = finite(body.askPrice)
    if (!bid || !ask) throw new Error(`Binance quote for ${symbol} is unavailable`)
    return { bid, ask }
  }

  private async hedgeMode(st: AccountState): Promise<boolean> {
    if (st.hedge && this.now() - st.hedge.at < HEDGE_TTL_MS) return st.hedge.value
    const body = asRecord(await st.client.signed('GET', '/fapi/v1/positionSide/dual'))
    const value = body.dualSidePosition === true || body.dualSidePosition === 'true'
    st.hedge = { value, at: this.now() }
    return value
  }

  /** Apply the account's leverage and margin mode to the symbol before an order. */
  private async prepareSymbol(st: AccountState, symbol: string): Promise<void> {
    const { leverage, marginMode } = st.credential
    const key = `${symbol}:${leverage}:${marginMode}`
    if (st.applied.has(key)) return
    try {
      await st.client.signed('POST', '/fapi/v1/marginType', {
        symbol,
        marginType: marginMode === 'cross' ? 'CROSSED' : 'ISOLATED',
      })
    } catch (error) {
      if (!(error instanceof BinanceApiError) || error.code == null || !BENIGN_MARGIN_CODES.has(error.code)) {
        throw new Error(`Binance rejected ${marginMode} margin for ${symbol}: ${error instanceof Error ? error.message : error}`)
      }
    }
    try {
      await st.client.signed('POST', '/fapi/v1/leverage', { symbol, leverage })
    } catch (error) {
      throw new Error(`Binance rejected ${leverage}x leverage for ${symbol}: ${error instanceof Error ? error.message : error}`)
    }
    st.applied.add(key)
  }

  /** Market orders can answer before the fill is reported. Read the order back. */
  private async fillOf(
    st: AccountState,
    symbol: string,
    orderId: number,
    first: Record<string, unknown>,
  ): Promise<{ qty: number; price: number }> {
    let order = first
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const qty = finite(order.executedQty) ?? 0
      const price = finite(order.avgPrice) ?? 0
      if (qty > 0 && price > 0) return { qty, price }
      if (attempt === 3) break
      await this.sleep(250)
      try {
        order = asRecord(await st.client.signed('GET', '/fapi/v1/order', { symbol, orderId }))
      } catch {
        // Keep waiting for the fill to settle.
      }
    }
    return { qty: finite(order.executedQty) ?? 0, price: finite(order.avgPrice) ?? 0 }
  }

  private async realizedFor(
    st: AccountState,
    symbol: string,
    orderId: number,
  ): Promise<{ profit?: number; commission?: number }> {
    try {
      const fills = asRows(await st.client.signed('GET', '/fapi/v1/userTrades', { symbol, orderId }))
      if (fills.length === 0) return {}
      let profit = 0
      let commission = 0
      for (const fill of fills) {
        profit += finite(fill.realizedPnl) ?? 0
        commission += finite(fill.commission) ?? 0
      }
      return { profit: Math.round(profit * 1e8) / 1e8, commission: -commission }
    } catch {
      return {}
    }
  }

  private commentForTicket(st: AccountState, ticket: number): string {
    return st.legs.get(ticket)?.comment ?? ''
  }

  // ── Stops ───────────────────────────────────────────────────────────────

  private algoId(row: Record<string, unknown>): number | undefined {
    return finite(row.algoId)
  }

  private async listAlgo(st: AccountState, symbol?: string): Promise<Record<string, unknown>[]> {
    return asRows(await st.client.signed('GET', '/fapi/v1/openAlgoOrders', { symbol }))
  }

  private async cancelAlgo(st: AccountState, algoId: number | undefined): Promise<void> {
    if (!algoId) return
    try {
      await st.client.signed('DELETE', '/fapi/v1/algoOrder', { algoId })
    } catch (error) {
      // Already triggered or cancelled.
      if (!(error instanceof BinanceApiError) || error.status >= 500) throw error
    }
  }

  private async cancelProtection(st: AccountState, leg: Leg): Promise<void> {
    const ids = new Set<number>()
    if (leg.slAlgoId) ids.add(leg.slAlgoId)
    if (leg.tpAlgoId) ids.add(leg.tpAlgoId)
    try {
      for (const row of await this.listAlgo(st, leg.symbol)) {
        const client = String(row.clientAlgoId ?? '')
        const algoId = this.algoId(row)
        if (algoId && (client.startsWith(`${SL_PREFIX}:${leg.ticket}:`) || client.startsWith(`${TP_PREFIX}:${leg.ticket}:`))) {
          ids.add(algoId)
        }
      }
    } catch {
      // Fall back to the ids we already know.
    }
    for (const algoId of ids) await this.cancelAlgo(st, algoId)
    leg.slAlgoId = undefined
    leg.tpAlgoId = undefined
  }

  /**
   * Set or replace a leg's stop loss and take profit. A value of 0 removes it,
   * undefined leaves it alone. Binance conditional orders are algo orders.
   */
  private async protect(
    st: AccountState,
    leg: Leg,
    rules: BinanceSymbolRules,
    hedge: boolean,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    closeOnStopFailure: boolean,
    rebuild = false,
  ): Promise<void> {
    const exitSide: Side = leg.side === 'BUY' ? 'SELL' : 'BUY'
    const place = async (type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', price: number): Promise<number> => {
      const prefix = type === 'STOP_MARKET' ? SL_PREFIX : TP_PREFIX
      const placed = asRecord(await st.client.signed('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol: leg.symbol,
        side: exitSide,
        type,
        triggerPrice: formatPrice(price, rules),
        quantity: formatQuantity(leg.qty, rules),
        positionSide: hedge ? leg.positionSide : undefined,
        reduceOnly: hedge ? undefined : 'true',
        workingType: 'MARK_PRICE',
        clientAlgoId: `${prefix}:${leg.ticket}:${nonce()}`,
      }))
      const algoId = this.algoId(placed)
      if (!algoId) throw new Error('Binance did not return a stop order id')
      return algoId
    }

    if (stopLoss !== undefined || rebuild) {
      const target = stopLoss ?? leg.stopLoss ?? 0
      await this.cancelAlgo(st, leg.slAlgoId)
      leg.slAlgoId = undefined
      leg.stopLoss = undefined
      if (target > 0) {
        try {
          leg.slAlgoId = await place('STOP_MARKET', target)
          leg.stopLoss = target
        } catch (error) {
          if (!closeOnStopFailure) throw error
          await this.emergencyClose(st, leg, rules, hedge)
          throw new Error(
            `Binance rejected the stop loss for ${leg.symbol}, so the position was closed: ${error instanceof Error ? error.message : error}`,
          )
        }
      }
    }
    if (takeProfit !== undefined || rebuild) {
      const target = takeProfit ?? leg.takeProfit ?? 0
      await this.cancelAlgo(st, leg.tpAlgoId)
      leg.tpAlgoId = undefined
      leg.takeProfit = undefined
      if (target > 0) {
        try {
          leg.tpAlgoId = await place('TAKE_PROFIT_MARKET', target)
          leg.takeProfit = target
        } catch (error) {
          if (!closeOnStopFailure) throw error
          console.warn(`[binance] take profit rejected for ${leg.symbol}: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
  }

  /** The stop could not be placed. Do not leave a leveraged position unprotected. */
  private async emergencyClose(st: AccountState, leg: Leg, rules: BinanceSymbolRules, hedge: boolean): Promise<void> {
    try {
      await st.client.signed('POST', '/fapi/v1/order', {
        symbol: leg.symbol,
        side: leg.side === 'BUY' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: formatQuantity(leg.qty, rules),
        positionSide: hedge ? leg.positionSide : undefined,
        reduceOnly: hedge ? undefined : 'true',
        newClientOrderId: `${CLOSE_PREFIX}:${leg.ticket}:${nonce()}`,
      })
    } finally {
      await this.cancelProtection(st, leg)
      st.legs.delete(leg.ticket)
    }
  }

  // ── Leg book ────────────────────────────────────────────────────────────

  private async positions(st: AccountState): Promise<PositionRow[]> {
    const rows = asRows(await st.client.signed('GET', '/fapi/v2/positionRisk'))
    return rows
      .map(row => ({
        symbol: String(row.symbol ?? ''),
        positionSide: String(row.positionSide ?? 'BOTH').toUpperCase(),
        amount: finite(row.positionAmt) ?? 0,
        entryPrice: finite(row.entryPrice) ?? 0,
        markPrice: finite(row.markPrice) ?? 0,
      }))
      .filter(row => row.symbol && row.amount !== 0)
  }

  private netFor(positions: PositionRow[], symbol: string, side: Side): number {
    let net = 0
    for (const row of positions) {
      if (row.symbol !== symbol) continue
      if (row.positionSide === 'LONG') {
        if (side === 'BUY') net += Math.abs(row.amount)
      } else if (row.positionSide === 'SHORT') {
        if (side === 'SELL') net += Math.abs(row.amount)
      } else if (row.amount > 0 && side === 'BUY') {
        net += row.amount
      } else if (row.amount < 0 && side === 'SELL') {
        net += -row.amount
      }
    }
    return net
  }

  /** Rebuild this account's copier legs from Binance after a restart. */
  private async hydrate(st: AccountState, positions: PositionRow[]): Promise<void> {
    const algo = await this.listAlgo(st).catch(() => [] as Record<string, unknown>[])
    const symbols = [...new Set(positions.map(row => row.symbol))]
    for (const symbol of symbols) {
      let orders: Record<string, unknown>[] = []
      try {
        orders = asRows(await st.client.signed('GET', '/fapi/v1/allOrders', { symbol, limit: 500 }))
      } catch {
        continue
      }
      const closedQty = new Map<number, number>()
      for (const order of orders) {
        const client = String(order.clientOrderId ?? '')
        if (!client.startsWith(`${CLOSE_PREFIX}:`)) continue
        const ticket = ticketFromClientId(client)
        if (ticket) closedQty.set(ticket, (closedQty.get(ticket) ?? 0) + (finite(order.executedQty) ?? 0))
      }
      const entries = orders
        .filter(order => isCopierClientId(order.clientOrderId)
          && order.reduceOnly !== true
          && ['FILLED', 'PARTIALLY_FILLED'].includes(String(order.status ?? '')))
        .sort((a, b) => (finite(b.orderId) ?? 0) - (finite(a.orderId) ?? 0))
      const left: Record<Side, number> = {
        BUY: this.netFor(positions, symbol, 'BUY'),
        SELL: this.netFor(positions, symbol, 'SELL'),
      }
      for (const order of entries) {
        const ticket = finite(order.orderId)
        if (!ticket || st.legs.has(ticket)) continue
        const side: Side = String(order.side ?? '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL'
        const remaining = (finite(order.executedQty) ?? 0) - (closedQty.get(ticket) ?? 0)
        const take = Math.min(remaining, left[side])
        if (!(take > 0)) continue
        left[side] -= take
        const leg: Leg = {
          ticket,
          kind: 'position',
          symbol,
          side,
          positionSide: (String(order.positionSide ?? 'BOTH').toUpperCase() as Leg['positionSide']),
          qty: take,
          entryPrice: finite(order.avgPrice) ?? 0,
          comment: String(order.clientOrderId ?? ''),
          openedAt: finite(order.time) ?? this.now(),
        }
        for (const row of algo) {
          const client = String(row.clientAlgoId ?? '')
          const algoId = this.algoId(row)
          const trigger = positive(finite(row.triggerPrice))
          if (client.startsWith(`${SL_PREFIX}:${ticket}:`)) {
            leg.slAlgoId = algoId
            leg.stopLoss = trigger
          } else if (client.startsWith(`${TP_PREFIX}:${ticket}:`)) {
            leg.tpAlgoId = algoId
            leg.takeProfit = trigger
          }
        }
        st.legs.set(ticket, leg)
      }
    }
    try {
      for (const order of asRows(await st.client.signed('GET', '/fapi/v1/openOrders'))) {
        const ticket = finite(order.orderId)
        if (!ticket || !isCopierClientId(order.clientOrderId) || st.legs.has(ticket)) continue
        st.legs.set(ticket, {
          ticket,
          kind: 'pending',
          symbol: String(order.symbol ?? ''),
          side: String(order.side ?? '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
          positionSide: (String(order.positionSide ?? 'BOTH').toUpperCase() as Leg['positionSide']),
          qty: finite(order.origQty) ?? 0,
          entryPrice: finite(order.price) ?? 0,
          comment: String(order.clientOrderId ?? ''),
          openedAt: finite(order.time) ?? this.now(),
        })
      }
    } catch {
      // Pending rows are optional.
    }
    st.hydrated = true
  }

  /**
   * Remember a position as closed once the exchange itself reports nothing
   * left for it.
   *
   * Binance USDT-M futures have no per-position id: a history row carries the
   * id of the order that produced the fill, which is the ticket the copier
   * tracks only when the copier placed that close. A stop-loss, take-profit,
   * manual or liquidated close therefore never matches the tracked ticket —
   * and the mirror engine, which refuses to close a copy without history
   * confirming the source is gone, would leave that copy open forever.
   * Noting the leg as it leaves the live book lets `orderHistory` answer with
   * the tracked ticket instead.
   *
   * Recorded only when the exchange reports no remaining position for the
   * leg's symbol and side, so a protective order that merely disappeared
   * (cancelled, not executed) can never confirm a close that did not happen.
   */
  private noteClosedPosition(st: AccountState, positions: PositionRow[], leg: Leg): void {
    if (leg.kind !== 'position') return
    if (this.netFor(positions, leg.symbol, leg.side) > 0) return
    noteObservedClose(st.closed, {
      ticket: leg.ticket, symbol: leg.symbol, operation: operationOf(leg), lots: leg.qty, at: this.now(),
    })
  }

  /**
   * Reconcile our legs with Binance: drop legs whose position is gone or whose
   * protective order fired (cancelling the surviving partner), and trim quantities
   * to what the position still holds.
   */
  private async sync(st: AccountState): Promise<void> {
    const positions = await this.positions(st)
    if (!st.hydrated) await this.hydrate(st, positions)
    const algo = await this.listAlgo(st).catch(() => null)
    const liveAlgo = algo ? new Set(algo.map(row => this.algoId(row)).filter((v): v is number => v != null)) : null

    if (liveAlgo) {
      for (const leg of [...st.legs.values()]) {
        if (leg.kind !== 'position') continue
        const slGone = leg.slAlgoId != null && !liveAlgo.has(leg.slAlgoId)
        const tpGone = leg.tpAlgoId != null && !liveAlgo.has(leg.tpAlgoId)
        if (!slGone && !tpGone) continue
        // One of the pair fired. Cancel the partner so it cannot reduce another leg.
        await this.cancelProtection(st, leg).catch(() => undefined)
        this.noteClosedPosition(st, positions, leg)
        st.legs.delete(leg.ticket)
      }
    }

    const groups = new Map<string, Leg[]>()
    for (const leg of st.legs.values()) {
      if (leg.kind !== 'position') continue
      const key = `${leg.symbol}:${leg.side}`
      groups.set(key, [...(groups.get(key) ?? []), leg])
    }
    for (const legs of groups.values()) {
      let left = this.netFor(positions, legs[0]!.symbol, legs[0]!.side)
      for (const leg of legs.sort((a, b) => b.ticket - a.ticket)) {
        const take = Math.min(leg.qty, left)
        if (!(take > 0)) {
          await this.cancelProtection(st, leg).catch(() => undefined)
          this.noteClosedPosition(st, positions, leg)
          st.legs.delete(leg.ticket)
          continue
        }
        leg.qty = take
        left -= take
      }
    }

    // Pending limit orders that filled or were cancelled leave the book.
    const pending = [...st.legs.values()].filter(leg => leg.kind === 'pending')
    if (pending.length > 0) {
      try {
        const open = new Set(asRows(await st.client.signed('GET', '/fapi/v1/openOrders'))
          .map(row => finite(row.orderId))
          .filter((v): v is number => v != null))
        for (const leg of pending) if (!open.has(leg.ticket)) st.legs.delete(leg.ticket)
      } catch {
        // Keep the pending rows until the next read.
      }
    }
  }

  private async resolveLeg(st: AccountState, ticket: number): Promise<Leg> {
    const known = st.legs.get(ticket)
    if (known) return known
    if (!st.hydrated) {
      await this.sync(st)
    } else {
      st.hydrated = false
      await this.sync(st)
    }
    const found = st.legs.get(ticket)
    if (!found) throw new Error(`Binance order ${ticket} was not found`)
    return found
  }
}

export function createBinanceProvider(options?: BinanceProviderOptions): BinanceProvider {
  return new BinanceProvider(options)
}

let singleton: BinanceProvider | undefined

export function getBinanceProvider(): BinanceProvider {
  if (!singleton) {
    singleton = new BinanceProvider({
      loadCredentials: async accountId => {
        const { loadBinanceCredential } = await import('./binance/credentials')
        return loadBinanceCredential(accountId)
      },
    })
  }
  return singleton
}
