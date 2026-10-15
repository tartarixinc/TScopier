/**
 * Bybit V5 linear derivatives (USDT/USDC perpetuals and USDT futures) as a BrokerProvider.
 *
 * Mirrors BinanceProvider. Each copied order is sized from margin x leverage, entry is a
 * market or limit order, and every signal leg carries its own stop loss and take profit as
 * reduce-only conditional orders tagged with the leg ticket in `orderLinkId`
 * (`TSL_<ticket>_<nonce>` / `TST_<ticket>_<nonce>`). Bybit allows 10 active conditional
 * orders per symbol, so a symbol can hold at most five protected legs.
 *
 * Margin mode is account-wide on a Unified account and is never changed here; it is only
 * reported through mtStatus. Leverage is applied to the symbol before each order.
 */
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
  BybitApiError,
  BybitClient,
  type BybitCredential,
  type BybitEnvironment,
} from './bybit/client'
import {
  BybitSizingError,
  CLOSE_PREFIX,
  SL_PREFIX,
  TICKET_EPOCH_MS,
  TP_PREFIX,
  childOrderLinkId,
  commentFromOrderLinkId,
  copierOrderLinkId,
  formatPrice,
  formatQuantity,
  hashOrderId,
  isCopierLinkId,
  parseInstruments,
  resolveBybitSymbol,
  sizeBybitPosition,
  ticketFromChildLinkId,
  ticketFromEntryLinkId,
  type BybitSymbolRules,
} from './bybit/symbols'

export type { BybitCredential } from './bybit/client'

export interface BybitProviderOptions {
  loadCredentials?: (accountId: string) => Promise<BybitCredential | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type Side = 'Buy' | 'Sell'

type Leg = {
  ticket: number
  kind: 'position' | 'pending'
  symbol: string
  side: Side
  positionIdx: 0 | 1 | 2
  qty: number
  entryPrice: number
  comment: string
  /** Entry order id, needed to amend or cancel a pending limit. */
  orderId?: string
  stopLoss?: number
  takeProfit?: number
  slOrderId?: string
  tpOrderId?: string
  openedAt: number
}

type PositionRow = {
  symbol: string
  side: Side
  positionIdx: number
  amount: number
  entryPrice: number
  markPrice: number
}

type AccountState = {
  accountId: string
  credential: BybitCredential
  loadedAt: number
  client: BybitClient
  legs: Map<number, Leg>
  hydrated: boolean
  /** Symbols whose leverage we already set, keyed `symbol:leverage`. */
  applied: Set<string>
  hedge: Map<string, { value: boolean; at: number }>
  unified?: { value: boolean; at: number }
}

const CREDENTIAL_TTL_MS = 30_000
const INSTRUMENTS_TTL_MS = 10 * 60_000
const HEDGE_TTL_MS = 60_000
const UNIFIED_TTL_MS = 5 * 60_000
const HISTORY_WEEKS = 4
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const SETTLE_COINS = ['USDT', 'USDC'] as const
const CATEGORY = 'linear'

/** `110043`: set-leverage was a no-op. */
const BENIGN_LEVERAGE_CODES = new Set([110043])
/** `110001` order missing, `110008` completed or cancelled, `110010` already cancelled. */
const BENIGN_CANCEL_CODES = new Set([110001, 110008, 110010])
const AUTH_CODES = new Set([10003, 10004, 10005, 10010, 33004])
const FILLED_STATES = new Set(['Filled', 'PartiallyFilledCanceled'])
const DEAD_STATES = new Set(['Cancelled', 'Rejected', 'Deactivated'])

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

function sideOf(operation: string): Side {
  return /^Buy/i.test(operation) ? 'Buy' : 'Sell'
}

function operationOf(leg: Pick<Leg, 'side' | 'kind'>): string {
  if (leg.kind === 'pending') return leg.side === 'Buy' ? 'BuyLimit' : 'SellLimit'
  return leg.side === 'Buy' ? 'Buy' : 'Sell'
}

function exitSideOf(side: Side): Side {
  return side === 'Buy' ? 'Sell' : 'Buy'
}

export class BybitProvider implements BrokerProvider {
  readonly name = 'bybit' as const
  private readonly states = new Map<string, AccountState>()
  private readonly instruments = new Map<BybitEnvironment, { at: number; rules: Map<string, BybitSymbolRules> }>()
  private readonly loadCredentials?: (accountId: string) => Promise<BybitCredential | null>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private lastTicket = 0

  constructor(options: BybitProviderOptions = {}) {
    this.loadCredentials = options.loadCredentials
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  seedPlatformCache(_id: string, _platform: MtPlatform | string | null | undefined): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return { id, platform: 'Bybit', status: status.broker?.connected ? 'connected' : 'disconnected', error: '' }
    } catch (error) {
      return {
        id,
        platform: 'Bybit',
        status: 'error',
        error: error instanceof Error ? error.message : 'Bybit status failed',
      }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('Bybit accounts connect with an API key')
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
      if (error instanceof BybitApiError && ((error.code != null && AUTH_CODES.has(error.code)) || error.status === 401)) {
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

  // ── Orders ──────────────────────────────────────────────────────────────

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const st = await this.state(id)
    await this.requireUnified(st)
    const rules = await this.symbolRules(st, args.symbol)
    const side = sideOf(args.operation)
    const market = args.operation === 'Buy' || args.operation === 'Sell'
    const limit = args.operation === 'BuyLimit' || args.operation === 'SellLimit'
    if (!market && !limit) throw new Error(`Bybit futures does not support ${args.operation} orders`)

    let referencePrice: number
    if (limit) {
      referencePrice = Number(args.price)
      if (!(referencePrice > 0)) throw new Error('Bybit limit order is missing a price')
    } else {
      const book = await this.book(st, rules.symbol)
      referencePrice = side === 'Buy' ? book.ask : book.bid
    }

    let quantity: number
    try {
      quantity = sizeBybitPosition({
        marginUsdt: st.credential.marginUsdt,
        leverage: st.credential.leverage,
        price: referencePrice,
        rules,
        kind: limit ? 'limit' : 'market',
      })
    } catch (error) {
      if (error instanceof BybitSizingError) throw new Error(error.message)
      throw error
    }

    await this.prepareSymbol(st, rules.symbol)
    const positionIdx = await this.positionIdxFor(st, rules.symbol, side)
    const ticket = this.nextTicket()
    const linkId = copierOrderLinkId(args.comment, ticket)
    const placed = asRecord(await st.client.signed('POST', '/v5/order/create', {
      category: CATEGORY,
      symbol: rules.symbol,
      side,
      orderType: market ? 'Market' : 'Limit',
      qty: formatQuantity(quantity, rules),
      price: limit ? formatPrice(referencePrice, rules) : undefined,
      timeInForce: limit ? 'GTC' : undefined,
      positionIdx,
      orderLinkId: linkId,
    }))
    const orderId = String(placed.orderId ?? '')
    if (!orderId) throw new Error('Bybit did not return an order id')

    if (limit) {
      st.legs.set(ticket, {
        ticket,
        kind: 'pending',
        symbol: rules.symbol,
        side,
        positionIdx,
        qty: quantity,
        entryPrice: referencePrice,
        comment: commentFromOrderLinkId(linkId),
        orderId,
        openedAt: this.now(),
      })
      return {
        ticket,
        orderTicket: ticket,
        openPrice: referencePrice,
        lots: quantity,
        symbol: rules.symbol,
        state: 'Placed',
        comment: commentFromOrderLinkId(linkId),
      }
    }

    const filled = await this.fillOf(st, rules.symbol, orderId)
    if (filled.dead) {
      throw new Error(`Bybit did not fill the ${side} market order for ${rules.symbol}${filled.reason ? `: ${filled.reason}` : ''}`)
    }
    const leg: Leg = {
      ticket,
      kind: 'position',
      symbol: rules.symbol,
      side,
      positionIdx,
      qty: filled.qty > 0 ? filled.qty : quantity,
      entryPrice: filled.price > 0 ? filled.price : referencePrice,
      comment: commentFromOrderLinkId(linkId),
      orderId,
      openedAt: this.now(),
    }
    st.legs.set(ticket, leg)

    const stopLoss = positive(finite(args.stoploss))
    const takeProfit = positive(finite(args.takeprofit))
    if (stopLoss != null || takeProfit != null) {
      await this.protect(st, leg, rules, stopLoss, takeProfit, true)
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
      comment: leg.comment,
    }
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const leg = await this.resolveLeg(st, args.ticket)
    const rules = await this.symbolRules(st, leg.symbol)
    if (leg.kind === 'pending') {
      const price = Number(args.price)
      if (price > 0 && leg.orderId) {
        await st.client.signed('POST', '/v5/order/amend', {
          category: CATEGORY,
          symbol: leg.symbol,
          orderId: leg.orderId,
          qty: formatQuantity(leg.qty, rules),
          price: formatPrice(price, rules),
        })
        leg.entryPrice = price
      }
      return { ticket: leg.ticket, orderTicket: leg.ticket, openPrice: leg.entryPrice, lots: leg.qty, symbol: leg.symbol, state: 'Placed' }
    }
    const wantSl = args.stoploss === undefined ? undefined : (Number(args.stoploss) > 0 ? Number(args.stoploss) : 0)
    const wantTp = args.takeprofit === undefined ? undefined : (Number(args.takeprofit) > 0 ? Number(args.takeprofit) : 0)
    await this.protect(st, leg, rules, wantSl, wantTp, false)
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
      await this.cancelOrder(st, leg.symbol, leg.orderId)
      st.legs.delete(leg.ticket)
      return { ticket: leg.ticket, orderTicket: leg.ticket, symbol: leg.symbol, lots: leg.qty, state: 'position_closed' }
    }
    const wanted = args.lots != null && args.lots > 0 ? Math.min(args.lots, leg.qty) : leg.qty
    const full = wanted >= leg.qty - 1e-12
    const quantity = full ? leg.qty : wanted
    const closed = asRecord(await st.client.signed('POST', '/v5/order/create', {
      category: CATEGORY,
      symbol: leg.symbol,
      side: exitSideOf(leg.side),
      orderType: 'Market',
      qty: formatQuantity(quantity, rules),
      reduceOnly: true,
      positionIdx: leg.positionIdx,
      orderLinkId: childOrderLinkId(CLOSE_PREFIX, leg.ticket, nonce()),
    }))
    const closeId = String(closed.orderId ?? '')
    const fill = closeId ? await this.fillOf(st, leg.symbol, closeId) : { qty: quantity, price: 0, dead: false }
    if (fill.dead) {
      throw new Error(`Bybit did not fill the close order for ${leg.symbol}${fill.reason ? `: ${fill.reason}` : ''}`)
    }
    const realized = closeId ? await this.realizedFor(st, leg.symbol, closeId) : {}

    if (full) {
      await this.cancelProtection(st, leg)
      st.legs.delete(leg.ticket)
    } else {
      leg.qty = Number(Math.max(0, leg.qty - fill.qty).toFixed(10))
      if (leg.stopLoss != null || leg.takeProfit != null) {
        await this.protect(st, leg, rules, leg.stopLoss ?? 0, leg.takeProfit ?? 0, false, true)
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
    const to = new Date(this.now())
    const from = new Date(to.getTime() - WEEK_MS)
    return this.orderHistory(id, from.toISOString(), to.toISOString())
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const st = await this.state(id)
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    const end = Number.isFinite(toMs) ? toMs : this.now()
    const start = Number.isFinite(fromMs) ? fromMs : end - WEEK_MS
    // closed-pnl and order/history accept at most seven days per request.
    const windows: Array<[number, number]> = []
    for (let upper = end, i = 0; upper > start && i < 5; i += 1) {
      const lower = Math.max(start, upper - WEEK_MS + 1)
      windows.push([lower, upper])
      upper = lower - 1
    }
    const closed: Record<string, unknown>[] = []
    for (const [lower, upper] of windows) {
      closed.push(...await this.listCursor(st, '/v5/position/closed-pnl', {
        category: CATEGORY,
        startTime: lower,
        endTime: upper,
        limit: 100,
      }))
    }
    const symbols = [...new Set(closed.map(row => String(row.symbol ?? '')).filter(Boolean))].slice(0, 12)
    const linkIds = new Map<string, string>()
    const entryComments = new Map<number, string>()
    for (const symbol of symbols) {
      for (const [lower, upper] of windows) {
        try {
          const orders = await this.listCursor(st, '/v5/order/history', {
            category: CATEGORY,
            symbol,
            orderFilter: 'Order',
            startTime: lower,
            endTime: upper,
            limit: 50,
          })
          for (const order of orders) {
            const orderId = String(order.orderId ?? '')
            if (orderId) linkIds.set(orderId, String(order.orderLinkId ?? ''))
            const entryTicket = ticketFromEntryLinkId(order.orderLinkId)
            if (entryTicket) entryComments.set(entryTicket, commentFromOrderLinkId(order.orderLinkId))
          }
        } catch {
          // Rows still show without comments.
        }
      }
    }
    return closed.map(row => {
      const orderId = String(row.orderId ?? '')
      const linkId = linkIds.get(orderId) ?? ''
      const closedTicket = ticketFromChildLinkId(linkId, CLOSE_PREFIX)
      const closingSell = String(row.side ?? '') === 'Sell'
      const fees = (finite(row.openFee) ?? 0) + (finite(row.closeFee) ?? 0)
      const ticket = closedTicket ?? hashOrderId(orderId)
      return {
        ticket,
        positionTicket: ticket,
        dealTicket: hashOrderId(orderId),
        symbol: String(row.symbol ?? ''),
        operation: closingSell ? 'Buy' : 'Sell',
        lots: finite(row.closedSize) ?? finite(row.qty) ?? 0,
        openPrice: positive(finite(row.avgEntryPrice)),
        closePrice: positive(finite(row.avgExitPrice)),
        profit: finite(row.closedPnl) ?? 0,
        commission: -fees,
        comment: closedTicket
          ? (entryComments.get(closedTicket) ?? this.commentForTicket(st, closedTicket))
          : (isCopierLinkId(linkId) ? commentFromOrderLinkId(linkId) : linkId),
        time: finite(row.updatedTime) ?? finite(row.createdTime),
      }
    })
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
      equity: finite(account.totalEquity),
      profit: finite(account.totalPerpUPL),
      margin: finite(account.totalInitialMargin),
      freeMargin: finite(account.totalAvailableBalance),
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
    const tickText = rules.tickSize > 0 ? rules.tickSize.toString() : ''
    const digits = tickText.includes('.') ? tickText.split('.')[1]!.length : 0
    return {
      symbolName: rules.symbol,
      symbol: {
        digits,
        point: rules.tickSize > 0 ? rules.tickSize : undefined,
        contractSize: 1,
      },
      groupParams: {
        minLot: rules.minQty || undefined,
        maxLot: rules.maxMarketQty || rules.maxQty || undefined,
        lotStep: rules.qtyStep || undefined,
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    const rules = await this.rulesFor(st.credential.environment, st.client)
    return [...rules.values()].filter(r => r.status === 'Trading').map(r => r.symbol)
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const st = await this.state(id)
    const info = await this.accountInfo(st)
    const unified = Number(info.unifiedMarginStatus) >= 3
    st.unified = { value: unified, at: this.now() }
    const marginMode = String(info.marginMode ?? '')
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true },
      account: {
        loggedIn: true,
        tradeAllowed: unified,
        currency: 'USDT',
        marginMode,
        ...(unified ? {} : { error: 'Bybit account is not a Unified Trading Account' }),
      },
      bridge: { tradeEaReady: unified, symbolsSynced: true },
    } as FxsocketMtStatus
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

  private nextTicket(): number {
    // Milliseconds since TICKET_EPOCH_MS, x16. Strictly increasing within the process.
    const candidate = (this.now() - TICKET_EPOCH_MS) * 16
    this.lastTicket = candidate > this.lastTicket ? candidate : this.lastTicket + 1
    return this.lastTicket
  }

  private async state(id: string): Promise<AccountState> {
    const existing = this.states.get(id)
    if (existing && this.now() - existing.loadedAt < CREDENTIAL_TTL_MS) return existing
    if (!this.loadCredentials) throw new Error('Bybit is not configured')
    const credential = await this.loadCredentials(id)
    if (!credential?.apiKey || !credential.apiSecret) throw new Error('Bybit is not configured')
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
      client: new BybitClient(credential, { fetchImpl: this.fetchImpl, now: this.now }),
      legs: new Map(),
      hydrated: false,
      applied: new Set(),
      hedge: new Map(),
    }
    this.states.set(id, fresh)
    return fresh
  }

  private async accountInfo(st: AccountState): Promise<Record<string, unknown>> {
    return asRecord(await st.client.signed('GET', '/v5/account/info'))
  }

  private async account(id: string): Promise<Record<string, unknown>> {
    const st = await this.state(id)
    const result = asRecord(await st.client.signed('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }))
    return asRows(result.list)[0] ?? {}
  }

  /** Only Unified Trading Accounts are supported. Cached so orders do not pay a round trip each time. */
  private async requireUnified(st: AccountState): Promise<void> {
    if (!st.unified || this.now() - st.unified.at > UNIFIED_TTL_MS) {
      const info = await this.accountInfo(st)
      st.unified = { value: Number(info.unifiedMarginStatus) >= 3, at: this.now() }
    }
    if (!st.unified.value) {
      throw new Error('This Bybit account is not a Unified Trading Account. Upgrade it to Unified to copy trades.')
    }
  }

  private async rulesFor(env: BybitEnvironment, client: BybitClient): Promise<Map<string, BybitSymbolRules>> {
    const cached = this.instruments.get(env)
    if (cached && this.now() - cached.at < INSTRUMENTS_TTL_MS) return cached.rules
    const rules = new Map<string, BybitSymbolRules>()
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = asRecord(await client.publicGet('/v5/market/instruments-info', { category: CATEGORY, limit: 1000, cursor }))
      parseInstruments(result, rules)
      const next = typeof result.nextPageCursor === 'string' ? result.nextPageCursor : ''
      if (!next) break
      cursor = next
    }
    if (rules.size === 0) throw new Error('Bybit did not return any linear symbols')
    this.instruments.set(env, { at: this.now(), rules })
    return rules
  }

  private async symbolRules(st: AccountState, name: string): Promise<BybitSymbolRules> {
    const rules = await this.rulesFor(st.credential.environment, st.client)
    const found = resolveBybitSymbol(name, rules)
    if (!found) throw new Error(`Symbol ${name} is not available on Bybit linear futures`)
    return found
  }

  private async book(st: AccountState, symbol: string): Promise<{ bid: number; ask: number }> {
    const result = asRecord(await st.client.publicGet('/v5/market/tickers', { category: CATEGORY, symbol }))
    const row = asRows(result.list)[0] ?? {}
    const bid = finite(row.bid1Price)
    const ask = finite(row.ask1Price)
    if (!bid || !ask) throw new Error(`Bybit quote for ${symbol} is unavailable`)
    return { bid, ask }
  }

  /** Hedge mode shows two position rows (index 1 and 2) per symbol. One-way shows a single index-0 row. */
  private async hedgeMode(st: AccountState, symbol: string): Promise<boolean> {
    const cached = st.hedge.get(symbol)
    if (cached && this.now() - cached.at < HEDGE_TTL_MS) return cached.value
    const result = asRecord(await st.client.signed('GET', '/v5/position/list', { category: CATEGORY, symbol }))
    const rows = asRows(result.list)
    const value = rows.length > 1 || rows.some(row => (finite(row.positionIdx) ?? 0) !== 0)
    st.hedge.set(symbol, { value, at: this.now() })
    return value
  }

  private async positionIdxFor(st: AccountState, symbol: string, side: Side): Promise<0 | 1 | 2> {
    const hedge = await this.hedgeMode(st, symbol)
    if (!hedge) return 0
    return side === 'Buy' ? 1 : 2
  }

  /** Apply the account's leverage to the symbol before an order. Margin mode is left alone. */
  private async prepareSymbol(st: AccountState, symbol: string): Promise<void> {
    const { leverage } = st.credential
    const key = `${symbol}:${leverage}`
    if (st.applied.has(key)) return
    try {
      await st.client.signed('POST', '/v5/position/set-leverage', {
        category: CATEGORY,
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      })
    } catch (error) {
      if (!(error instanceof BybitApiError) || error.code == null || !BENIGN_LEVERAGE_CODES.has(error.code)) {
        throw new Error(`Bybit rejected ${leverage}x leverage for ${symbol}: ${error instanceof Error ? error.message : error}`)
      }
    }
    st.applied.add(key)
  }

  /**
   * Order creation is asynchronous. Read the order back until it reports a fill or a
   * terminal state. `dead` means it ended with nothing filled (for example an IOC market
   * order with no liquidity inside the slippage limit).
   */
  private async fillOf(
    st: AccountState,
    symbol: string,
    orderId: string,
  ): Promise<{ qty: number; price: number; dead: boolean; reason?: string }> {
    let qty = 0
    let price = 0
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const path of ['/v5/order/realtime', '/v5/order/history']) {
        try {
          const result = asRecord(await st.client.signed('GET', path, { category: CATEGORY, symbol, orderId }))
          const order = asRows(result.list)[0]
          if (!order) continue
          qty = finite(order.cumExecQty) ?? 0
          price = finite(order.avgPrice) ?? 0
          const state = String(order.orderStatus ?? '')
          if (FILLED_STATES.has(state) && qty > 0) return { qty, price, dead: false }
          if (DEAD_STATES.has(state) && qty <= 0) {
            return { qty: 0, price: 0, dead: true, reason: String(order.rejectReason ?? order.cancelType ?? state) }
          }
          if (DEAD_STATES.has(state) && qty > 0) return { qty, price, dead: false }
        } catch {
          // Keep waiting for the order to settle.
        }
        break
      }
      if (attempt < 4) await this.sleep(250)
    }
    return { qty, price, dead: false }
  }

  /** Realized profit and fees for a close order, from closed-pnl. */
  private async realizedFor(
    st: AccountState,
    symbol: string,
    orderId: string,
  ): Promise<{ profit?: number; commission?: number }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = asRecord(await st.client.signed('GET', '/v5/position/closed-pnl', { category: CATEGORY, symbol, limit: 50 }))
        const rows = asRows(result.list).filter(row => String(row.orderId ?? '') === orderId)
        if (rows.length > 0) {
          let profit = 0
          let fees = 0
          for (const row of rows) {
            profit += finite(row.closedPnl) ?? 0
            fees += (finite(row.openFee) ?? 0) + (finite(row.closeFee) ?? 0)
          }
          return { profit: Math.round(profit * 1e8) / 1e8, commission: -fees }
        }
      } catch {
        return {}
      }
      if (attempt < 2) await this.sleep(300)
    }
    return {}
  }

  private commentForTicket(st: AccountState, ticket: number): string {
    return st.legs.get(ticket)?.comment ?? ''
  }

  private async listCursor(
    st: AccountState,
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    maxPages = 5,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page += 1) {
      const result = asRecord(await st.client.signed('GET', path, { ...params, cursor }))
      rows.push(...asRows(result.list))
      const next = typeof result.nextPageCursor === 'string' ? result.nextPageCursor : ''
      if (!next) break
      cursor = next
    }
    return rows
  }

  private async cancelOrder(st: AccountState, symbol: string, orderId: string | undefined): Promise<void> {
    if (!orderId) return
    try {
      await st.client.signed('POST', '/v5/order/cancel', { category: CATEGORY, symbol, orderId })
    } catch (error) {
      // Already triggered, filled or cancelled.
      if (error instanceof BybitApiError && error.code != null && BENIGN_CANCEL_CODES.has(error.code)) return
      throw error
    }
  }

  // ── Stops ───────────────────────────────────────────────────────────────

  /** Open conditional (untriggered stop) orders, or active limit orders, across both settle coins. */
  private async openOrders(st: AccountState, filter: 'StopOrder' | 'Order'): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    for (const settleCoin of SETTLE_COINS) {
      rows.push(...await this.listCursor(st, '/v5/order/realtime', {
        category: CATEGORY,
        settleCoin,
        orderFilter: filter,
        limit: 50,
      }))
    }
    return rows
  }

  private async cancelProtection(st: AccountState, leg: Leg): Promise<void> {
    const ids = new Set<string>()
    if (leg.slOrderId) ids.add(leg.slOrderId)
    if (leg.tpOrderId) ids.add(leg.tpOrderId)
    try {
      for (const row of await this.openOrders(st, 'StopOrder')) {
        const link = String(row.orderLinkId ?? '')
        const orderId = String(row.orderId ?? '')
        if (orderId && (ticketFromChildLinkId(link, SL_PREFIX) === leg.ticket || ticketFromChildLinkId(link, TP_PREFIX) === leg.ticket)) {
          ids.add(orderId)
        }
      }
    } catch {
      // Fall back to the ids we already know.
    }
    for (const orderId of ids) await this.cancelOrder(st, leg.symbol, orderId)
    leg.slOrderId = undefined
    leg.tpOrderId = undefined
  }

  /**
   * Set or replace a leg's stop loss and take profit. A value of 0 removes it,
   * undefined leaves it alone. Each is a reduce-only conditional market order
   * triggered on the mark price, tagged with the leg ticket.
   */
  private async protect(
    st: AccountState,
    leg: Leg,
    rules: BybitSymbolRules,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    closeOnStopFailure: boolean,
    rebuild = false,
  ): Promise<void> {
    const exitSide = exitSideOf(leg.side)
    const place = async (kind: 'sl' | 'tp', price: number): Promise<string> => {
      // triggerDirection 1: fires when price rises to the trigger, 2: when it falls.
      const longExit = exitSide === 'Sell'
      const direction = kind === 'sl' ? (longExit ? 2 : 1) : (longExit ? 1 : 2)
      const placed = asRecord(await st.client.signed('POST', '/v5/order/create', {
        category: CATEGORY,
        symbol: leg.symbol,
        side: exitSide,
        orderType: 'Market',
        qty: formatQuantity(leg.qty, rules),
        triggerPrice: formatPrice(price, rules),
        triggerDirection: direction,
        triggerBy: 'MarkPrice',
        reduceOnly: true,
        closeOnTrigger: true,
        positionIdx: leg.positionIdx,
        orderLinkId: childOrderLinkId(kind === 'sl' ? SL_PREFIX : TP_PREFIX, leg.ticket, nonce()),
      }))
      const orderId = String(placed.orderId ?? '')
      if (!orderId) throw new Error('Bybit did not return a stop order id')
      return orderId
    }

    if (stopLoss !== undefined || rebuild) {
      const target = stopLoss ?? leg.stopLoss ?? 0
      await this.cancelOrder(st, leg.symbol, leg.slOrderId)
      leg.slOrderId = undefined
      leg.stopLoss = undefined
      if (target > 0) {
        try {
          leg.slOrderId = await place('sl', target)
          leg.stopLoss = target
        } catch (error) {
          if (!closeOnStopFailure) throw error
          await this.emergencyClose(st, leg, rules)
          throw new Error(
            `Bybit rejected the stop loss for ${leg.symbol}, so the position was closed: ${error instanceof Error ? error.message : error}`,
          )
        }
      }
    }
    if (takeProfit !== undefined || rebuild) {
      const target = takeProfit ?? leg.takeProfit ?? 0
      await this.cancelOrder(st, leg.symbol, leg.tpOrderId)
      leg.tpOrderId = undefined
      leg.takeProfit = undefined
      if (target > 0) {
        try {
          leg.tpOrderId = await place('tp', target)
          leg.takeProfit = target
        } catch (error) {
          if (!closeOnStopFailure) throw error
          console.warn(`[bybit] take profit rejected for ${leg.symbol}: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
  }

  /** The stop could not be placed. Do not leave a leveraged position unprotected. */
  private async emergencyClose(st: AccountState, leg: Leg, rules: BybitSymbolRules): Promise<void> {
    try {
      await st.client.signed('POST', '/v5/order/create', {
        category: CATEGORY,
        symbol: leg.symbol,
        side: exitSideOf(leg.side),
        orderType: 'Market',
        qty: formatQuantity(leg.qty, rules),
        reduceOnly: true,
        positionIdx: leg.positionIdx,
        orderLinkId: childOrderLinkId(CLOSE_PREFIX, leg.ticket, nonce()),
      })
    } finally {
      await this.cancelProtection(st, leg)
      st.legs.delete(leg.ticket)
    }
  }

  // ── Leg book ────────────────────────────────────────────────────────────

  private async positions(st: AccountState): Promise<PositionRow[]> {
    const out: PositionRow[] = []
    for (const settleCoin of SETTLE_COINS) {
      const rows = await this.listCursor(st, '/v5/position/list', { category: CATEGORY, settleCoin, limit: 200 })
      for (const row of rows) {
        const side = String(row.side ?? '')
        const amount = finite(row.size) ?? 0
        const symbol = String(row.symbol ?? '')
        if (!symbol || amount <= 0 || (side !== 'Buy' && side !== 'Sell')) continue
        out.push({
          symbol,
          side,
          positionIdx: finite(row.positionIdx) ?? 0,
          amount,
          entryPrice: finite(row.avgPrice) ?? 0,
          markPrice: finite(row.markPrice) ?? 0,
        })
      }
    }
    return out
  }

  private netFor(positions: PositionRow[], symbol: string, side: Side): number {
    let net = 0
    for (const row of positions) if (row.symbol === symbol && row.side === side) net += row.amount
    return net
  }

  /** Order history for a symbol across the last few weeks, newest window first. */
  private async historyOrders(st: AccountState, symbol: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    const end = this.now()
    for (let week = 0; week < HISTORY_WEEKS; week += 1) {
      const upper = end - week * WEEK_MS
      const lower = upper - WEEK_MS + 1
      rows.push(...await this.listCursor(st, '/v5/order/history', {
        category: CATEGORY,
        symbol,
        orderFilter: 'Order',
        startTime: lower,
        endTime: upper,
        limit: 50,
      }))
    }
    return rows
  }

  /** Rebuild this account's copier legs from Bybit after a restart. */
  private async hydrate(st: AccountState, positions: PositionRow[]): Promise<void> {
    const stops = await this.openOrders(st, 'StopOrder').catch(() => [] as Record<string, unknown>[])
    const symbols = [...new Set(positions.map(row => row.symbol))]
    for (const symbol of symbols) {
      let orders: Record<string, unknown>[] = []
      try {
        orders = await this.historyOrders(st, symbol)
      } catch {
        continue
      }
      const closedQty = new Map<number, number>()
      for (const order of orders) {
        const ticket = ticketFromChildLinkId(order.orderLinkId, CLOSE_PREFIX)
        if (ticket) closedQty.set(ticket, (closedQty.get(ticket) ?? 0) + (finite(order.cumExecQty) ?? 0))
      }
      const entries = orders
        .filter(order => isCopierLinkId(order.orderLinkId)
          && ticketFromEntryLinkId(order.orderLinkId) != null
          && order.reduceOnly !== true
          && FILLED_STATES.has(String(order.orderStatus ?? '')))
        .sort((a, b) => (ticketFromEntryLinkId(b.orderLinkId) ?? 0) - (ticketFromEntryLinkId(a.orderLinkId) ?? 0))
      const left: Record<Side, number> = {
        Buy: this.netFor(positions, symbol, 'Buy'),
        Sell: this.netFor(positions, symbol, 'Sell'),
      }
      for (const order of entries) {
        const ticket = ticketFromEntryLinkId(order.orderLinkId)
        if (!ticket || st.legs.has(ticket)) continue
        const side: Side = String(order.side ?? '') === 'Buy' ? 'Buy' : 'Sell'
        const remaining = (finite(order.cumExecQty) ?? 0) - (closedQty.get(ticket) ?? 0)
        const take = Math.min(remaining, left[side])
        if (!(take > 0)) continue
        left[side] -= take
        const idx = finite(order.positionIdx)
        const leg: Leg = {
          ticket,
          kind: 'position',
          symbol,
          side,
          positionIdx: idx === 1 || idx === 2 ? idx : 0,
          qty: take,
          entryPrice: finite(order.avgPrice) ?? 0,
          comment: commentFromOrderLinkId(order.orderLinkId),
          orderId: String(order.orderId ?? ''),
          openedAt: finite(order.createdTime) ?? this.now(),
        }
        for (const row of stops) {
          const link = String(row.orderLinkId ?? '')
          const orderId = String(row.orderId ?? '')
          const trigger = positive(finite(row.triggerPrice))
          if (ticketFromChildLinkId(link, SL_PREFIX) === ticket) {
            leg.slOrderId = orderId
            leg.stopLoss = trigger
          } else if (ticketFromChildLinkId(link, TP_PREFIX) === ticket) {
            leg.tpOrderId = orderId
            leg.takeProfit = trigger
          }
        }
        st.legs.set(ticket, leg)
      }
    }
    try {
      for (const order of await this.openOrders(st, 'Order')) {
        const ticket = ticketFromEntryLinkId(order.orderLinkId)
        if (!ticket || order.reduceOnly === true || st.legs.has(ticket)) continue
        const idx = finite(order.positionIdx)
        st.legs.set(ticket, {
          ticket,
          kind: 'pending',
          symbol: String(order.symbol ?? ''),
          side: String(order.side ?? '') === 'Buy' ? 'Buy' : 'Sell',
          positionIdx: idx === 1 || idx === 2 ? idx : 0,
          qty: finite(order.qty) ?? 0,
          entryPrice: finite(order.price) ?? 0,
          comment: commentFromOrderLinkId(order.orderLinkId),
          orderId: String(order.orderId ?? ''),
          openedAt: finite(order.createdTime) ?? this.now(),
        })
      }
    } catch {
      // Pending rows are optional.
    }
    st.hydrated = true
  }

  /**
   * Reconcile our legs with Bybit: drop legs whose position is gone or whose
   * protective order fired (cancelling the surviving partner), and trim quantities
   * to what the position still holds.
   */
  private async sync(st: AccountState): Promise<void> {
    const positions = await this.positions(st)
    if (!st.hydrated) await this.hydrate(st, positions)
    const stops = await this.openOrders(st, 'StopOrder').catch(() => null)
    const liveStops = stops ? new Set(stops.map(row => String(row.orderId ?? '')).filter(Boolean)) : null

    if (liveStops) {
      for (const leg of [...st.legs.values()]) {
        if (leg.kind !== 'position') continue
        const slGone = leg.slOrderId != null && !liveStops.has(leg.slOrderId)
        const tpGone = leg.tpOrderId != null && !liveStops.has(leg.tpOrderId)
        if (!slGone && !tpGone) continue
        // One of the pair fired. Cancel the partner so it cannot reduce another leg.
        await this.cancelProtection(st, leg).catch(() => undefined)
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
          st.legs.delete(leg.ticket)
          continue
        }
        leg.qty = Number(take.toFixed(10))
        left = Number((left - take).toFixed(10))
      }
    }

    // Pending limit orders that filled or were cancelled leave the book.
    const pending = [...st.legs.values()].filter(leg => leg.kind === 'pending')
    if (pending.length > 0) {
      try {
        const open = new Set((await this.openOrders(st, 'Order')).map(row => String(row.orderId ?? '')).filter(Boolean))
        for (const leg of pending) if (!leg.orderId || !open.has(leg.orderId)) st.legs.delete(leg.ticket)
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
    if (!found) throw new Error(`Bybit order ${ticket} was not found`)
    return found
  }
}

export function createBybitProvider(options?: BybitProviderOptions): BybitProvider {
  return new BybitProvider(options)
}

let singleton: BybitProvider | undefined

export function getBybitProvider(): BybitProvider {
  if (!singleton) {
    singleton = new BybitProvider({
      loadCredentials: async accountId => {
        const { loadBybitCredential } = await import('./bybit/credentials')
        return loadBybitCredential(accountId)
      },
    })
  }
  return singleton
}
