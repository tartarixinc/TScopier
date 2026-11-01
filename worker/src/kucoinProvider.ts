/**
 * KuCoin Futures (classic account, USDT/USDC linear perpetuals) as a BrokerProvider.
 *
 * Mirrors BybitProvider and BinanceProvider. Each copied order is sized from margin x leverage
 * in whole lots, entry is a market or limit order, and every signal leg carries its own stop
 * loss and take profit as reduce-only stop orders tagged with the leg ticket in `clientOid`
 * (`TSL_<ticket>_<nonce>` / `TST_<ticket>_<nonce>`). KuCoin allows 200 stop orders per contract.
 *
 * Margin mode (isolated or cross) comes from the account settings and is applied to the symbol
 * before an order; KuCoin refuses the switch while that symbol has a position or open orders.
 * Isolated orders carry the leverage on the order, cross leverage is set per symbol.
 *
 * Quantities leaving this provider are base-asset units (lots x multiplier) so the rest of the
 * app sees the same shape as the other crypto brokers. Inside, legs count whole lots.
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
import type { BrokerAccountMode } from './copyShared/brokerAccountMode'
import { noteObservedClose, observedCloseRows, type ObservedClose } from './copyShared/observedCloses'
import {
  KucoinApiError,
  KucoinClient,
  type KucoinCredential,
} from './kucoin/client'
import {
  CLOSE_PREFIX,
  KucoinSizingError,
  SL_PREFIX,
  TICKET_EPOCH_MS,
  TP_PREFIX,
  baseToLots,
  childOrderLinkId,
  commentFromOrderLinkId,
  copierOrderLinkId,
  formatPrice,
  hashOrderId,
  isCopierLinkId,
  lotsToBase,
  parseContracts,
  resolveKucoinSymbol,
  sizeKucoinPosition,
  ticketFromChildLinkId,
  ticketFromEntryLinkId,
  type KucoinContract,
} from './kucoin/symbols'

export type { KucoinCredential } from './kucoin/client'

export interface KucoinProviderOptions {
  loadCredentials?: (accountId: string) => Promise<KucoinCredential | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type Side = 'Buy' | 'Sell'
type PositionSide = 'BOTH' | 'LONG' | 'SHORT'
type MarginMode = 'ISOLATED' | 'CROSS'

type Leg = {
  ticket: number
  kind: 'position' | 'pending'
  symbol: string
  side: Side
  positionSide: PositionSide
  marginMode: MarginMode
  /** Whole lots. */
  lots: number
  /** Base-asset units per lot. */
  multiplier: number
  entryPrice: number
  comment: string
  /** Entry order id, needed to cancel a pending limit. */
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
  /** Whole lots. */
  lots: number
  entryPrice: number
  markPrice: number
}

type AccountState = {
  accountId: string
  credential: KucoinCredential
  loadedAt: number
  client: KucoinClient
  legs: Map<number, Leg>
  /** Positions watched disappearing from the book — see `noteClosedPosition`. */
  closed: ObservedClose[]
  hydrated: boolean
  /** Symbols whose margin mode and leverage we already applied, keyed `symbol:mode:leverage`. */
  applied: Set<string>
  hedge?: { value: boolean; at: number }
}

const CREDENTIAL_TTL_MS = 30_000
const CONTRACTS_TTL_MS = 10 * 60_000
const HEDGE_TTL_MS = 60_000
const HISTORY_WEEKS = 4
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const PAGE_SIZE = 200
const SETTLE_CURRENCIES = ['USDT', 'USDC'] as const

/** `100004`: order is not in a cancelable state. `400100` also answers "order does not exist". */
const BENIGN_CANCEL_CODES = new Set([100004])
const AUTH_CODES = new Set([400001, 400003, 400004, 400005, 400006, 400007, 411100])
/** `330011`: the position mode was never chosen on this account. */
const POSITION_MODE_NOT_SET = 330011

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

function round(value: number): number {
  return Number(value.toFixed(10))
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

function apiSide(side: Side): 'buy' | 'sell' {
  return side === 'Buy' ? 'buy' : 'sell'
}

/** Time fields come as milliseconds, but fills report nanoseconds. */
function epochMs(value: unknown): number | undefined {
  const n = finite(value)
  if (n == null || n <= 0) return undefined
  if (n > 1e17) return Math.round(n / 1e6)
  if (n > 1e14) return Math.round(n / 1e3)
  return n
}

export class KucoinProvider implements BrokerProvider {
  readonly name = 'kucoin' as const
  private readonly states = new Map<string, AccountState>()
  private contractCache: { at: number; contracts: Map<string, KucoinContract> } | null = null
  private readonly loadCredentials?: (accountId: string) => Promise<KucoinCredential | null>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private lastTicket = 0

  constructor(options: KucoinProviderOptions = {}) {
    this.loadCredentials = options.loadCredentials
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  seedPlatformCache(_id: string, _platform: MtPlatform | string | null | undefined): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return { id, platform: 'KuCoin', status: status.broker?.connected ? 'connected' : 'disconnected', error: '' }
    } catch (error) {
      return {
        id,
        platform: 'KuCoin',
        status: 'error',
        error: error instanceof Error ? error.message : 'KuCoin status failed',
      }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('KuCoin accounts connect with an API key')
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
      if (error instanceof KucoinApiError && ((error.code != null && AUTH_CODES.has(error.code)) || error.status === 401)) {
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
   * Account-wide position mode (1 = hedge, 0 = one-way). Read directly rather
   * than through `hedgeMode`, whose error fallback reports one-way: a failed
   * call must stay "unknown" instead of being persisted as the wrong mode.
   */
  async accountMode(id: string): Promise<BrokerAccountMode | null> {
    const st = await this.state(id)
    const result = asRecord(await st.client.signed('GET', '/api/v2/position/getPositionMode'))
    const raw = result.positionMode
    if (raw == null || raw === '') return null
    const mode = Number(raw)
    if (!Number.isFinite(mode)) return null
    return mode === 1 ? 'hedging' : 'netting'
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
      return this.netFor(positions, symbol, side === 'buy' ? 'Buy' : 'Sell') > 0
    } catch {
      return null
    }
  }


  // ── Orders ──────────────────────────────────────────────────────────────

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const contract = await this.contractFor(args.symbol)
    const side = sideOf(args.operation)
    const market = args.operation === 'Buy' || args.operation === 'Sell'
    const limit = args.operation === 'BuyLimit' || args.operation === 'SellLimit'
    if (!market && !limit) throw new Error(`KuCoin futures does not support ${args.operation} orders`)

    let referencePrice: number
    if (limit) {
      referencePrice = Number(args.price)
      if (!(referencePrice > 0)) throw new Error('KuCoin limit order is missing a price')
    } else {
      const book = await this.book(st, contract.symbol)
      referencePrice = side === 'Buy' ? book.ask : book.bid
    }

    let lots: number
    try {
      lots = sizeKucoinPosition({
        marginUsdt: st.credential.marginUsdt,
        leverage: st.credential.leverage,
        price: referencePrice,
        contract,
        kind: limit ? 'limit' : 'market',
      })
    } catch (error) {
      if (error instanceof KucoinSizingError) throw new Error(error.message)
      throw error
    }

    const marginMode = await this.prepareSymbol(st, contract)
    const ticket = this.nextTicket()
    const clientOid = copierOrderLinkId(args.comment, ticket)
    const comment = commentFromOrderLinkId(clientOid)

    let positionSide = await this.positionSideFor(st, side)
    const place = () => this.createOrder(st, {
      clientOid,
      symbol: contract.symbol,
      side: apiSide(side),
      type: market ? 'market' : 'limit',
      size: lots,
      price: limit ? formatPrice(referencePrice, contract) : undefined,
      timeInForce: limit ? 'GTC' : undefined,
      marginMode,
      leverage: marginMode === 'ISOLATED' ? st.credential.leverage : undefined,
      positionSide: positionSide === 'BOTH' ? undefined : positionSide,
    })
    let orderId: string
    try {
      orderId = await place()
    } catch (error) {
      if (!(error instanceof KucoinApiError) || error.code !== POSITION_MODE_NOT_SET) throw error
      // A fresh account has to pick a position mode once. One-way matches how copied legs are tracked.
      await st.client.signed('POST', '/api/v2/position/switchPositionMode', { positionMode: '0' })
      st.hedge = { value: false, at: this.now() }
      positionSide = 'BOTH'
      orderId = await place()
    }

    if (limit) {
      st.legs.set(ticket, {
        ticket,
        kind: 'pending',
        symbol: contract.symbol,
        side,
        positionSide,
        marginMode,
        lots,
        multiplier: contract.multiplier,
        entryPrice: referencePrice,
        comment,
        orderId,
        openedAt: this.now(),
      })
      return {
        ticket,
        orderTicket: ticket,
        openPrice: referencePrice,
        lots: lotsToBase(lots, contract),
        symbol: contract.symbol,
        state: 'Placed',
        comment,
      }
    }

    const filled = await this.fillOf(st, contract, orderId)
    if (filled.dead) {
      throw new Error(`KuCoin did not fill the ${side} market order for ${contract.symbol}${filled.reason ? `: ${filled.reason}` : ''}`)
    }
    const leg: Leg = {
      ticket,
      kind: 'position',
      symbol: contract.symbol,
      side,
      positionSide,
      marginMode,
      lots: filled.lots > 0 ? filled.lots : lots,
      multiplier: contract.multiplier,
      entryPrice: filled.price > 0 ? filled.price : referencePrice,
      comment,
      orderId,
      openedAt: this.now(),
    }
    st.legs.set(ticket, leg)

    const stopLoss = positive(finite(args.stoploss))
    const takeProfit = positive(finite(args.takeprofit))
    if (stopLoss != null || takeProfit != null) {
      await this.protect(st, leg, contract, stopLoss, takeProfit, true)
    }
    return {
      ticket,
      positionTicket: ticket,
      orderTicket: ticket,
      openPrice: leg.entryPrice,
      stopLoss: leg.stopLoss,
      takeProfit: leg.takeProfit,
      lots: lotsToBase(leg.lots, contract),
      symbol: contract.symbol,
      comment: leg.comment,
    }
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const leg = await this.resolveLeg(st, args.ticket)
    const contract = await this.contractFor(leg.symbol)
    if (leg.kind === 'pending') {
      const price = Number(args.price)
      if (price > 0 && Math.abs(price - leg.entryPrice) > 0) {
        // The classic futures API has no amend call, and a cancelled client order id cannot be reused.
        throw new Error('KuCoin futures cannot change the price of a pending order. Cancel it and send a new one.')
      }
      return {
        ticket: leg.ticket,
        orderTicket: leg.ticket,
        openPrice: leg.entryPrice,
        lots: lotsToBase(leg.lots, contract),
        symbol: leg.symbol,
        state: 'Placed',
      }
    }
    const wantSl = args.stoploss === undefined ? undefined : (Number(args.stoploss) > 0 ? Number(args.stoploss) : 0)
    const wantTp = args.takeprofit === undefined ? undefined : (Number(args.takeprofit) > 0 ? Number(args.takeprofit) : 0)
    await this.protect(st, leg, contract, wantSl, wantTp, false)
    return {
      ticket: leg.ticket,
      positionTicket: leg.ticket,
      openPrice: leg.entryPrice,
      stopLoss: leg.stopLoss,
      takeProfit: leg.takeProfit,
      lots: lotsToBase(leg.lots, contract),
      symbol: leg.symbol,
    }
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const leg = await this.resolveLeg(st, args.ticket)
    const contract = await this.contractFor(leg.symbol)
    if (leg.kind === 'pending') {
      await this.cancelOrder(leg.orderId, st)
      st.legs.delete(leg.ticket)
      return {
        ticket: leg.ticket,
        orderTicket: leg.ticket,
        symbol: leg.symbol,
        lots: lotsToBase(leg.lots, contract),
        state: 'position_closed',
      }
    }
    const wantedLots = args.lots != null && args.lots > 0
      ? Math.min(Math.max(1, baseToLots(args.lots, contract)), leg.lots)
      : leg.lots
    const full = wantedLots >= leg.lots
    const lots = full ? leg.lots : wantedLots
    const closeId = await this.createOrder(st, {
      clientOid: childOrderLinkId(CLOSE_PREFIX, leg.ticket, nonce()),
      symbol: leg.symbol,
      side: apiSide(exitSideOf(leg.side)),
      type: 'market',
      size: lots,
      reduceOnly: true,
      marginMode: leg.marginMode,
      positionSide: leg.positionSide === 'BOTH' ? undefined : leg.positionSide,
    })
    const fill = await this.fillOf(st, contract, closeId)
    if (fill.dead) {
      throw new Error(`KuCoin did not fill the close order for ${leg.symbol}${fill.reason ? `: ${fill.reason}` : ''}`)
    }
    const closedLots = fill.lots > 0 ? fill.lots : lots
    const realized = await this.realizedFor(st, contract, leg, closeId, closedLots, fill.price)

    if (full) {
      await this.cancelProtection(st, leg)
      st.legs.delete(leg.ticket)
    } else {
      leg.lots = Math.max(0, leg.lots - closedLots)
      if (leg.stopLoss != null || leg.takeProfit != null) {
        await this.protect(st, leg, contract, leg.stopLoss ?? 0, leg.takeProfit ?? 0, false, true)
      }
    }
    return {
      ticket: leg.ticket,
      positionTicket: leg.ticket,
      closePrice: positive(fill.price),
      lots: lotsToBase(closedLots, contract),
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
      .map(leg => {
        const lots = lotsToBase(leg.lots, leg)
        return {
          ticket: leg.ticket,
          positionTicket: leg.kind === 'position' ? leg.ticket : undefined,
          orderTicket: leg.ticket,
          symbol: leg.symbol,
          operation: operationOf(leg),
          lots,
          volume: lots,
          openPrice: positive(leg.entryPrice),
          stopLoss: leg.stopLoss,
          takeProfit: leg.takeProfit,
          comment: leg.comment,
          ...(leg.kind === 'pending' ? { state: 'Placed' } : {}),
        }
      })
  }

  async closedOrders(id: string): Promise<unknown[]> {
    const to = new Date(this.now())
    const from = new Date(to.getTime() - WEEK_MS)
    return this.orderHistory(id, from.toISOString(), to.toISOString())
  }

  /**
   * Closed positions come from `history-positions`, which carries realized PnL and fees per
   * position. It has no size, so closing lots are summed from fills, and the copier comment
   * is recovered from the entry order's client id.
   */
  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const st = await this.state(id)
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    const end = Number.isFinite(toMs) ? toMs : this.now()
    const start = Number.isFinite(fromMs) ? fromMs : end - WEEK_MS
    const windows: Array<[number, number]> = []
    for (let upper = end, i = 0; upper > start && i < 5; i += 1) {
      const lower = Math.max(start, upper - WEEK_MS + 1)
      windows.push([lower, upper])
      upper = lower - 1
    }

    const closed: Record<string, unknown>[] = []
    for (const [lower, upper] of windows) {
      closed.push(...await this.listPositionHistory(st, lower, upper))
    }
    if (closed.length === 0) return observedCloseRows(st.closed, start, end)

    const fills: Record<string, unknown>[] = []
    const orderLinks = new Map<string, string>()
    const entries: Array<{ symbol: string; side: string; at: number; clientOid: string }> = []
    for (const [lower, upper] of windows) {
      try {
        fills.push(...await this.listPaged(st, '/api/v1/fills', { startAt: lower - 60_000, endAt: upper + 60_000 }))
      } catch {
        // Rows still show without a size.
      }
    }
    const symbols = [...new Set(closed.map(row => String(row.symbol ?? '')).filter(Boolean))].slice(0, 12)
    for (const symbol of symbols) {
      for (const [lower, upper] of windows) {
        try {
          const orders = await this.listPaged(st, '/api/v1/orders', {
            status: 'done',
            symbol,
            startAt: lower - 60_000,
            endAt: upper + 60_000,
          })
          for (const order of orders) {
            const orderId = String(order.id ?? '')
            const clientOid = String(order.clientOid ?? '')
            if (orderId && clientOid) orderLinks.set(orderId, clientOid)
            if (ticketFromEntryLinkId(clientOid) != null && order.reduceOnly !== true && order.closeOrder !== true) {
              entries.push({
                symbol,
                side: String(order.side ?? ''),
                at: finite(order.createdAt) ?? epochMs(order.orderTime) ?? 0,
                clientOid,
              })
            }
          }
        } catch {
          // Rows still show without comments.
        }
      }
    }

    const contracts = await this.contracts().catch(() => new Map<string, KucoinContract>())
    const rows: Record<string, unknown>[] = closed.map(row => {
      const symbol = String(row.symbol ?? '')
      const type = String(row.type ?? '')
      const longPosition = /LONG/.test(type)
      const openTime = finite(row.openTime) ?? 0
      const closeTime = finite(row.closeTime) ?? 0
      const closingSide = longPosition ? 'sell' : 'buy'
      const closingFills = fills.filter(fill => {
        if (String(fill.symbol ?? '') !== symbol || String(fill.side ?? '') !== closingSide) return false
        const at = epochMs(fill.tradeTime) ?? 0
        return at >= openTime - 1_000 && at <= closeTime + 1_000
      })
      const lots = closingFills.reduce((sum, fill) => sum + (finite(fill.size) ?? 0), 0)
      const multiplier = contracts.get(symbol)?.multiplier ?? 0
      const closeTicketFill = closingFills
        .map(fill => ticketFromChildLinkId(orderLinks.get(String(fill.orderId ?? '')), CLOSE_PREFIX))
        .find(ticket => ticket != null)
      const entryOid = entries
        .filter(entry => entry.symbol === symbol
          && entry.side === (longPosition ? 'buy' : 'sell')
          && entry.at >= openTime - 60_000
          && entry.at <= closeTime)
        .sort((a, b) => a.at - b.at)[0]?.clientOid
      const closeId = String(row.closeId ?? '')
      const ticket = closeTicketFill ?? hashOrderId(closeId || `${symbol}:${closeTime}`)
      return {
        ticket,
        positionTicket: ticket,
        dealTicket: hashOrderId(closeId || `${symbol}:${closeTime}`),
        symbol,
        operation: longPosition ? 'Buy' : 'Sell',
        lots: multiplier > 0 ? lotsToBase(lots, { multiplier }) : lots,
        openPrice: positive(finite(row.openPrice)),
        closePrice: positive(finite(row.closePrice)),
        profit: finite(row.pnl) ?? 0,
        commission: -(finite(row.tradeFee) ?? 0),
        swap: -(finite(row.fundingFee) ?? 0),
        comment: entryOid ? commentFromOrderLinkId(entryOid) : (closeTicketFill ? this.commentForTicket(st, closeTicketFill) : ''),
        // Rows come from history-positions (closed positions only), so `closeTime`
        // is a real close time — history readers need it to confirm a close.
        time: closeTime || undefined,
        closeTime: closeTime || undefined,
      }
    })
    // Positions this worker watched disappear from KuCoin's book, reported
    // under the ticket the copier tracks (see `noteClosedPosition`).
    rows.push(...observedCloseRows(st.closed, start, end))
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
      balance: finite(account.marginBalance),
      equity: finite(account.accountEquity),
      profit: finite(account.unrealisedPNL),
      margin: (finite(account.positionMargin) ?? 0) + (finite(account.orderMargin) ?? 0),
      freeMargin: finite(account.availableBalance),
      leverage: st.credential.leverage,
      currency: 'USDT',
      synced: true,
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const st = await this.state(id)
    const contract = await this.contractFor(symbol)
    const book = await this.book(st, contract.symbol)
    return { symbol: contract.symbol, bid: book.bid, ask: book.ask }
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    await this.state(id)
    const contract = await this.contractFor(symbol)
    const tickText = contract.tickSize > 0 ? contract.tickSize.toString() : ''
    const digits = tickText.includes('.') ? tickText.split('.')[1]!.length : (tickText.includes('e-') ? Number(tickText.split('e-')[1]) : 0)
    const lotSize = contract.lotSize > 0 ? contract.lotSize : 1
    return {
      symbolName: contract.symbol,
      symbol: {
        digits,
        point: contract.tickSize > 0 ? contract.tickSize : undefined,
        contractSize: 1,
      },
      groupParams: {
        minLot: lotsToBase(lotSize, contract),
        maxLot: lotsToBase(contract.maxMarketQty || contract.maxOrderQty, contract) || undefined,
        lotStep: lotsToBase(lotSize, contract),
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    await this.state(id)
    const contracts = await this.contracts()
    return [...contracts.values()]
      .filter(contract => !contract.isInverse && contract.status === 'Open')
      .map(contract => contract.symbol)
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const st = await this.state(id)
    await this.account(id)
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true },
      account: {
        loggedIn: true,
        tradeAllowed: true,
        currency: 'USDT',
        marginMode: st.credential.marginMode,
      },
      bridge: { tradeEaReady: true, symbolsSynced: true },
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
    if (!this.loadCredentials) throw new Error('KuCoin is not configured')
    const credential = await this.loadCredentials(id)
    if (!credential?.apiKey || !credential.apiSecret || !credential.passphrase) throw new Error('KuCoin is not configured')
    if (existing
      && existing.credential.apiKey === credential.apiKey
      && existing.credential.apiSecret === credential.apiSecret
      && existing.credential.passphrase === credential.passphrase) {
      existing.credential = credential
      existing.loadedAt = this.now()
      return existing
    }
    const fresh: AccountState = {
      accountId: id,
      credential,
      loadedAt: this.now(),
      client: new KucoinClient(credential, { fetchImpl: this.fetchImpl, now: this.now }),
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
    return asRecord(await st.client.signed('GET', '/api/v1/account-overview', { currency: 'USDT' }))
  }

  /** Public contract list, cached for every account. */
  private async contracts(): Promise<Map<string, KucoinContract>> {
    if (this.contractCache && this.now() - this.contractCache.at < CONTRACTS_TTL_MS) return this.contractCache.contracts
    const client = new KucoinClient({ apiKey: '', apiSecret: '', passphrase: '' }, { fetchImpl: this.fetchImpl, now: this.now })
    const contracts = parseContracts(await client.publicGet('/api/v1/contracts/active'))
    if (contracts.size === 0) throw new Error('KuCoin did not return any futures contracts')
    this.contractCache = { at: this.now(), contracts }
    return contracts
  }

  private async contractFor(name: string): Promise<KucoinContract> {
    const found = resolveKucoinSymbol(name, await this.contracts())
    if (!found) throw new Error(`Symbol ${name} is not available on KuCoin futures`)
    return found
  }

  private async book(st: AccountState, symbol: string): Promise<{ bid: number; ask: number }> {
    const row = asRecord(await st.client.publicGet('/api/v1/ticker', { symbol }))
    const bid = finite(row.bestBidPrice)
    const ask = finite(row.bestAskPrice)
    if (!bid || !ask) throw new Error(`KuCoin quote for ${symbol} is unavailable`)
    return { bid, ask }
  }

  /** Account-wide: 1 is hedge mode, 0 is one-way. An account that never chose one reads as one-way. */
  private async hedgeMode(st: AccountState): Promise<boolean> {
    if (st.hedge && this.now() - st.hedge.at < HEDGE_TTL_MS) return st.hedge.value
    let value = false
    try {
      const result = asRecord(await st.client.signed('GET', '/api/v2/position/getPositionMode'))
      value = Number(result.positionMode) === 1
    } catch {
      value = false
    }
    st.hedge = { value, at: this.now() }
    return value
  }

  private async positionSideFor(st: AccountState, side: Side): Promise<PositionSide> {
    if (!(await this.hedgeMode(st))) return 'BOTH'
    return side === 'Buy' ? 'LONG' : 'SHORT'
  }

  /**
   * Apply the account's margin mode (and cross leverage) to the symbol before an order.
   * Returns the mode the order must carry. KuCoin refuses a mode switch while the symbol has
   * a position or open orders; in that case the existing mode is kept when it cannot change.
   */
  private async prepareSymbol(st: AccountState, contract: KucoinContract): Promise<MarginMode> {
    const { leverage, marginMode } = st.credential
    const wanted: MarginMode = marginMode === 'cross' ? 'CROSS' : 'ISOLATED'
    if (wanted === 'CROSS' && !contract.supportCross) {
      throw new Error(`${contract.symbol} does not support cross margin on KuCoin. Switch the account to isolated margin.`)
    }
    const key = `${contract.symbol}:${wanted}:${leverage}`
    if (st.applied.has(key)) return wanted

    let current: MarginMode | null = null
    try {
      const result = asRecord(await st.client.signed('GET', '/api/v2/position/getMarginMode', { symbol: contract.symbol }))
      current = String(result.marginMode ?? '').toUpperCase() === 'CROSS' ? 'CROSS' : 'ISOLATED'
    } catch {
      current = null
    }
    if (current !== wanted) {
      try {
        await st.client.signed('POST', '/api/v2/position/changeMarginMode', { symbol: contract.symbol, marginMode: wanted })
      } catch (error) {
        throw new Error(
          `KuCoin would not switch ${contract.symbol} to ${wanted.toLowerCase()} margin. Close its open positions and orders first: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    if (wanted === 'CROSS') {
      try {
        await st.client.signed('POST', '/api/v2/changeCrossUserLeverage', { symbol: contract.symbol, leverage: String(leverage) })
      } catch (error) {
        throw new Error(`KuCoin rejected ${leverage}x cross leverage for ${contract.symbol}: ${error instanceof Error ? error.message : error}`)
      }
    }
    st.applied.add(key)
    return wanted
  }

  private async createOrder(st: AccountState, params: Record<string, string | number | boolean | undefined>): Promise<string> {
    const placed = asRecord(await st.client.signed('POST', '/api/v1/orders', params))
    const orderId = String(placed.orderId ?? '')
    if (!orderId) throw new Error('KuCoin did not return an order id')
    return orderId
  }

  /**
   * Orders settle asynchronously. Read the order back until it reports a fill or a terminal
   * state. `dead` means it ended with nothing filled.
   */
  private async fillOf(
    st: AccountState,
    contract: KucoinContract,
    orderId: string,
  ): Promise<{ lots: number; price: number; dead: boolean; reason?: string }> {
    let lots = 0
    let price = 0
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const order = asRecord(await st.client.signed('GET', `/api/v1/orders/${encodeURIComponent(orderId)}`))
        lots = finite(order.filledSize) ?? finite(order.dealSize) ?? 0
        price = finite(order.avgDealPrice) ?? 0
        if (!(price > 0) && lots > 0) {
          const value = finite(order.filledValue) ?? finite(order.dealValue) ?? 0
          price = value > 0 ? value / (lots * contract.multiplier) : 0
        }
        const done = String(order.status ?? '') === 'done' || order.isActive === false
        if (lots > 0 && done) return { lots, price, dead: false }
        if (done && lots <= 0) {
          return { lots: 0, price: 0, dead: true, reason: String(order.remark || (order.cancelExist ? 'cancelled' : 'not filled')) }
        }
      } catch {
        // Keep waiting for the order to settle.
      }
      if (attempt < 4) await this.sleep(250)
    }
    return { lots, price, dead: false }
  }

  /**
   * Profit and fees for a close. KuCoin reports realized PnL per position, not per order, so
   * the gross profit is computed from this leg's entry price and the close fills; fees come
   * from the fills themselves.
   */
  private async realizedFor(
    st: AccountState,
    contract: KucoinContract,
    leg: Leg,
    orderId: string,
    lots: number,
    price: number,
  ): Promise<{ profit?: number; commission?: number }> {
    let commission: number | undefined
    let fillPrice = price
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const rows = (await this.listPaged(st, '/api/v1/fills', { orderId, symbol: leg.symbol }, 1))
          .filter(row => String(row.orderId ?? '') === orderId)
        if (rows.length > 0) {
          let fees = 0
          let value = 0
          let size = 0
          for (const row of rows) {
            fees += finite(row.fee) ?? ((finite(row.openFeePay) ?? 0) + (finite(row.closeFeePay) ?? 0))
            const rowSize = finite(row.size) ?? 0
            value += (finite(row.price) ?? 0) * rowSize
            size += rowSize
          }
          commission = -Math.round(fees * 1e8) / 1e8
          if (size > 0 && value > 0) fillPrice = value / size
          break
        }
      } catch {
        break
      }
      if (attempt < 2) await this.sleep(300)
    }
    let profit: number | undefined
    if (fillPrice > 0 && leg.entryPrice > 0) {
      const direction = leg.side === 'Buy' ? 1 : -1
      profit = Math.round((fillPrice - leg.entryPrice) * direction * lots * contract.multiplier * 1e8) / 1e8
    }
    return { profit, commission }
  }

  private commentForTicket(st: AccountState, ticket: number): string {
    return st.legs.get(ticket)?.comment ?? ''
  }

  /** Page-numbered lists (`currentPage` / `pageSize`) return `{ items, totalPage }`. */
  private async listPaged(
    st: AccountState,
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    maxPages = 5,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    for (let page = 1; page <= maxPages; page += 1) {
      const result = asRecord(await st.client.signed('GET', path, { ...params, currentPage: page, pageSize: PAGE_SIZE }))
      rows.push(...asRows(result.items))
      const totalPage = finite(result.totalPage) ?? 1
      if (page >= totalPage) break
    }
    return rows
  }

  private async listPositionHistory(st: AccountState, from: number, to: number): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    for (let page = 1; page <= 5; page += 1) {
      const result = asRecord(await st.client.signed('GET', '/api/v1/history-positions', { from, to, limit: PAGE_SIZE, pageId: page }))
      rows.push(...asRows(result.items))
      const totalPage = finite(result.totalPage) ?? 1
      if (page >= totalPage) break
    }
    return rows
  }

  private async cancelOrder(orderId: string | undefined, st: AccountState): Promise<void> {
    if (!orderId) return
    try {
      await st.client.signed('DELETE', `/api/v1/orders/${encodeURIComponent(orderId)}`)
    } catch (error) {
      // Already triggered, filled or cancelled.
      if (error instanceof KucoinApiError && error.code != null && BENIGN_CANCEL_CODES.has(error.code)) return
      throw error
    }
  }

  // ── Stops ───────────────────────────────────────────────────────────────

  /** Untriggered stop orders across every contract. */
  private async openStops(st: AccountState): Promise<Record<string, unknown>[]> {
    return (await this.listPaged(st, '/api/v1/stopOrders', {})).filter(row => row.stopTriggered !== true)
  }

  /** Resting limit orders (stops are listed separately). */
  private async openLimits(st: AccountState): Promise<Record<string, unknown>[]> {
    return (await this.listPaged(st, '/api/v1/orders', { status: 'active' }))
      .filter(row => !row.stop && row.reduceOnly !== true && row.closeOrder !== true)
  }

  private async cancelProtection(st: AccountState, leg: Leg): Promise<void> {
    const ids = new Set<string>()
    if (leg.slOrderId) ids.add(leg.slOrderId)
    if (leg.tpOrderId) ids.add(leg.tpOrderId)
    try {
      for (const row of await this.openStops(st)) {
        const clientOid = String(row.clientOid ?? '')
        const orderId = String(row.id ?? '')
        if (orderId && (ticketFromChildLinkId(clientOid, SL_PREFIX) === leg.ticket || ticketFromChildLinkId(clientOid, TP_PREFIX) === leg.ticket)) {
          ids.add(orderId)
        }
      }
    } catch {
      // Fall back to the ids we already know.
    }
    for (const orderId of ids) await this.cancelOrder(orderId, st)
    leg.slOrderId = undefined
    leg.tpOrderId = undefined
  }

  /**
   * Set or replace a leg's stop loss and take profit. A value of 0 removes it,
   * undefined leaves it alone. Each is a reduce-only stop market order triggered on the
   * mark price, tagged with the leg ticket.
   */
  private async protect(
    st: AccountState,
    leg: Leg,
    contract: KucoinContract,
    stopLoss: number | undefined,
    takeProfit: number | undefined,
    closeOnStopFailure: boolean,
    rebuild = false,
  ): Promise<void> {
    const exitSide = exitSideOf(leg.side)
    const place = async (kind: 'sl' | 'tp', price: number): Promise<string> => {
      // `down` fires when the price falls to the trigger, `up` when it rises.
      const longExit = exitSide === 'Sell'
      const stop = kind === 'sl' ? (longExit ? 'down' : 'up') : (longExit ? 'up' : 'down')
      return this.createOrder(st, {
        clientOid: childOrderLinkId(kind === 'sl' ? SL_PREFIX : TP_PREFIX, leg.ticket, nonce()),
        symbol: leg.symbol,
        side: apiSide(exitSide),
        type: 'market',
        size: leg.lots,
        stop,
        stopPriceType: 'MP',
        stopPrice: formatPrice(price, contract),
        reduceOnly: true,
        marginMode: leg.marginMode,
        positionSide: leg.positionSide === 'BOTH' ? undefined : leg.positionSide,
      })
    }

    if (stopLoss !== undefined || rebuild) {
      const target = stopLoss ?? leg.stopLoss ?? 0
      await this.cancelOrder(leg.slOrderId, st)
      leg.slOrderId = undefined
      leg.stopLoss = undefined
      if (target > 0) {
        try {
          leg.slOrderId = await place('sl', target)
          leg.stopLoss = target
        } catch (error) {
          if (!closeOnStopFailure) throw error
          await this.emergencyClose(st, leg)
          throw new Error(
            `KuCoin rejected the stop loss for ${leg.symbol}, so the position was closed: ${error instanceof Error ? error.message : error}`,
          )
        }
      }
    }
    if (takeProfit !== undefined || rebuild) {
      const target = takeProfit ?? leg.takeProfit ?? 0
      await this.cancelOrder(leg.tpOrderId, st)
      leg.tpOrderId = undefined
      leg.takeProfit = undefined
      if (target > 0) {
        try {
          leg.tpOrderId = await place('tp', target)
          leg.takeProfit = target
        } catch (error) {
          if (!closeOnStopFailure) throw error
          console.warn(`[kucoin] take profit rejected for ${leg.symbol}: ${error instanceof Error ? error.message : error}`)
        }
      }
    }
  }

  /** The stop could not be placed. Do not leave a leveraged position unprotected. */
  private async emergencyClose(st: AccountState, leg: Leg): Promise<void> {
    try {
      await this.createOrder(st, {
        clientOid: childOrderLinkId(CLOSE_PREFIX, leg.ticket, nonce()),
        symbol: leg.symbol,
        side: apiSide(exitSideOf(leg.side)),
        type: 'market',
        size: leg.lots,
        reduceOnly: true,
        marginMode: leg.marginMode,
        positionSide: leg.positionSide === 'BOTH' ? undefined : leg.positionSide,
      })
    } finally {
      await this.cancelProtection(st, leg)
      st.legs.delete(leg.ticket)
    }
  }

  // ── Leg book ────────────────────────────────────────────────────────────

  private async positions(st: AccountState): Promise<PositionRow[]> {
    const out: PositionRow[] = []
    const result = await st.client.signed('GET', '/api/v1/positions')
    for (const row of asRows(result)) {
      const symbol = String(row.symbol ?? '')
      const quantity = finite(row.currentQty) ?? 0
      const lots = Math.abs(quantity)
      if (!symbol || lots <= 0 || row.isOpen === false) continue
      const positionSide = String(row.positionSide ?? 'BOTH')
      const side: Side = positionSide === 'LONG' ? 'Buy' : positionSide === 'SHORT' ? 'Sell' : (quantity > 0 ? 'Buy' : 'Sell')
      out.push({
        symbol,
        side,
        lots,
        entryPrice: finite(row.avgEntryPrice) ?? 0,
        markPrice: finite(row.markPrice) ?? 0,
      })
    }
    return out
  }

  private netFor(positions: PositionRow[], symbol: string, side: Side): number {
    let net = 0
    for (const row of positions) if (row.symbol === symbol && row.side === side) net += row.lots
    return net
  }

  /** Finished orders for a symbol across the last few weeks (the API allows seven days per request). */
  private async historyOrders(st: AccountState, symbol: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = []
    const end = this.now()
    for (let week = 0; week < HISTORY_WEEKS; week += 1) {
      const upper = end - week * WEEK_MS
      const lower = upper - WEEK_MS + 1
      rows.push(...await this.listPaged(st, '/api/v1/orders', { status: 'done', symbol, startAt: lower, endAt: upper }))
    }
    return rows
  }

  /** Rebuild this account's copier legs from KuCoin after a restart. */
  private async hydrate(st: AccountState, positions: PositionRow[]): Promise<void> {
    const stops = await this.openStops(st).catch(() => [] as Record<string, unknown>[])
    const contracts = await this.contracts().catch(() => new Map<string, KucoinContract>())
    const symbols = [...new Set(positions.map(row => row.symbol))]
    for (const symbol of symbols) {
      let orders: Record<string, unknown>[] = []
      try {
        orders = await this.historyOrders(st, symbol)
      } catch {
        continue
      }
      const multiplier = contracts.get(symbol)?.multiplier ?? 1
      const closedLots = new Map<number, number>()
      for (const order of orders) {
        const clientOid = order.clientOid
        const ticket = ticketFromChildLinkId(clientOid, CLOSE_PREFIX)
          ?? ticketFromChildLinkId(clientOid, SL_PREFIX)
          ?? ticketFromChildLinkId(clientOid, TP_PREFIX)
        if (ticket) closedLots.set(ticket, (closedLots.get(ticket) ?? 0) + (finite(order.filledSize) ?? 0))
      }
      const entries = orders
        .filter(order => isCopierLinkId(order.clientOid)
          && ticketFromEntryLinkId(order.clientOid) != null
          && order.reduceOnly !== true
          && order.closeOrder !== true
          && (finite(order.filledSize) ?? 0) > 0)
        .sort((a, b) => (ticketFromEntryLinkId(b.clientOid) ?? 0) - (ticketFromEntryLinkId(a.clientOid) ?? 0))
      const left: Record<Side, number> = {
        Buy: this.netFor(positions, symbol, 'Buy'),
        Sell: this.netFor(positions, symbol, 'Sell'),
      }
      for (const order of entries) {
        const ticket = ticketFromEntryLinkId(order.clientOid)
        if (!ticket || st.legs.has(ticket)) continue
        const side: Side = String(order.side ?? '') === 'buy' ? 'Buy' : 'Sell'
        const remaining = (finite(order.filledSize) ?? 0) - (closedLots.get(ticket) ?? 0)
        const take = Math.min(remaining, left[side])
        if (!(take > 0)) continue
        left[side] = round(left[side] - take)
        const positionSide = String(order.positionSide ?? 'BOTH')
        const leg: Leg = {
          ticket,
          kind: 'position',
          symbol,
          side,
          positionSide: positionSide === 'LONG' || positionSide === 'SHORT' ? positionSide : 'BOTH',
          marginMode: String(order.marginMode ?? '').toUpperCase() === 'CROSS' ? 'CROSS' : 'ISOLATED',
          lots: take,
          multiplier,
          entryPrice: finite(order.avgDealPrice) ?? 0,
          comment: commentFromOrderLinkId(order.clientOid),
          orderId: String(order.id ?? ''),
          openedAt: finite(order.createdAt) ?? this.now(),
        }
        for (const row of stops) {
          const clientOid = String(row.clientOid ?? '')
          const orderId = String(row.id ?? '')
          const trigger = positive(finite(row.stopPrice))
          if (ticketFromChildLinkId(clientOid, SL_PREFIX) === ticket) {
            leg.slOrderId = orderId
            leg.stopLoss = trigger
          } else if (ticketFromChildLinkId(clientOid, TP_PREFIX) === ticket) {
            leg.tpOrderId = orderId
            leg.takeProfit = trigger
          }
        }
        st.legs.set(ticket, leg)
      }
    }
    try {
      for (const order of await this.openLimits(st)) {
        const ticket = ticketFromEntryLinkId(order.clientOid)
        if (!ticket || st.legs.has(ticket)) continue
        const symbol = String(order.symbol ?? '')
        const positionSide = String(order.positionSide ?? 'BOTH')
        st.legs.set(ticket, {
          ticket,
          kind: 'pending',
          symbol,
          side: String(order.side ?? '') === 'buy' ? 'Buy' : 'Sell',
          positionSide: positionSide === 'LONG' || positionSide === 'SHORT' ? positionSide : 'BOTH',
          marginMode: String(order.marginMode ?? '').toUpperCase() === 'CROSS' ? 'CROSS' : 'ISOLATED',
          lots: finite(order.size) ?? 0,
          multiplier: contracts.get(symbol)?.multiplier ?? 1,
          entryPrice: finite(order.price) ?? 0,
          comment: commentFromOrderLinkId(order.clientOid),
          orderId: String(order.id ?? ''),
          openedAt: finite(order.createdAt) ?? this.now(),
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
   * KuCoin's history-positions rows carry a closing-order id, which is the
   * ticket the copier tracks only when the copier placed that close: a
   * stop-loss, take-profit or manual close never matches the tracked ticket.
   * The mirror engine refuses to close a copy without history confirming the
   * source is gone, so without this the copy would stay open forever. Noting
   * the leg as it leaves the live book lets `orderHistory` answer with the
   * tracked ticket instead — and only when the exchange reports no remaining
   * position, so a protective order that merely disappeared (cancelled, not
   * executed) can never confirm a close that did not happen.
   */
  private noteClosedPosition(st: AccountState, positions: PositionRow[], leg: Leg): void {
    if (leg.kind !== 'position') return
    if (this.netFor(positions, leg.symbol, leg.side) > 0) return
    noteObservedClose(st.closed, {
      ticket: leg.ticket, symbol: leg.symbol, operation: operationOf(leg), lots: leg.lots, at: this.now(),
    })
  }

  /**
   * Reconcile our legs with KuCoin: drop legs whose position is gone or whose protective
   * order fired (cancelling the surviving partner), and trim quantities to what the
   * position still holds.
   */
  private async sync(st: AccountState): Promise<void> {
    const positions = await this.positions(st)
    if (!st.hydrated) await this.hydrate(st, positions)
    const stops = await this.openStops(st).catch(() => null)
    const liveStops = stops ? new Set(stops.map(row => String(row.id ?? '')).filter(Boolean)) : null

    if (liveStops) {
      for (const leg of [...st.legs.values()]) {
        if (leg.kind !== 'position') continue
        const slGone = leg.slOrderId != null && !liveStops.has(leg.slOrderId)
        const tpGone = leg.tpOrderId != null && !liveStops.has(leg.tpOrderId)
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
        const take = Math.min(leg.lots, left)
        if (!(take > 0)) {
          await this.cancelProtection(st, leg).catch(() => undefined)
          this.noteClosedPosition(st, positions, leg)
          st.legs.delete(leg.ticket)
          continue
        }
        leg.lots = round(take)
        left = round(left - take)
      }
    }

    // Pending limit orders that filled or were cancelled leave the book.
    const pending = [...st.legs.values()].filter(leg => leg.kind === 'pending')
    if (pending.length > 0) {
      try {
        const open = new Set((await this.openLimits(st)).map(row => String(row.id ?? '')).filter(Boolean))
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
    if (!found) throw new Error(`KuCoin order ${ticket} was not found`)
    return found
  }
}

export function createKucoinProvider(options?: KucoinProviderOptions): KucoinProvider {
  return new KucoinProvider(options)
}

let singleton: KucoinProvider | undefined

export function getKucoinProvider(): KucoinProvider {
  if (!singleton) {
    singleton = new KucoinProvider({
      loadCredentials: async accountId => {
        const { loadKucoinCredential } = await import('./kucoin/credentials')
        return loadKucoinCredential(accountId)
      },
    })
  }
  return singleton
}
