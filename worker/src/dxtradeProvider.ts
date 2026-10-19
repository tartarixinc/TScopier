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
  DxtradeApiError,
  DxtradeClient,
  asRecord,
  finite,
  friendlyDxtradeError,
  rows,
  type DxtradeClientOptions,
  type DxtradeCredential,
  type Json,
} from './dxtrade/client'
import {
  CLOSE_CODE_PREFIX,
  DxtradeSizingError,
  actionOrderCode,
  commentFromOrderCode,
  entryOrderCode,
  formatNumber,
  lotsToUnits,
  matchInstrument,
  oppositeSide,
  orderTypeForOperation,
  protectionOrderCode,
  roundPrice,
  sideForOperation,
  ticketFromCode,
  unitsToLots,
  type DxtradeInstrument,
} from './dxtrade/symbols'

export type { DxtradeCredential } from './dxtrade/client'

export interface DxtradeProviderOptions {
  loadCredentials?: (accountId: string) => Promise<DxtradeCredential | null>
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Passed through to every client (tests skip the DNS safety check). */
  clientOptions?: Pick<DxtradeClientOptions, 'skipHostCheck' | 'resolveHost' | 'requestTimeoutMs'>
}

type AccountState = {
  credential: DxtradeCredential
  client: DxtradeClient
  instruments: Map<string, DxtradeInstrument>
  instrumentsAt: number
  account: { at: number; baseCurrency: string; status: string; isPositionBased: boolean | undefined } | null
  comments: { at: number; byOrderId: Map<number, string> } | null
  writeChain: Promise<unknown>
}

type Found =
  | { kind: 'position'; position: Json; positionCode: string; symbol: string; units: number; side: 'BUY' | 'SELL' }
  | { kind: 'order'; order: Json; symbol: string; units: number; side: 'BUY' | 'SELL' }

const INSTRUMENT_TTL_MS = 10 * 60_000
const ACCOUNT_TTL_MS = 20_000
const COMMENT_TTL_MS = 30_000
const FILL_POLLS = 8
const FILL_POLL_MS = 250
const DAY_MS = 24 * 60 * 60 * 1000
const GONE = 'no open position or pending order'

function positive(value: number | null | undefined): number | undefined {
  const n = value == null ? undefined : Number(value)
  return n != null && Number.isFinite(n) && n > 0 ? n : undefined
}

function legOf(order: Json): Json {
  return rows(order.legs)[0] ?? {}
}

function orderIdOf(order: Json): number | undefined {
  return finite(order.orderId)
}

/** Identifier PUT/DELETE accept: the client order id when present, else the system code. */
function referenceOf(order: Json): string {
  return String(order.clientOrderId ?? '').trim() || String(order.orderCode ?? '').trim()
}

function priceOf(order: Json): number | undefined {
  return positive(finite(legOf(order).price ?? order.limitPrice ?? order.stopPrice))
}

function operationFor(type: string, side: string): string {
  const buy = String(side).toUpperCase() === 'BUY'
  const t = type.toUpperCase()
  if (t === 'LIMIT') return buy ? 'BuyLimit' : 'SellLimit'
  if (t === 'STOP') return buy ? 'BuyStop' : 'SellStop'
  return buy ? 'Buy' : 'Sell'
}

function isOpenEffect(order: Json): boolean {
  const effect = String(legOf(order).positionEffect ?? '').toUpperCase()
  return effect === '' || effect === 'OPEN'
}

function isCloseEffect(order: Json): boolean {
  return String(legOf(order).positionEffect ?? '').toUpperCase() === 'CLOSE'
}

function isWorking(order: Json): boolean {
  if (order.finalStatus === true) return false
  const status = String(order.status ?? '').toUpperCase()
  return status === '' || status === 'WORKING' || status === 'ACCEPTED' || status === 'IN_REVIEW'
}

function isoOrUndefined(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function decimalsOf(step: number | undefined): number {
  if (!step || !(step > 0)) return 5
  const text = String(step)
  if (text.includes('e-')) return Number(text.split('e-')[1])
  const dot = text.indexOf('.')
  return dot === -1 ? 0 : text.length - dot - 1
}

export class DxtradeProvider implements BrokerProvider {
  readonly name = 'dxtrade' as const
  private readonly states = new Map<string, AccountState>()
  private readonly loadCredentials?: (accountId: string) => Promise<DxtradeCredential | null>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly clientOptions: DxtradeProviderOptions['clientOptions']
  private seq = 0

  constructor(options: DxtradeProviderOptions = {}) {
    this.loadCredentials = options.loadCredentials
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.clientOptions = options.clientOptions
  }

  seedPlatformCache(_id: string, _platform: MtPlatform | string | null | undefined): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return { id, platform: 'DXtrade', status: status.broker?.connected ? 'connected' : 'disconnected', error: '' }
    } catch (error) {
      return { id, platform: 'DXtrade', status: 'error', error: friendlyDxtradeError(error) }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('DXtrade accounts connect with a stored login')
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
      if (error instanceof DxtradeApiError && (error.status === 401 || error.code === '3' || (error.status === 500 && error.code === '110'))) {
        this.states.delete(id)
        return 'token_reconnect_failed'
      }
      const message = error instanceof Error ? error.message : ''
      return /not configured|could not be read|net-based/i.test(message) ? 'token_reconnect_failed' : 'session_gone'
    }
  }

  async verifyTradingReady(id: string): Promise<boolean> {
    const status = await this.mtStatus(id)
    return status.account?.tradeAllowed === true
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  async orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> {
    const st = await this.state(id)
    const instrument = await this.instrumentFor(st, args.symbol)
    const side = sideForOperation(args.operation)
    const type = orderTypeForOperation(args.operation)
    const price = type === 'MARKET' ? undefined : positive(args.price)
    if (type !== 'MARKET' && price == null) throw new Error('DXtrade pending order is missing a price')

    let units: number
    try {
      units = lotsToUnits(Number(args.volume), instrument)
    } catch (error) {
      if (error instanceof DxtradeSizingError) throw new Error(error.message)
      throw error
    }
    const stopLoss = this.roundOptional(args.stoploss, instrument)
    const takeProfit = this.roundOptional(args.takeprofit, instrument)
    const entryPrice = price == null ? undefined : roundPrice(price, instrument)
    const code = entryOrderCode({
      comment: args.comment,
      symbol: instrument.symbol,
      operation: args.operation,
      units,
      price: entryPrice,
      stopLoss,
      takeProfit,
      now: this.now(),
    })

    const entry: Json = {
      orderCode: code,
      type,
      instrument: instrument.symbol,
      quantity: formatNumber(units),
      positionEffect: 'OPEN',
      side,
      tif: 'GTC',
    }
    if (type === 'LIMIT') entry.limitPrice = formatNumber(entryPrice!)
    if (type === 'STOP') entry.stopPrice = formatNumber(entryPrice!)
    if (type !== 'MARKET' && args.expiration && args.expirationType !== 'GTC') {
      const expires = isoOrUndefined(args.expiration)
      if (expires) {
        entry.tif = 'GTD'
        entry.expireDate = expires
      }
    }
    if (args.comment) entry.metadata = { comment: String(args.comment).slice(0, 256) }

    const closing = oppositeSide(side)
    const protections: Json[] = []
    if (stopLoss != null) {
      protections.push({
        orderCode: protectionOrderCode(code, 'SL'),
        type: 'STOP',
        instrument: instrument.symbol,
        quantity: '0',
        positionEffect: 'CLOSE',
        side: closing,
        stopPrice: formatNumber(stopLoss),
        tif: 'GTC',
      })
    }
    if (takeProfit != null) {
      protections.push({
        orderCode: protectionOrderCode(code, 'TP'),
        type: 'LIMIT',
        instrument: instrument.symbol,
        quantity: '0',
        positionEffect: 'CLOSE',
        side: closing,
        limitPrice: formatNumber(takeProfit),
        tif: 'GTC',
      })
    }

    let orderId: number | undefined
    let protectedWithEntry = false
    if (protections.length > 0) {
      try {
        const responses = await this.place(st, { orders: [entry, ...protections], contingencyType: 'IF-THEN' }, code)
        orderId = responses[0]?.orderId
        protectedWithEntry = true
      } catch (error) {
        // A definite rejection of the group (the broker may not allow groups): send the entry alone
        // and attach protection to the position afterwards. Uncertain outcomes are never retried here.
        if (!(error instanceof DxtradeApiError) || error.uncertain || (error.status !== 400 && error.status !== 409)) throw error
        console.warn(`[dxtrade] order group rejected for ${instrument.symbol}: ${error.message}; placing the entry alone`)
      }
    }
    if (orderId == null) {
      const responses = await this.place(st, entry, code)
      orderId = responses[0]?.orderId
    }
    if (orderId == null) throw new Error('DXtrade did not return an order id')

    const ticket = ticketFromCode(orderId)
    if (type !== 'MARKET') {
      await this.confirmOrder(st, orderId, code, false)
      return {
        ticket,
        orderTicket: ticket,
        openPrice: entryPrice,
        stopLoss: protectedWithEntry ? stopLoss : undefined,
        takeProfit: protectedWithEntry ? takeProfit : undefined,
        lots: unitsToLots(units, instrument),
        symbol: instrument.symbol,
        orderType: args.operation,
        state: 'Placed',
        comment: args.comment,
      }
    }

    const fill = await this.confirmOrder(st, orderId, code, true)
    let appliedSl = protectedWithEntry ? stopLoss : undefined
    let appliedTp = protectedWithEntry ? takeProfit : undefined
    if (!protectedWithEntry && (stopLoss != null || takeProfit != null)) {
      const attached = await this.attachProtection(st, instrument, String(orderId), side, stopLoss, takeProfit)
      appliedSl = attached.stopLoss
      appliedTp = attached.takeProfit
    }
    return {
      ticket,
      positionTicket: ticket,
      orderTicket: ticket,
      openPrice: positive(fill.averagePrice),
      stopLoss: appliedSl,
      takeProfit: appliedTp,
      lots: unitsToLots(fill.filledQuantity > 0 ? fill.filledQuantity : units, instrument),
      symbol: instrument.symbol,
      orderType: args.operation,
      comment: args.comment,
    }
  }

  async orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> {
    const st = await this.state(id)
    return this.serialize(st, async () => {
      const found = await this.findTicket(st, args.ticket)
      const instrument = await this.instrumentFor(st, found.symbol)
      if (found.kind === 'position') return this.modifyPosition(st, found, instrument, args)
      return this.modifyPending(st, found, instrument, args)
    })
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const st = await this.state(id)
    return this.serialize(st, async () => {
      const found = await this.findTicket(st, args.ticket)
      const instrument = await this.instrumentFor(st, found.symbol)
      if (found.kind === 'order') {
        await this.cancelWithChildren(st, found.order)
        return {
          ticket: args.ticket,
          orderTicket: args.ticket,
          symbol: found.symbol,
          lots: unitsToLots(found.units, instrument),
          state: 'position_closed',
        }
      }

      const body: Json = {
        orderCode: this.actionCode(CLOSE_CODE_PREFIX, args.ticket),
        type: 'MARKET',
        instrument: found.symbol,
        positionEffect: 'CLOSE',
        positionCode: found.positionCode,
        side: oppositeSide(found.side),
        tif: 'GTC',
      }
      let closedUnits = found.units
      if (args.lots != null && args.lots > 0) {
        const partial = lotsToUnits(args.lots, instrument)
        if (partial < found.units * 0.9999) {
          body.quantity = formatNumber(partial)
          closedUnits = partial
        }
      }
      const responses = await this.place(st, body, String(body.orderCode))
      const orderId = responses[0]?.orderId
      if (orderId == null) throw new Error('DXtrade did not return an order id')
      const fill = await this.confirmOrder(st, orderId, String(body.orderCode), true)
      return {
        ticket: args.ticket,
        positionTicket: args.ticket,
        symbol: found.symbol,
        lots: unitsToLots(fill.filledQuantity > 0 ? fill.filledQuantity : closedUnits, instrument),
        closePrice: positive(fill.averagePrice),
        state: 'position_closed',
      }
    })
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async openedOrders(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    await this.ensureInstruments(st)
    const [positions, open, comments] = await Promise.all([
      st.client.positions(),
      st.client.openOrders(),
      this.commentIndex(st),
    ])
    const out: unknown[] = []
    for (const position of positions) {
      const positionCode = String(position.positionCode ?? '').trim()
      const units = finite(position.quantity) ?? 0
      if (!positionCode || units <= 0) continue
      const symbol = String(position.symbol ?? '')
      const ticket = ticketFromCode(positionCode)
      const lots = unitsToLots(units, this.lookup(st, symbol))
      const orderId = Number(positionCode)
      out.push({
        ticket,
        positionTicket: ticket,
        symbol,
        operation: String(position.side ?? '').toUpperCase() === 'SELL' ? 'Sell' : 'Buy',
        lots,
        volume: lots,
        openPrice: positive(finite(position.openPrice)),
        stopLoss: positive(finite(position.stopLossPrice)),
        takeProfit: positive(finite(position.takeProfitPrice)),
        comment: Number.isFinite(orderId) ? comments.get(orderId) ?? '' : '',
        openTime: isoOrUndefined(position.openTime),
      })
    }
    for (const order of open.orders) {
      if (!isWorking(order) || !isOpenEffect(order)) continue
      const type = String(order.type ?? '').toUpperCase()
      if (type !== 'LIMIT' && type !== 'STOP') continue
      const orderId = orderIdOf(order)
      if (orderId == null) continue
      const ticket = ticketFromCode(orderId)
      const symbol = String(order.instrument ?? legOf(order).instrument ?? '')
      const lots = unitsToLots(finite(legOf(order).quantity) ?? 0, this.lookup(st, symbol))
      const protection = this.childProtection(order, open.orders)
      out.push({
        ticket,
        orderTicket: ticket,
        symbol,
        operation: operationFor(type, String(order.side ?? '')),
        lots,
        volume: lots,
        openPrice: priceOf(order),
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
        comment: this.commentOf(order),
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
    await this.ensureInstruments(st)
    const orders = await st.client.orderHistory({
      'in-status': 'COMPLETED',
      'issued-from': isoOrUndefined(from) ?? from,
      'issued-to': isoOrUndefined(to) ?? to,
      limit: '1000',
    })
    return orders.filter(order => isCloseEffect(order) && (finite(legOf(order).filledQuantity) ?? 0) > 0).map(order => this.closeRow(st, order))
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

  async accountSummary(id: string): Promise<AccountSummary> {
    const st = await this.state(id)
    const [metrics, account] = await Promise.all([st.client.metrics(), this.accountInfo(st)])
    const balance = finite(metrics.balance)
    return {
      balance,
      equity: finite(metrics.equity) ?? balance,
      profit: finite(metrics.openPl),
      margin: finite(metrics.margin),
      freeMargin: finite(metrics.marginFree),
      credit: finite(metrics.credit),
      currency: account.baseCurrency,
      synced: true,
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const st = await this.state(id)
    const instrument = await this.instrumentFor(st, symbol)
    return st.client.quote(instrument.symbol)
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const st = await this.state(id)
    const instrument = await this.instrumentFor(st, symbol)
    const lotSize = instrument.lotSize > 0 ? instrument.lotSize : 1
    const step = instrument.quantityIncrement && instrument.quantityIncrement > 0 ? instrument.quantityIncrement : 1
    return {
      symbolName: instrument.symbol,
      symbol: {
        digits: decimalsOf(instrument.priceIncrement),
        point: instrument.priceIncrement,
        contractSize: lotSize,
      },
      groupParams: {
        minLot: Number((step / lotSize).toPrecision(10)),
        lotStep: Number((step / lotSize).toPrecision(10)),
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    await this.ensureInstruments(st)
    return [...st.instruments.keys()]
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const st = await this.state(id)
    const account = await this.accountInfo(st, true)
    const tradeAllowed = account.status === 'FULL_TRADING' && account.isPositionBased === true
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true, server: new URL(st.client.serverUrl).hostname },
      account: {
        loggedIn: true,
        tradeAllowed,
        currency: account.baseCurrency,
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
    if (!this.loadCredentials) throw new Error('DXtrade is not configured')
    const credential = await this.loadCredentials(id)
    if (!credential) throw new Error('DXtrade is not configured')
    if (!credential.isPositionBased) {
      throw new Error('This DXtrade account is net-based. TScopier needs a position-based (hedging) account')
    }
    const client = new DxtradeClient(credential, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      sleep: this.sleep,
      ...(this.clientOptions ?? {}),
    })
    const state: AccountState = {
      credential,
      client,
      instruments: new Map(),
      instrumentsAt: 0,
      account: null,
      comments: null,
      writeChain: Promise.resolve(),
    }
    this.states.set(id, state)
    return state
  }

  /** Orders and modifications on one account run one at a time; ETag checks fail under races. */
  private serialize<T>(st: AccountState, fn: () => Promise<T>): Promise<T> {
    const run = st.writeChain.then(fn, fn)
    st.writeChain = run.catch(() => undefined)
    return run
  }

  private async accountInfo(st: AccountState, fresh = false) {
    if (!fresh && st.account && this.now() - st.account.at < ACCOUNT_TTL_MS) return st.account
    const accounts = await st.client.accounts()
    const mine = accounts.find(item => item.account === st.credential.accountCode)
    if (!mine) throw new Error('This DXtrade account is no longer available on the login')
    st.account = { at: this.now(), baseCurrency: mine.baseCurrency, status: mine.status, isPositionBased: mine.isPositionBased }
    return st.account
  }

  private async ensureInstruments(st: AccountState): Promise<void> {
    if (st.instruments.size > 0 && this.now() - st.instrumentsAt < INSTRUMENT_TTL_MS) return
    const list = await st.client.instrumentsQuery()
    if (list.length === 0 && st.instruments.size > 0) return
    st.instruments = new Map(list.map(item => [item.symbol, item]))
    st.instrumentsAt = this.now()
  }

  private lookup(st: AccountState, symbol: string): DxtradeInstrument | undefined {
    return st.instruments.get(symbol) ?? matchInstrument(st.instruments.values(), symbol)
  }

  private async instrumentFor(st: AccountState, symbol: string): Promise<DxtradeInstrument> {
    await this.ensureInstruments(st)
    const found = this.lookup(st, symbol)
    if (!found) throw new Error(`Symbol ${symbol} is not on this DXtrade account`)
    return found
  }

  private roundOptional(value: number | null | undefined, instrument: DxtradeInstrument): number | undefined {
    const price = positive(value)
    return price == null ? undefined : roundPrice(price, instrument)
  }

  private actionCode(prefix: string, ticket: number): string {
    this.seq += 1
    return actionOrderCode(prefix, ticket, this.now(), this.seq.toString(36))
  }

  // ── Placing and confirming ──────────────────────────────────────────────

  /**
   * POST an order. A duplicate client code (409/100) means a previous attempt landed, so the original
   * order is returned. A timeout or 5xx is resolved through order history by client code, never by a
   * blind retry.
   */
  private async place(st: AccountState, body: unknown, code: string) {
    try {
      return await st.client.placeOrder(body)
    } catch (error) {
      if (error instanceof DxtradeApiError) {
        if (error.status === 409 && error.code === '100') {
          const found = await this.lookupByCode(st, code)
          if (found) return [found]
        }
        if (error.uncertain) {
          const found = await this.lookupByCode(st, code).catch(() => null)
          if (found) return [found]
        }
      }
      throw error
    }
  }

  private async lookupByCode(st: AccountState, code: string): Promise<{ orderId: number | undefined; updateOrderId: number | undefined } | null> {
    const orders = await st.client.orderHistory({ 'with-client-id': code })
    const hit = orders.find(order => String(order.clientOrderId ?? '') === code) ?? orders[0]
    if (!hit) return null
    return { orderId: orderIdOf(hit), updateOrderId: undefined }
  }

  /**
   * Order responses are only an acknowledgement. Read the order back to learn whether it was filled,
   * rejected or is still working.
   */
  private async confirmOrder(
    st: AccountState,
    orderId: number,
    code: string,
    expectFill: boolean,
  ): Promise<{ status: string; averagePrice: number | undefined; filledQuantity: number }> {
    let last: Json | undefined
    for (let attempt = 0; attempt < FILL_POLLS; attempt += 1) {
      const orders = await st.client.orderHistory({ 'with-order-id': String(orderId) })
      const order = orders.find(item => orderIdOf(item) === orderId) ?? orders[0]
      if (order) {
        last = order
        const status = String(order.status ?? '').toUpperCase()
        if (status === 'REJECTED' || status === 'CANCELED' || status === 'EXPIRED') {
          throw new Error(`DXtrade ${status.toLowerCase()} the order${this.rejectReason(order)}`)
        }
        const leg = legOf(order)
        const filled = finite(leg.filledQuantity) ?? 0
        if (status === 'COMPLETED' || (expectFill && filled > 0 && order.finalStatus === true)) {
          return { status, averagePrice: finite(leg.averagePrice), filledQuantity: filled }
        }
        if (!expectFill) return { status, averagePrice: undefined, filledQuantity: 0 }
      }
      if (attempt < FILL_POLLS - 1) await this.sleep(FILL_POLL_MS)
    }
    if (expectFill) {
      // The order was acknowledged but never reported as filled. A position with this code means it was.
      const positions = await st.client.positions()
      const match = positions.find(position => String(position.positionCode ?? '') === String(orderId))
      if (match) {
        return { status: 'COMPLETED', averagePrice: finite(match.openPrice), filledQuantity: finite(match.quantity) ?? 0 }
      }
      throw new Error(`DXtrade order ${code} was accepted but its fill could not be confirmed${last ? ` (status ${String(last.status ?? 'unknown')})` : ''}`)
    }
    return { status: String(last?.status ?? 'WORKING'), averagePrice: undefined, filledQuantity: 0 }
  }

  private rejectReason(order: Json): string {
    const executions = rows(order.executions)
    for (let i = executions.length - 1; i >= 0; i -= 1) {
      const reason = String(executions[i]?.rejectReason ?? '').trim()
      if (reason) return `: ${reason}`
    }
    return ''
  }

  // ── Positions and protection ────────────────────────────────────────────

  private async findTicket(st: AccountState, ticket: number): Promise<Found> {
    const positions = await st.client.positions()
    for (const position of positions) {
      const positionCode = String(position.positionCode ?? '').trim()
      if (!positionCode || ticketFromCode(positionCode) !== ticket) continue
      return {
        kind: 'position',
        position,
        positionCode,
        symbol: String(position.symbol ?? ''),
        units: finite(position.quantity) ?? 0,
        side: String(position.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      }
    }
    const open = await st.client.openOrders()
    for (const order of open.orders) {
      const orderId = orderIdOf(order)
      if (orderId == null || ticketFromCode(orderId) !== ticket || !isOpenEffect(order) || !isWorking(order)) continue
      return {
        kind: 'order',
        order,
        symbol: String(order.instrument ?? legOf(order).instrument ?? ''),
        units: finite(legOf(order).quantity) ?? 0,
        side: String(order.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      }
    }
    throw new Error(`DXtrade unknown ticket ${ticket}: ${GONE}`)
  }

  /** Run `fn` with a fresh working-orders list and its ETag; retry when the ETag went stale (412). */
  private async guarded<T>(st: AccountState, fn: (ctx: { orders: Json[]; etag: string | null }) => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const open = await st.client.openOrders()
      try {
        return await fn({ orders: open.orders, etag: open.etag })
      } catch (error) {
        lastError = error
        if (error instanceof DxtradeApiError && error.status === 412) continue
        throw error
      }
    }
    throw lastError
  }

  /** Protection orders attached to a position: STOP closes are the SL, LIMIT closes the TP. */
  private positionProtection(orders: Json[], positionCode: string): { stop?: Json; limit?: Json } {
    const out: { stop?: Json; limit?: Json } = {}
    for (const order of orders) {
      if (!isWorking(order) || !isCloseEffect(order)) continue
      if (String(legOf(order).positionCode ?? '') !== positionCode) continue
      const type = String(order.type ?? '').toUpperCase()
      if (type === 'STOP' && !out.stop) out.stop = order
      if (type === 'LIMIT' && !out.limit) out.limit = order
    }
    return out
  }

  /** Children of a pending entry (its group's THEN orders), found by link or by our `_SL`/`_TP` codes. */
  private childProtection(parent: Json, orders: Json[]): { stopLoss?: number; takeProfit?: number; stop?: Json; limit?: Json } {
    const linked = new Set<string>()
    for (const link of rows(parent.links)) {
      if (String(link.linkType ?? '').toUpperCase() === 'PARENT') {
        if (link.linkedClientOrderId) linked.add(String(link.linkedClientOrderId))
        if (link.linkedOrder) linked.add(String(link.linkedOrder))
      }
    }
    const parentCode = String(parent.clientOrderId ?? '')
    const out: { stopLoss?: number; takeProfit?: number; stop?: Json; limit?: Json } = {}
    for (const order of orders) {
      if (!isWorking(order) || !isCloseEffect(order)) continue
      const client = String(order.clientOrderId ?? '')
      const system = String(order.orderCode ?? '')
      const byLink = linked.has(client) || linked.has(system)
      const bySuffix = parentCode !== '' && (client === `${parentCode}_SL` || client === `${parentCode}_TP`)
      if (!byLink && !bySuffix) continue
      const type = String(order.type ?? '').toUpperCase()
      if (type === 'STOP' && !out.stop) {
        out.stop = order
        out.stopLoss = priceOf(order)
      }
      if (type === 'LIMIT' && !out.limit) {
        out.limit = order
        out.takeProfit = priceOf(order)
      }
    }
    return out
  }

  /** Add SL and TP orders to an existing position, one POST each. Failures are logged, not thrown. */
  private async attachProtection(
    st: AccountState,
    instrument: DxtradeInstrument,
    positionCode: string,
    positionSide: 'BUY' | 'SELL',
    stopLoss: number | undefined,
    takeProfit: number | undefined,
  ): Promise<{ stopLoss?: number; takeProfit?: number }> {
    const applied: { stopLoss?: number; takeProfit?: number } = {}
    const ticket = ticketFromCode(positionCode)
    const closing = oppositeSide(positionSide)
    if (stopLoss != null) {
      try {
        await this.createProtection(st, instrument, positionCode, ticket, closing, 'STOP', stopLoss)
        applied.stopLoss = stopLoss
      } catch (error) {
        console.warn(`[dxtrade] stop loss rejected for ${instrument.symbol}: ${friendlyDxtradeError(error)}`)
      }
    }
    if (takeProfit != null) {
      try {
        await this.createProtection(st, instrument, positionCode, ticket, closing, 'LIMIT', takeProfit)
        applied.takeProfit = takeProfit
      } catch (error) {
        console.warn(`[dxtrade] take profit rejected for ${instrument.symbol}: ${friendlyDxtradeError(error)}`)
      }
    }
    return applied
  }

  private async createProtection(
    st: AccountState,
    instrument: DxtradeInstrument,
    positionCode: string,
    ticket: number,
    side: 'BUY' | 'SELL',
    type: 'STOP' | 'LIMIT',
    price: number,
  ): Promise<void> {
    const code = this.actionCode(type === 'STOP' ? 'TSL' : 'TST', ticket)
    const body: Json = {
      orderCode: code,
      type,
      instrument: instrument.symbol,
      positionEffect: 'CLOSE',
      positionCode,
      side,
      tif: 'GTC',
    }
    body[type === 'STOP' ? 'stopPrice' : 'limitPrice'] = formatNumber(price)
    await this.place(st, body, code)
  }

  private async modifyPosition(
    st: AccountState,
    found: Extract<Found, { kind: 'position' }>,
    instrument: DxtradeInstrument,
    args: OrderModifyArgs,
  ): Promise<OrderResult> {
    // undefined / null leaves a side alone, a price sets it, 0 removes it.
    const wantSl = this.protectionIntent(args.stoploss, instrument)
    const wantTp = this.protectionIntent(args.takeprofit, instrument)
    const closing = oppositeSide(found.side)
    let stopLoss = positive(finite(found.position.stopLossPrice))
    let takeProfit = positive(finite(found.position.takeProfitPrice))

    const apply = async (
      want: number | 'remove' | undefined,
      type: 'STOP' | 'LIMIT',
      current: number | undefined,
    ): Promise<number | undefined> => {
      if (want === undefined) return current
      const result = await this.guarded(st, async ({ orders, etag }) => {
        const existing = this.positionProtection(orders, found.positionCode)[type === 'STOP' ? 'stop' : 'limit']
        if (want === 'remove') {
          if (existing) await st.client.cancelOrder(referenceOf(existing), etag)
          return undefined
        }
        if (existing) {
          if (priceOf(existing) != null && Math.abs(priceOf(existing)! - want) < 1e-12) return want
          const body: Json = {
            orderCode: referenceOf(existing),
            instrument: found.symbol,
            positionEffect: 'CLOSE',
            positionCode: found.positionCode,
            side: String(existing.side ?? closing),
            tif: String(existing.tif ?? 'GTC'),
          }
          body[type === 'STOP' ? 'stopPrice' : 'limitPrice'] = formatNumber(want)
          await st.client.modifyOrder(body, etag)
          return want
        }
        await this.createProtection(st, instrument, found.positionCode, ticketFromCode(found.positionCode), closing, type, want)
        return want
      })
      return result
    }

    // The stop loss goes first so a rejected take profit can never leave the position naked.
    stopLoss = await apply(wantSl, 'STOP', stopLoss)
    takeProfit = await apply(wantTp, 'LIMIT', takeProfit)
    const ticket = args.ticket
    return {
      ticket,
      positionTicket: ticket,
      stopLoss,
      takeProfit,
      symbol: found.symbol,
      lots: unitsToLots(found.units, instrument),
    }
  }

  private protectionIntent(value: number | null | undefined, instrument: DxtradeInstrument): number | 'remove' | undefined {
    if (value == null) return undefined
    const n = Number(value)
    if (!Number.isFinite(n)) return undefined
    if (n <= 0) return 'remove'
    return roundPrice(n, instrument)
  }

  private async modifyPending(
    st: AccountState,
    found: Extract<Found, { kind: 'order' }>,
    instrument: DxtradeInstrument,
    args: OrderModifyArgs,
  ): Promise<OrderResult> {
    const order = found.order
    const type = String(order.type ?? '').toUpperCase()
    const wantSl = this.protectionIntent(args.stoploss, instrument)
    const wantTp = this.protectionIntent(args.takeprofit, instrument)
    let price = priceOf(order)

    if (args.price != null && positive(args.price) != null) {
      const next = roundPrice(Number(args.price), instrument)
      if (price == null || Math.abs(price - next) > 1e-12) {
        await this.guarded(st, async ({ etag }) => {
          const body: Json = {
            orderCode: referenceOf(order),
            instrument: found.symbol,
            quantity: formatNumber(found.units),
            positionEffect: 'OPEN',
            side: found.side,
            tif: String(order.tif ?? 'GTC'),
          }
          body[type === 'STOP' ? 'stopPrice' : 'limitPrice'] = formatNumber(next)
          if (order.expireDate) body.expireDate = order.expireDate
          await st.client.modifyOrder(body, etag)
        })
        price = next
      }
    }

    let stopLoss: number | undefined
    let takeProfit: number | undefined
    if (wantSl !== undefined || wantTp !== undefined) {
      await this.guarded(st, async ({ orders, etag }) => {
        const children = this.childProtection(order, orders)
        stopLoss = children.stopLoss
        takeProfit = children.takeProfit
        const edit = async (want: number | 'remove' | undefined, child: Json | undefined, kind: 'STOP' | 'LIMIT') => {
          if (want === undefined) return
          if (!child) {
            if (want === 'remove') return
            // A group cannot gain an order after it was placed.
            throw new Error('DXtrade cannot add a stop loss or take profit to a pending order that was placed without one')
          }
          if (want === 'remove') {
            await st.client.cancelOrder(referenceOf(child), etag)
            return
          }
          const body: Json = {
            orderCode: referenceOf(child),
            instrument: found.symbol,
            positionEffect: 'CLOSE',
            side: String(child.side ?? oppositeSide(found.side)),
            tif: String(child.tif ?? 'GTC'),
          }
          body[kind === 'STOP' ? 'stopPrice' : 'limitPrice'] = formatNumber(want)
          await st.client.modifyOrder(body, etag)
          if (kind === 'STOP') stopLoss = want
          else takeProfit = want
        }
        await edit(wantSl, children.stop, 'STOP')
        await edit(wantTp, children.limit, 'LIMIT')
      })
    }

    const ticket = args.ticket
    return {
      ticket,
      orderTicket: ticket,
      openPrice: price,
      stopLoss,
      takeProfit,
      symbol: found.symbol,
      lots: unitsToLots(found.units, instrument),
      state: 'Placed',
    }
  }

  private async cancelWithChildren(st: AccountState, order: Json): Promise<void> {
    await this.guarded(st, async ({ etag }) => st.client.cancelOrder(referenceOf(order), etag))
    // THEN orders normally die with their parent. Clear any that survived.
    const after = await st.client.openOrders()
    const survivors = this.childProtection(order, after.orders)
    for (const child of [survivors.stop, survivors.limit]) {
      if (!child) continue
      try {
        await this.guarded(st, async ({ etag }) => st.client.cancelOrder(referenceOf(child), etag))
      } catch (error) {
        if (!(error instanceof DxtradeApiError) || error.status !== 409) console.warn(`[dxtrade] could not cancel child order: ${friendlyDxtradeError(error)}`)
      }
    }
  }

  // ── Row mapping ─────────────────────────────────────────────────────────

  private commentOf(order: Json): string {
    const meta = asRecord(order.metadata)
    const stored = String(meta.comment ?? '').trim()
    return stored || commentFromOrderCode(order.clientOrderId)
  }

  /** orderId -> comment for recently filled entries, so open positions keep their signal comment. */
  private async commentIndex(st: AccountState): Promise<Map<number, string>> {
    if (st.comments && this.now() - st.comments.at < COMMENT_TTL_MS) return st.comments.byOrderId
    const byOrderId = new Map<number, string>()
    try {
      const orders = await st.client.orderHistory({ period: 'week', 'in-status': 'COMPLETED', limit: '500' })
      for (const order of orders) {
        if (!isOpenEffect(order)) continue
        const orderId = orderIdOf(order)
        const comment = this.commentOf(order)
        if (orderId != null && comment) byOrderId.set(orderId, comment)
      }
    } catch {
      // Positions still list without a comment.
    }
    st.comments = { at: this.now(), byOrderId }
    return byOrderId
  }

  private closeRow(st: AccountState, order: Json): Record<string, unknown> {
    const leg = legOf(order)
    const symbol = String(order.instrument ?? leg.instrument ?? '')
    const instrument = this.lookup(st, symbol)
    const positionCode = String(leg.positionCode ?? orderIdOf(order) ?? '')
    const closeSide = String(order.side ?? '').toUpperCase()
    const cash = rows(order.cashTransactions)
    const sum = (type: string) => {
      const values = cash.filter(item => String(item.type ?? '').toUpperCase() === type).map(item => finite(item.value) ?? 0)
      return values.length ? values.reduce((a, b) => a + b, 0) : undefined
    }
    const price = positive(finite(leg.averagePrice))
    return {
      ticket: ticketFromCode(positionCode),
      positionTicket: ticketFromCode(positionCode),
      dealTicket: orderIdOf(order),
      symbol,
      // The close order trades against the position, so the position was the other side.
      operation: closeSide === 'SELL' ? 'Buy' : 'Sell',
      lots: unitsToLots(finite(leg.filledQuantity) ?? 0, instrument),
      openPrice: price,
      closePrice: price,
      closeTime: isoOrUndefined(order.transactionTime ?? order.issueTime),
      profit: sum('SETTLEMENT'),
      swap: sum('FINANCING'),
      commission: sum('COMMISSION'),
      comment: this.commentOf(order),
    }
  }
}

export function createDxtradeProvider(options?: DxtradeProviderOptions): DxtradeProvider {
  return new DxtradeProvider(options)
}

let singleton: DxtradeProvider | undefined

export function getDxtradeProvider(): DxtradeProvider {
  if (!singleton) {
    singleton = new DxtradeProvider({
      loadCredentials: async accountId => {
        const { loadDxtradeCredential } = await import('./dxtrade/credentials')
        return loadDxtradeCredential(accountId)
      },
    })
  }
  return singleton
}