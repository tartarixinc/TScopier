import type {
  AccountSummary,
  FxsocketMtStatus,
  FxsocketTerminalStatus,
  OrderCloseArgs,
  OrderModifyArgs,
  OrderResult,
  OrderSendArgs,
  QuoteResult,
  SymbolParams,
} from './fxsocketClient'
import type { BrokerProvider } from './brokerProvider'
import {
  TradelockerApiError,
  TradelockerClient,
  finite,
  friendlyTradelockerError,
  type Json,
  type TradelockerClientOptions,
  type TradelockerCredential,
} from './tradelocker/client'
import {
  TradelockerSizingError,
  closedTradesFromHistory,
  commentFromStrategyId,
  entryStrategyId,
  grossProfit,
  isFilledStatus,
  isRejectedStatus,
  matchInstrument,
  oppositeSide,
  orderTypeForOperation,
  roundToTick,
  sideForOperation,
  sizeLots,
  ticketFromId,
  type TradelockerInstrument,
  type TradelockerInstrumentDetails,
} from './tradelocker/symbols'

export type { TradelockerCredential } from './tradelocker/client'

export interface TradelockerProviderOptions {
  loadCredentials?: (accountId: string) => Promise<TradelockerCredential | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  clientOptions?: Pick<TradelockerClientOptions, 'requestTimeoutMs' | 'developerKey'>
}

type AccountState = {
  credential: TradelockerCredential
  client: TradelockerClient
  account: { at: number; currency: string; status: string } | null
  /** Tags whose order may or may not have landed. A repeat of one is reconciled before it is sent again. */
  uncertainTags: Set<string>
  writeChain: Promise<unknown>
}

type Found =
  | { kind: 'position'; id: string; symbol: string; qty: number; side: 'buy' | 'sell' }
  | { kind: 'order'; id: string; row: Json; symbol: string; qty: number; side: 'buy' | 'sell'; type: string }

type Located =
  | { kind: 'position'; positionId: string; orderId: string | undefined; price: number | undefined; qty: number }
  | { kind: 'order'; orderId: string }
  | { kind: 'rejected'; orderId: string; reason: string }

const ACCOUNT_TTL_MS = 20_000
const FILL_POLLS = 6
const FILL_POLL_MS = 300
const DAY_MS = 24 * 60 * 60 * 1000
const GONE = 'no open position or pending order'

function positive(value: number | null | undefined): number | undefined {
  const n = value == null ? undefined : Number(value)
  return n != null && Number.isFinite(n) && n > 0 ? n : undefined
}

function sideOf(value: unknown): 'buy' | 'sell' {
  return String(value ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy'
}

function operationFor(type: string, side: string): string {
  const buy = String(side).toLowerCase() === 'buy'
  const t = type.toLowerCase()
  if (t === 'limit') return buy ? 'BuyLimit' : 'SellLimit'
  if (t === 'stop') return buy ? 'BuyStop' : 'SellStop'
  return buy ? 'Buy' : 'Sell'
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  const n = finite(value)
  const date = new Date(n !== undefined ? n : String(value))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function decimalsOf(step: number | undefined): number {
  if (!step || !(step > 0)) return 5
  const text = String(step)
  if (text.includes('e-')) return Number(text.split('e-')[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

/** An error that keeps the failure it describes. */
function withCause(message: string, cause: unknown): Error {
  const error = new Error(message)
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

function hasId(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text !== '' && text !== '0' && text !== 'null'
}

function rejectReason(row: Json): string {
  const reason = String(row.rejectReason ?? row.errorMessage ?? row.message ?? row.reason ?? '').trim()
  return reason ? `: ${reason}` : ''
}

export class TradelockerProvider implements BrokerProvider {
  readonly name = 'tradelocker' as const
  private readonly states = new Map<string, AccountState>()
  private readonly loading = new Map<string, Promise<AccountState>>()
  private readonly loadCredentials?: (accountId: string) => Promise<TradelockerCredential | null>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly clientOptions: TradelockerProviderOptions['clientOptions']

  constructor(options: TradelockerProviderOptions = {}) {
    this.loadCredentials = options.loadCredentials
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.clientOptions = options.clientOptions
  }

  seedPlatformCache(): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return { id, platform: 'TradeLocker', status: status.broker?.connected ? 'connected' : 'disconnected', error: '' }
    } catch (error) {
      return { id, platform: 'TradeLocker', status: 'error', error: friendlyTradelockerError(error) }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('TradeLocker accounts connect with a stored login')
  }

  async connectByToken(id: string): Promise<void> {
    await this.state(id)
  }

  async ensureConnected(id: string): Promise<void> {
    const st = await this.state(id)
    if (!st.client.hasSession) await st.client.login()
  }

  async checkConnect(id: string): Promise<void> {
    await this.accountInfo(await this.state(id), true)
  }

  async disconnect(id: string): Promise<void> {
    const st = this.states.get(id)
    this.states.delete(id)
    await st?.client.logout()
  }

  async keepSessionAlive(id: string): Promise<boolean> {
    return (await this.keepSessionAliveDetailed(id)) === 'alive'
  }

  async keepSessionAliveDetailed(id: string): Promise<'alive' | 'session_gone' | 'token_reconnect_failed'> {
    try {
      const st = await this.state(id)
      if (st.client.hasSession) await st.client.ping()
      else await st.client.login()
      return 'alive'
    } catch (error) {
      if (error instanceof TradelockerApiError && (error.status === 401 || error.status === 400 || error.status === 403)) {
        this.states.delete(id)
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
    return this.serialize(st, () => this.sendEntry(st, args))
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const st = await this.state(id)
    return this.serialize(st, async () => {
      const attempt = async (cached: boolean): Promise<OrderResult> => {
        const found = await this.findTicket(st, args.ticket, cached)
        const { instrument, details } = await this.instrumentFor(st, found.symbol)
        try {
          if (found.kind === 'position') return await this.modifyPosition(st, found, details, args)
          return await this.modifyPending(st, found, instrument, details, args)
        } catch (error) {
          // A pending order seen in a cached list may have filled since: look again, fresh.
          if (cached && found.kind === 'order' && /not found/i.test(error instanceof Error ? error.message : '')) return attempt(false)
          throw error
        }
      }
      return attempt(true)
    })
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const st = await this.state(id)
    return this.serialize(st, async () => {
      let found = await this.findTicket(st, args.ticket, true)
      // Positions are safe to act on from a recent read; a pending order may have filled, so confirm it fresh.
      if (found.kind === 'order') found = await this.findTicket(st, args.ticket, false)
      if (found.kind === 'order') {
        await st.client.cancelOrder(found.id)
        return {
          ticket: args.ticket,
          orderTicket: args.ticket,
          symbol: found.symbol,
          lots: found.qty,
          state: 'position_closed',
        }
      }

      const { details } = await this.instrumentFor(st, found.symbol)
      let qty = 0
      let closedLots = found.qty
      if (args.lots != null && args.lots > 0) {
        let partial: number
        try {
          partial = sizeLots(args.lots, found.symbol, details)
        } catch (error) {
          if (error instanceof TradelockerSizingError) throw withCause(error.message, error)
          throw error
        }
        if (partial < found.qty * 0.9999) {
          qty = partial
          closedLots = partial
        }
      }

      const startedAt = this.now()
      try {
        await st.client.closePosition(found.id, qty)
      } catch (error) {
        if (!(error instanceof TradelockerApiError) || !error.uncertain) throw error
        // No answer: the close may have landed. Read the position back instead of sending it again.
        const left = (await st.client.positions()).find(row => String(row.id) === found.id)
        const remaining = left ? finite(left.qty) ?? 0 : 0
        const applied = qty === 0 ? remaining <= 0 : remaining > 0 && remaining < found.qty - 1e-9
        if (!applied) throw error
      }

      const closePrice = await this.closeFillPrice(st, found, startedAt)
      return {
        ticket: args.ticket,
        positionTicket: args.ticket,
        symbol: found.symbol,
        lots: closedLots,
        closePrice,
        state: 'position_closed',
      }
    })
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async openedOrders(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    const names = await this.nameIndex(st)
    const positions = await st.client.positions({ cached: true })
    const orders = await st.client.orders({ cached: true })
    const byId = new Map(orders.map(order => [String(order.id ?? ''), order]))
    const protectionIds = new Set<string>()
    for (const position of positions) {
      if (hasId(position.stopLossId)) protectionIds.add(String(position.stopLossId))
      if (hasId(position.takeProfitId)) protectionIds.add(String(position.takeProfitId))
    }

    const out: unknown[] = []
    for (const position of positions) {
      const positionId = String(position.id ?? '').trim()
      const lots = finite(position.qty) ?? 0
      if (!positionId || lots <= 0) continue
      const sl = byId.get(String(position.stopLossId ?? ''))
      const tp = byId.get(String(position.takeProfitId ?? ''))
      const ticket = ticketFromId(positionId)
      out.push({
        ticket,
        positionTicket: ticket,
        symbol: names.get(Number(position.tradableInstrumentId)) ?? String(position.tradableInstrumentId ?? ''),
        operation: sideOf(position.side) === 'sell' ? 'Sell' : 'Buy',
        lots,
        volume: lots,
        openPrice: positive(finite(position.avgPrice)),
        stopLoss: positive(finite(sl?.stopPrice) ?? finite(sl?.price)),
        takeProfit: positive(finite(tp?.price) ?? finite(tp?.stopPrice)),
        comment: commentFromStrategyId(position.strategyId),
        openTime: isoOrUndefined(position.openDate),
      })
    }
    for (const order of orders) {
      if (!this.isPendingEntry(order, protectionIds)) continue
      const orderId = String(order.id ?? '').trim()
      const ticket = ticketFromId(orderId)
      const type = String(order.type ?? '').toLowerCase()
      const lots = finite(order.qty) ?? 0
      out.push({
        ticket,
        orderTicket: ticket,
        symbol: names.get(Number(order.tradableInstrumentId)) ?? String(order.tradableInstrumentId ?? ''),
        operation: operationFor(type, String(order.side ?? '')),
        lots,
        volume: lots,
        openPrice: positive(type === 'stop' ? finite(order.stopPrice) ?? finite(order.price) : finite(order.price) ?? finite(order.stopPrice)),
        stopLoss: positive(finite(order.stopLoss)),
        takeProfit: positive(finite(order.takeProfit)),
        comment: commentFromStrategyId(order.strategyId),
        state: 'Placed',
      })
    }
    return out
  }

  async closedOrders(id: string): Promise<unknown[]> {
    const to = new Date(this.now())
    const from = new Date(to.getTime() - 30 * DAY_MS)
    return this.orderHistory(id, from.toISOString(), to.toISOString())
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    const st = await this.state(id)
    const fromMs = Date.parse(from)
    const toMs = Date.parse(to)
    const history = await st.client.ordersHistory(Number.isFinite(fromMs) ? fromMs : undefined, Number.isFinite(toMs) ? toMs : undefined)
    const instruments = await st.client.instruments()
    const names = new Map(instruments.map(item => [item.tradableInstrumentId, item.name]))
    const trades = closedTradesFromHistory(history, names)
    const currency = trades.length > 0 ? (await this.accountInfo(st).catch(() => null))?.currency : undefined
    const detailsByName = new Map<string, TradelockerInstrumentDetails | undefined>()
    const out: unknown[] = []
    for (const trade of trades) {
      if (!detailsByName.has(trade.symbol)) {
        const instrument = instruments.find(item => item.name === trade.symbol)
        detailsByName.set(trade.symbol, instrument ? await st.client.instrumentDetails(instrument).catch(() => undefined) : undefined)
      }
      const details = detailsByName.get(trade.symbol)
      out.push({
        ticket: ticketFromId(trade.positionId),
        positionTicket: ticketFromId(trade.positionId),
        dealTicket: ticketFromId(trade.closeId),
        symbol: trade.symbol,
        operation: trade.positionSide === 'sell' ? 'Sell' : 'Buy',
        lots: trade.lots,
        openPrice: trade.openPrice,
        closePrice: trade.closePrice,
        openTime: trade.openedAt == null ? undefined : isoOrUndefined(trade.openedAt),
        closeTime: trade.closedAt == null ? undefined : isoOrUndefined(trade.closedAt),
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        // History carries no profit. A gross figure is only known when no currency conversion is needed.
        profit: grossProfit({
          side: trade.positionSide,
          lots: trade.lots,
          openPrice: trade.openPrice,
          closePrice: trade.closePrice,
          contractSize: details?.lotSize,
          quotingCurrency: details?.quotingCurrency,
          accountCurrency: currency,
        }),
        comment: commentFromStrategyId(trade.strategyId),
      })
    }
    return out
  }

  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    return this.orderHistory(id, from, to)
  }

  async orderHistoryPage(
    id: string,
    from: string,
    to: string,
  ): Promise<{ orders: unknown[]; pagesCount: number }> {
    return { orders: await this.orderHistory(id, from, to), pagesCount: 1 }
  }

  async closedOrdersHistory(id: string, from: string, to: string): Promise<unknown[]> {
    return this.orderHistory(id, from, to)
  }

  async closedOrdersHistoryLite(id: string, from: string, to: string): Promise<unknown[]> {
    return this.closedOrdersHistory(id, from, to)
  }

  async accountSummary(id: string): Promise<AccountSummary> {
    const st = await this.state(id)
    const account = await this.accountInfo(st)
    const state = await st.client.accountState()
    const balance = finite(state.balance)
    const stateValue = (name: string): unknown => {
      const key = Object.keys(state).find(k => k.toLowerCase() === name.toLowerCase())
      return key === undefined ? undefined : (state as Record<string, unknown>)[key]
    }
    const profit = finite(stateValue('openNetPnL')) ?? finite(stateValue('openGrossPnL'))
    return {
      balance,
      equity: finite(state.projectedBalance) ?? (balance !== undefined && profit !== undefined ? balance + profit : balance),
      profit,
      margin: finite(state.initialMarginReq),
      freeMargin: finite(state.availableFunds),
      currency: account.currency,
      synced: true,
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const st = await this.state(id)
    const { instrument } = await this.instrumentFor(st, symbol)
    return st.client.quote(instrument)
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const st = await this.state(id)
    const { instrument, details } = await this.instrumentFor(st, symbol)
    return {
      symbolName: instrument.name,
      symbol: {
        digits: decimalsOf(details.tickSize),
        point: details.tickSize,
        contractSize: details.lotSize,
      },
      groupParams: {
        minLot: details.minLot ?? details.lotStep,
        maxLot: details.maxLot,
        lotStep: details.lotStep,
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    return (await st.client.instruments()).map(item => item.name)
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const st = await this.state(id)
    const account = await this.accountInfo(st, true)
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true, server: st.credential.server },
      account: {
        loggedIn: true,
        tradeAllowed: account.status === 'ACTIVE',
        currency: account.currency,
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

  // ── State ───────────────────────────────────────────────────────────────

  private async state(id: string): Promise<AccountState> {
    const existing = this.states.get(id)
    if (existing) return existing
    // Concurrent first calls share one load, so an account never gets two clients (and two write chains).
    const pending = this.loading.get(id)
    if (pending) return pending
    const load = this.createState(id).finally(() => this.loading.delete(id))
    this.loading.set(id, load)
    return load
  }

  private async createState(id: string): Promise<AccountState> {
    if (!this.loadCredentials) throw new Error('TradeLocker is not configured')
    const credential = await this.loadCredentials(id)
    if (!credential) throw new Error('TradeLocker is not configured')
    const client = new TradelockerClient(credential, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      sleep: this.sleep,
      ...(this.clientOptions ?? {}),
    })
    const state: AccountState = {
      credential,
      client,
      account: null,
      uncertainTags: new Set(),
      writeChain: Promise.resolve(),
    }
    this.states.set(id, state)
    return state
  }

  /** Orders, modifications and closes on one account run one at a time. */
  private serialize<T>(st: AccountState, fn: () => Promise<T>): Promise<T> {
    const run = st.writeChain.then(fn, fn)
    st.writeChain = run.catch(() => undefined)
    return run
  }

  private async accountInfo(st: AccountState, fresh = false) {
    if (!fresh && st.account && this.now() - st.account.at < ACCOUNT_TTL_MS) return st.account
    const accounts = await st.client.accounts()
    const mine = accounts.find(item => item.accountId === st.credential.tlAccountId && item.accNum === st.credential.accNum)
    if (!mine) throw new Error('This TradeLocker account is no longer available on the login')
    st.account = { at: this.now(), currency: mine.currency, status: mine.status }
    return st.account
  }

  private async nameIndex(st: AccountState): Promise<Map<number, string>> {
    return new Map((await st.client.instruments()).map(item => [item.tradableInstrumentId, item.name]))
  }

  private async instrumentFor(st: AccountState, symbol: string): Promise<{ instrument: TradelockerInstrument; details: TradelockerInstrumentDetails }> {
    const instrument = matchInstrument(await st.client.instruments(), symbol)
    if (!instrument) throw new Error(`Symbol ${symbol} is not on this TradeLocker account`)
    const details = await st.client.instrumentDetails(instrument)
    return { instrument, details }
  }

  private isPendingEntry(order: Json, protectionIds: Set<string>): boolean {
    const type = String(order.type ?? '').toLowerCase()
    if (type !== 'limit' && type !== 'stop') return false
    if (isFilledStatus(order.status) || isRejectedStatus(order.status)) return false
    if (hasId(order.positionId)) return false
    return !protectionIds.has(String(order.id ?? ''))
  }

  // ── Placing and confirming ──────────────────────────────────────────────

  private async sendEntry(st: AccountState, args: OrderSendArgs): Promise<OrderResult> {
    const { instrument, details } = await this.instrumentFor(st, args.symbol)
    if (instrument.tradeRouteId === undefined) throw new Error(`${instrument.name} has no trading route on this TradeLocker account`)
    const side = sideForOperation(args.operation)
    const type = orderTypeForOperation(args.operation)
    const rawPrice = type === 'market' ? undefined : positive(args.price)
    if (type !== 'market' && rawPrice == null) throw new Error('TradeLocker pending order is missing a price')

    let qty: number
    try {
      qty = sizeLots(Number(args.volume), instrument.name, details)
    } catch (error) {
      if (error instanceof TradelockerSizingError) throw withCause(error.message, error)
      throw error
    }
    const price = rawPrice == null ? undefined : roundToTick(rawPrice, details.tickSize)
    const stopLoss = this.roundOptional(args.stoploss, details)
    const takeProfit = this.roundOptional(args.takeprofit, details)
    const tag = entryStrategyId({
      comment: args.comment,
      symbol: instrument.name,
      operation: args.operation,
      qty,
      price,
      stopLoss,
      takeProfit,
      now: this.now(),
    })

    const result = (located: Located): OrderResult => this.entryResult(located, { args, instrument, qty, price, stopLoss, takeProfit })

    // A repeat of an order whose first attempt got no answer must not be sent blind.
    if (st.uncertainTags.has(tag)) {
      const earlier = await this.locateByTag(st, tag)
      if (earlier?.kind === 'rejected') throw new Error(`TradeLocker rejected the order${earlier.reason}`)
      if (earlier) {
        st.uncertainTags.delete(tag)
        return result(earlier)
      }
    }

    const body: Json = {
      qty,
      side,
      type,
      validity: type === 'market' ? 'IOC' : 'GTC',
      routeId: instrument.tradeRouteId,
      tradableInstrumentId: instrument.tradableInstrumentId,
      strategyId: tag,
    }
    if (type === 'limit') body.price = price
    if (type === 'stop') body.stopPrice = price
    if (stopLoss != null) {
      body.stopLoss = stopLoss
      body.stopLossType = 'absolute'
    }
    if (takeProfit != null) {
      body.takeProfit = takeProfit
      body.takeProfitType = 'absolute'
    }

    let orderId: string
    try {
      orderId = await st.client.placeOrder(body)
    } catch (error) {
      if (!(error instanceof TradelockerApiError) || !error.uncertain) throw error
      // No usable answer. Look the order up by its tag; never send it again from here.
      const located = await this.locateByTag(st, tag).catch(() => null)
      if (located?.kind === 'rejected') throw withCause(`TradeLocker rejected the order${located.reason}`, error)
      if (!located) {
        st.uncertainTags.add(tag)
        throw withCause(`TradeLocker did not confirm order ${tag} (${friendlyTradelockerError(error)}); it was not sent again`, error)
      }
      return result(located)
    }

    if (type !== 'market') return result(await this.confirmPending(st, orderId))
    return result(await this.confirmFill(st, orderId, tag))
  }

  private roundOptional(value: number | null | undefined, details: TradelockerInstrumentDetails): number | undefined {
    const price = positive(value)
    return price == null ? undefined : roundToTick(price, details.tickSize)
  }

  private entryResult(
    located: Located,
    ctx: { args: OrderSendArgs; instrument: TradelockerInstrument; qty: number; price: number | undefined; stopLoss: number | undefined; takeProfit: number | undefined },
  ): OrderResult {
    const { args, instrument, qty, price, stopLoss, takeProfit } = ctx
    if (located.kind === 'position') {
      const ticket = ticketFromId(located.positionId)
      return {
        ticket,
        positionTicket: ticket,
        orderTicket: located.orderId ? ticketFromId(located.orderId) : ticket,
        openPrice: located.price ?? price,
        stopLoss,
        takeProfit,
        lots: located.qty > 0 ? located.qty : qty,
        symbol: instrument.name,
        orderType: args.operation,
        comment: args.comment,
      }
    }
    if (located.kind === 'rejected') throw new Error(`TradeLocker rejected the order${located.reason}`)
    const ticket = ticketFromId(located.orderId)
    return {
      ticket,
      orderTicket: ticket,
      openPrice: price,
      stopLoss,
      takeProfit,
      lots: qty,
      symbol: instrument.name,
      orderType: args.operation,
      state: 'Placed',
      comment: args.comment,
    }
  }

  /** Find an order by its `strategyId` among positions, working orders and recent history. */
  private async locateByTag(st: AccountState, tag: string): Promise<Located | null> {
    const position = (await st.client.positions()).find(row => String(row.strategyId ?? '') === tag)
    if (position) {
      return {
        kind: 'position',
        positionId: String(position.id),
        orderId: undefined,
        price: positive(finite(position.avgPrice)),
        qty: finite(position.qty) ?? 0,
      }
    }
    const open = (await st.client.orders()).find(row => String(row.strategyId ?? '') === tag)
    if (open) return { kind: 'order', orderId: String(open.id) }
    const from = this.now() - 15 * 60_000
    const hit = (await st.client.ordersHistory(from)).find(row => String(row.strategyId ?? '') === tag)
    if (!hit) return null
    if (isRejectedStatus(hit.status)) return { kind: 'rejected', orderId: String(hit.id), reason: rejectReason(hit) }
    if (isFilledStatus(hit.status)) {
      return {
        kind: 'position',
        positionId: hasId(hit.positionId) ? String(hit.positionId) : String(hit.id),
        orderId: String(hit.id),
        price: positive(finite(hit.avgPrice)),
        qty: finite(hit.filledQty) ?? finite(hit.qty) ?? 0,
      }
    }
    return { kind: 'order', orderId: String(hit.id) }
  }

  /**
   * The place response is only an acknowledgement. Read the order back from history to learn whether it
   * filled (and which position it opened) or was rejected.
   */
  private async confirmFill(st: AccountState, orderId: string, tag: string): Promise<Located> {
    let status = ''
    for (let attempt = 0; attempt < FILL_POLLS; attempt += 1) {
      const history = await st.client.ordersHistory(this.now() - 15 * 60_000)
      const row = history.find(item => String(item.id) === orderId)
      if (row) {
        status = String(row.status ?? '')
        if (isRejectedStatus(status)) throw new Error(`TradeLocker rejected the order${rejectReason(row)}`)
        if (isFilledStatus(status)) {
          return {
            kind: 'position',
            positionId: hasId(row.positionId) ? String(row.positionId) : orderId,
            orderId,
            price: positive(finite(row.avgPrice)),
            qty: finite(row.filledQty) ?? finite(row.qty) ?? 0,
          }
        }
      }
      if (attempt < FILL_POLLS - 1) await this.sleep(FILL_POLL_MS)
    }
    // Acknowledged but not seen filled in history: a position carrying the tag means it was.
    const position = (await st.client.positions()).find(row => String(row.strategyId ?? '') === tag)
    if (position) {
      return {
        kind: 'position',
        positionId: String(position.id),
        orderId,
        price: positive(finite(position.avgPrice)),
        qty: finite(position.qty) ?? 0,
      }
    }
    throw new Error(`TradeLocker order ${tag} was accepted but its fill could not be confirmed${status ? ` (status ${status})` : ''}`)
  }

  private async confirmPending(st: AccountState, orderId: string): Promise<Located> {
    const open = (await st.client.orders()).find(row => String(row.id) === orderId)
    if (open) return { kind: 'order', orderId }
    const history = await st.client.ordersHistory(this.now() - 15 * 60_000)
    const row = history.find(item => String(item.id) === orderId)
    if (row && isRejectedStatus(row.status)) throw new Error(`TradeLocker rejected the order${rejectReason(row)}`)
    return { kind: 'order', orderId }
  }

  // ── Positions and protection ────────────────────────────────────────────

  /**
   * Locates a position or pending order. With `cached` the lists may be up to a second and a half old, which
   * saves the reads a basket close would otherwise repeat for every leg; a miss is always rechecked fresh.
   */
  private async findTicket(st: AccountState, ticket: number, cached = false): Promise<Found> {
    const names = await this.nameIndex(st)
    const nameOf = (row: Json) => names.get(Number(row.tradableInstrumentId)) ?? String(row.tradableInstrumentId ?? '')
    const asPosition = (row: Json): Found => ({
      kind: 'position',
      id: String(row.id),
      symbol: nameOf(row),
      qty: finite(row.qty) ?? 0,
      side: sideOf(row.side),
    })

    const positions = await st.client.positions({ cached })
    const direct = positions.find(row => hasId(row.id) && ticketFromId(row.id) === ticket)
    if (direct) return asPosition(direct)

    const orders = await st.client.orders({ cached })
    const protectionIds = new Set<string>()
    for (const position of positions) {
      if (hasId(position.stopLossId)) protectionIds.add(String(position.stopLossId))
      if (hasId(position.takeProfitId)) protectionIds.add(String(position.takeProfitId))
    }
    const pending = orders.find(row => hasId(row.id) && ticketFromId(row.id) === ticket && this.isPendingEntry(row, protectionIds))
    if (pending) {
      return {
        kind: 'order',
        id: String(pending.id),
        row: pending,
        symbol: nameOf(pending),
        qty: finite(pending.qty) ?? 0,
        side: sideOf(pending.side),
        type: String(pending.type ?? '').toLowerCase(),
      }
    }

    if (cached) return this.findTicket(st, ticket, false)

    // A pending order that filled became a position with a different id: follow it through history.
    const history = await st.client.ordersHistory(this.now() - 30 * DAY_MS)
    const filled = history.find(row => hasId(row.id) && ticketFromId(row.id) === ticket && isFilledStatus(row.status) && hasId(row.positionId))
    if (filled) {
      const position = positions.find(row => String(row.id) === String(filled.positionId))
      if (position) return asPosition(position)
    }
    throw new Error(`TradeLocker unknown ticket ${ticket}: ${GONE}`)
  }

  private protectionIntent(value: number | null | undefined, details: TradelockerInstrumentDetails): number | 'remove' | undefined {
    if (value == null) return undefined
    const n = Number(value)
    if (!Number.isFinite(n)) return undefined
    if (n <= 0) return 'remove'
    return roundToTick(n, details.tickSize)
  }

  private async modifyPosition(
    st: AccountState,
    found: Extract<Found, { kind: 'position' }>,
    details: TradelockerInstrumentDetails,
    args: OrderModifyArgs,
  ): Promise<OrderResult> {
    // undefined / null leaves a side alone, a price sets it, 0 removes it.
    const wantSl = this.protectionIntent(args.stoploss, details)
    const wantTp = this.protectionIntent(args.takeprofit, details)
    const body: Json = {}
    if (wantSl !== undefined) body.stopLoss = wantSl === 'remove' ? null : wantSl
    if (wantTp !== undefined) body.takeProfit = wantTp === 'remove' ? null : wantTp
    if (Object.keys(body).length > 0) await st.client.modifyPosition(found.id, body)
    const ticket = args.ticket
    return {
      ticket,
      positionTicket: ticket,
      stopLoss: typeof wantSl === 'number' ? wantSl : undefined,
      takeProfit: typeof wantTp === 'number' ? wantTp : undefined,
      symbol: found.symbol,
      lots: found.qty,
    }
  }

  private async modifyPending(
    st: AccountState,
    found: Extract<Found, { kind: 'order' }>,
    _instrument: TradelockerInstrument,
    details: TradelockerInstrumentDetails,
    args: OrderModifyArgs,
  ): Promise<OrderResult> {
    const wantSl = this.protectionIntent(args.stoploss, details)
    const wantTp = this.protectionIntent(args.takeprofit, details)
    const body: Json = { qty: found.qty, type: found.type }
    if (found.row.validity) body.validity = found.row.validity
    let price = positive(found.type === 'stop' ? finite(found.row.stopPrice) ?? finite(found.row.price) : finite(found.row.price) ?? finite(found.row.stopPrice))
    if (args.price != null && positive(args.price) != null) {
      const next = roundToTick(Number(args.price), details.tickSize)
      if (price == null || Math.abs(price - next) > 1e-12) price = next
      if (found.type === 'stop') body.stopPrice = next
      else body.price = next
    }
    if (wantSl !== undefined) {
      body.stopLoss = wantSl === 'remove' ? null : wantSl
      if (wantSl !== 'remove') body.stopLossType = 'absolute'
    }
    if (wantTp !== undefined) {
      body.takeProfit = wantTp === 'remove' ? null : wantTp
      if (wantTp !== 'remove') body.takeProfitType = 'absolute'
    }
    if (args.price != null || wantSl !== undefined || wantTp !== undefined) await st.client.modifyOrder(found.id, body)

    const ticket = args.ticket
    return {
      ticket,
      orderTicket: ticket,
      openPrice: price,
      stopLoss: typeof wantSl === 'number' ? wantSl : positive(finite(found.row.stopLoss)),
      takeProfit: typeof wantTp === 'number' ? wantTp : positive(finite(found.row.takeProfit)),
      symbol: found.symbol,
      lots: found.qty,
      state: 'Placed',
    }
  }

  /** Price of the close fill, read from history. A missing price never fails a close that went through. */
  private async closeFillPrice(st: AccountState, found: Extract<Found, { kind: 'position' }>, since: number): Promise<number | undefined> {
    const closing = oppositeSide(found.side)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const history = await st.client.ordersHistory(since - 60_000)
        const closes = history
          .filter(row => String(row.positionId ?? '') === found.id && isFilledStatus(row.status) && String(row.side ?? '').toLowerCase() === closing)
          .sort((a, b) => (finite(b.lastModified) ?? 0) - (finite(a.lastModified) ?? 0) || (finite(b.id) ?? 0) - (finite(a.id) ?? 0))
        const price = positive(finite(closes[0]?.avgPrice))
        if (price != null) return price
      } catch {
        return undefined
      }
      if (attempt < 2) await this.sleep(FILL_POLL_MS)
    }
    return undefined
  }
}

export function createTradelockerProvider(options?: TradelockerProviderOptions): TradelockerProvider {
  return new TradelockerProvider(options)
}

let singleton: TradelockerProvider | undefined

export function getTradelockerProvider(): TradelockerProvider {
  if (!singleton) {
    singleton = new TradelockerProvider({
      loadCredentials: async accountId => {
        const { loadTradelockerCredential } = await import('./tradelocker/credentials')
        return loadTradelockerCredential(accountId)
      },
    })
  }
  return singleton
}
