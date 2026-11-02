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
  MatchtraderApiError,
  MatchtraderClient,
  friendlyMatchtraderError,
  type Json,
  type MatchtraderClientOptions,
  type MatchtraderCredential,
} from './matchtrader/client'
import type { MatchtraderTagStore } from './matchtrader/credentials'
import {
  MatchtraderSizingError,
  entryKey,
  finite,
  lotLimits,
  matchInstrument,
  normalizeSymbolKey,
  operationFor,
  orderTypeForOperation,
  parseServerTime,
  positive,
  priceDecimals,
  resolveComments,
  roundPrice,
  sideForOperation,
  sizeLots,
  tagKey,
  ticketFromId,
  type MatchtraderInstrument,
  type TagEntry,
} from './matchtrader/symbols'

export type { MatchtraderCredential } from './matchtrader/client'
export type { MatchtraderTagStore } from './matchtrader/credentials'

export interface MatchtraderProviderOptions {
  loadCredentials?: (accountId: string) => Promise<MatchtraderCredential | null>
  tagStore?: MatchtraderTagStore
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  clientOptions?: Pick<MatchtraderClientOptions, 'requestTimeoutMs' | 'resolveHost'>
}

type PositionRow = {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  lots: number
  openPrice: number | undefined
  stopLoss: number | undefined
  takeProfit: number | undefined
  openedAt: number | undefined
}

type PendingRow = {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  lots: number
  type: string
  price: number | undefined
  stopLoss: number | undefined
  takeProfit: number | undefined
  raw: Json
}

type Found =
  | { kind: 'position'; row: PositionRow }
  | { kind: 'order'; row: PendingRow }

type Landed =
  | { kind: 'position'; row: PositionRow; orderId: string }
  | { kind: 'order'; row: PendingRow }

type AccountState = {
  credential: MatchtraderCredential
  client: MatchtraderClient
  account: { at: number; currency: string } | null
  tags: Map<string, TagEntry>
  tagsLoadedAt: number
  /** Entries whose order may or may not have landed, with the ids that existed before they were sent. */
  uncertain: Map<string, { before: Set<string>; kind: 'position' | 'order' }>
  writeChain: Promise<unknown>
}

const ACCOUNT_TTL_MS = 20_000
const TAG_TTL_MS = 5 * 60_000
const FILL_POLLS = 6
const FILL_POLL_MS = 300
const DAY_MS = 24 * 60 * 60 * 1000
const GONE = 'no open position or pending order'

function sideOf(value: unknown): 'buy' | 'sell' {
  return String(value ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy'
}

function isoOrUndefined(ms: number | undefined | null): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** An error that keeps the failure it describes. */
function withCause(message: string, cause: unknown): Error {
  const error = new Error(message)
  ;(error as Error & { cause?: unknown }).cause = cause
  return error
}

function toPosition(row: Json): PositionRow | null {
  const id = String(row.id ?? '').trim()
  const lots = finite(row.volume) ?? 0
  if (!id || lots <= 0) return null
  return {
    id,
    symbol: String(row.symbol ?? row.alias ?? '').trim(),
    side: sideOf(row.side),
    lots,
    openPrice: positive(finite(row.openPrice)),
    stopLoss: positive(finite(row.stopLoss)),
    takeProfit: positive(finite(row.takeProfit)),
    openedAt: finite(row.openTimeMillis) ?? parseServerTime(row.openTime),
  }
}

function isPendingType(type: string): boolean {
  const t = type.toLowerCase()
  return t !== '' && !t.includes('market') && (t.includes('limit') || t.includes('stop'))
}

function toPending(row: Json): PendingRow | null {
  const id = String(row.id ?? '').trim()
  const type = String(row.type ?? '').trim()
  if (!id || !isPendingType(type)) return null
  return {
    id,
    symbol: String(row.symbol ?? row.alias ?? '').trim(),
    side: sideOf(row.side),
    lots: finite(row.volume) ?? 0,
    type,
    price: positive(finite(row.activationPrice ?? row.price)),
    stopLoss: positive(finite(row.stopLoss)),
    takeProfit: positive(finite(row.takeProfit)),
    raw: row,
  }
}

export class MatchtraderProvider implements BrokerProvider {
  readonly name = 'matchtrader' as const
  private readonly states = new Map<string, AccountState>()
  private readonly loading = new Map<string, Promise<AccountState>>()
  private readonly loadCredentials?: (accountId: string) => Promise<MatchtraderCredential | null>
  private readonly tagStore?: MatchtraderTagStore
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly clientOptions: MatchtraderProviderOptions['clientOptions']

  constructor(options: MatchtraderProviderOptions = {}) {
    this.loadCredentials = options.loadCredentials
    this.tagStore = options.tagStore
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.clientOptions = options.clientOptions
  }

  seedPlatformCache(): void {}

  async getV1Account(id: string): Promise<{ id: string; platform: string; status: string; error: string }> {
    try {
      const status = await this.mtStatus(id)
      return { id, platform: 'MatchTrader', status: status.broker?.connected ? 'connected' : 'disconnected', error: '' }
    } catch (error) {
      return { id, platform: 'MatchTrader', status: 'error', error: friendlyMatchtraderError(error) }
    }
  }

  async connectEx(): Promise<string> {
    throw new Error('MatchTrader accounts connect with a stored login')
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
      if (error instanceof MatchtraderApiError && (error.status === 401 || error.status === 400 || error.status === 403 || error.code === 'TFA')) {
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
      const found = await this.findTicket(st, args.ticket)
      const inst = await this.instrumentFor(st, found.row.symbol)
      if (found.kind === 'position') return this.modifyPosition(st, found.row, inst, args)
      return this.modifyPending(st, found.row, inst, args)
    })
  }

  async orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> {
    const st = await this.state(id)
    return this.serialize(st, async () => {
      const found = await this.findTicket(st, args.ticket)
      if (found.kind === 'order') {
        const row = found.row
        await st.client.cancelPending({
          instrument: row.symbol,
          id: row.id,
          orderSide: row.side === 'sell' ? 'SELL' : 'BUY',
          type: row.type.toUpperCase(),
          isMobile: false,
        })
        return {
          ticket: args.ticket,
          orderTicket: args.ticket,
          symbol: row.symbol,
          lots: row.lots,
          state: 'position_closed',
        }
      }

      const row = found.row
      const inst = await this.instrumentFor(st, row.symbol)
      let partialLots: number | undefined
      if (args.lots != null && args.lots > 0) {
        let partial: number
        try {
          partial = sizeLots(args.lots, row.symbol, inst)
        } catch (error) {
          if (error instanceof MatchtraderSizingError) throw withCause(error.message, error)
          throw error
        }
        if (partial < row.lots * 0.9999) partialLots = partial
      }
      const closedLots = partialLots ?? row.lots
      // The docs name only "the order side" and show it equal to the position side; flip here if a broker differs.
      const orderSide = row.side === 'sell' ? 'SELL' : 'BUY'

      const startedAt = this.now()
      try {
        if (partialLots != null) {
          await st.client.closePartially({
            positionId: row.id,
            volume: partialLots,
            isMobile: false,
            instrument: row.symbol,
            orderSide,
          })
        } else {
          await st.client.closePosition({
            positionId: row.id,
            instrument: row.symbol,
            orderSide,
            volume: String(row.lots),
          })
        }
      } catch (error) {
        if (!(error instanceof MatchtraderApiError) || !error.uncertain) throw error
        // No answer: the close may have landed. Read the position back instead of sending it again.
        const left = (await this.readPositions(st)).find(item => tagKey(item.id) === tagKey(row.id))
        const remaining = left?.lots ?? 0
        const applied = partialLots == null ? remaining <= 0 : remaining > 0 && remaining < row.lots - 1e-9
        if (!applied) throw error
      }

      const fill = await this.closeFill(st, row, startedAt)
      return {
        ticket: args.ticket,
        positionTicket: args.ticket,
        symbol: row.symbol,
        lots: closedLots,
        closePrice: fill?.closePrice,
        profit: fill?.profit,
        swap: fill?.swap,
        commission: fill?.commission,
        state: 'position_closed',
      }
    })
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async openedOrders(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    const positions = await this.readPositions(st)
    const orders = await this.readPending(st)
    await this.ensureTags(st)
    const comments = resolveComments(
      [
        ...positions.map(row => ({ id: row.id, symbol: row.symbol, side: row.side, at: row.openedAt })),
        ...orders.map(row => ({ id: row.id, symbol: row.symbol, side: row.side, at: parseServerTime(row.raw.creationTime) })),
      ],
      st.tags,
    )

    const out: unknown[] = []
    for (const row of positions) {
      const ticket = ticketFromId(row.id)
      out.push({
        ticket,
        positionTicket: ticket,
        symbol: row.symbol,
        operation: row.side === 'sell' ? 'Sell' : 'Buy',
        lots: row.lots,
        volume: row.lots,
        openPrice: row.openPrice,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        comment: comments.get(row.id) ?? '',
        openTime: isoOrUndefined(row.openedAt),
      })
    }
    for (const row of orders) {
      const ticket = ticketFromId(row.id)
      out.push({
        ticket,
        orderTicket: ticket,
        symbol: row.symbol,
        operation: operationFor(row.type, row.side),
        lots: row.lots,
        volume: row.lots,
        openPrice: row.price,
        stopLoss: row.stopLoss,
        takeProfit: row.takeProfit,
        comment: comments.get(row.id) ?? '',
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
    const rows = await st.client.closedPositions(
      Number.isFinite(fromMs) ? fromMs : this.now() - 30 * DAY_MS,
      Number.isFinite(toMs) ? toMs : this.now(),
    )
    await this.ensureTags(st)
    const comments = resolveComments(
      rows.map(row => ({
        id: String(row.id ?? ''),
        symbol: String(row.symbol ?? row.alias ?? ''),
        side: sideOf(row.side),
        at: parseServerTime(row.openTime),
      })),
      st.tags,
    )
    const out: unknown[] = []
    for (const row of rows) {
      const positionId = String(row.id ?? '').trim()
      if (!positionId) continue
      out.push({
        ticket: ticketFromId(positionId),
        positionTicket: ticketFromId(positionId),
        dealTicket: ticketFromId(row.closingOrderID),
        symbol: String(row.symbol ?? row.alias ?? '').trim(),
        operation: sideOf(row.side) === 'sell' ? 'Sell' : 'Buy',
        lots: finite(row.volume) ?? 0,
        openPrice: positive(finite(row.openPrice)),
        closePrice: positive(finite(row.closePrice)),
        openTime: isoOrUndefined(parseServerTime(row.openTime)),
        closeTime: isoOrUndefined(parseServerTime(row.time)),
        stopLoss: positive(finite(row.stopLoss)),
        takeProfit: positive(finite(row.takeProfit)),
        profit: finite(row.profit),
        swap: finite(row.swap),
        commission: finite(row.commission),
        comment: comments.get(positionId) ?? '',
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
    const data = await st.client.balance()
    const currency = String(data.currency ?? '').trim() || 'USD'
    st.account = { at: this.now(), currency }
    const balance = finite(data.balance)
    return {
      balance,
      equity: finite(data.equity) ?? balance,
      profit: finite(data.profit),
      margin: finite(data.margin),
      freeMargin: finite(data.freeMargin),
      marginLevel: finite(data.marginLevel),
      credit: finite(data.credit),
      currency,
      synced: true,
    }
  }

  async quote(id: string, symbol: string): Promise<QuoteResult> {
    const st = await this.state(id)
    return st.client.quote(await this.instrumentFor(st, symbol))
  }

  async symbolParams(id: string, symbol: string): Promise<SymbolParams> {
    const st = await this.state(id)
    const inst = await this.instrumentFor(st, symbol)
    const limits = lotLimits(inst)
    return {
      symbolName: inst.symbol,
      symbol: {
        digits: priceDecimals(inst),
        point: inst.sizeOfOnePoint,
        contractSize: inst.contractSize,
      },
      groupParams: {
        minLot: limits.min,
        maxLot: limits.max,
        lotStep: limits.step,
      },
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    const st = await this.state(id)
    return (await st.client.instruments()).map(item => item.symbol)
  }

  async mtStatus(id: string): Promise<FxsocketMtStatus> {
    const st = await this.state(id)
    const account = await this.accountInfo(st, true)
    return {
      status: 'ready',
      terminal: { alive: true },
      broker: { connected: true, server: new URL(st.client.serverUrl).hostname },
      account: {
        loggedIn: true,
        tradeAllowed: true,
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
    if (!this.loadCredentials) throw new Error('MatchTrader is not configured')
    const credential = await this.loadCredentials(id)
    if (!credential) throw new Error('MatchTrader is not configured')
    const client = new MatchtraderClient(credential, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      sleep: this.sleep,
      ...(this.clientOptions ?? {}),
    })
    const state: AccountState = {
      credential,
      client,
      account: null,
      tags: new Map(),
      tagsLoadedAt: 0,
      uncertain: new Map(),
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

  private async accountInfo(st: AccountState, fresh = false): Promise<{ at: number; currency: string }> {
    if (!fresh && st.account && this.now() - st.account.at < ACCOUNT_TTL_MS) return st.account
    const data = await st.client.balance()
    st.account = { at: this.now(), currency: String(data.currency ?? '').trim() || 'USD' }
    return st.account
  }

  private async readPositions(st: AccountState): Promise<PositionRow[]> {
    const out: PositionRow[] = []
    for (const raw of await st.client.positions()) {
      const row = toPosition(raw)
      if (row) out.push(row)
    }
    return out
  }

  private async readPending(st: AccountState): Promise<PendingRow[]> {
    const out: PendingRow[] = []
    for (const raw of await st.client.activeOrders()) {
      const row = toPending(raw)
      if (row) out.push(row)
    }
    return out
  }

  private async instrumentFor(st: AccountState, symbol: string): Promise<MatchtraderInstrument> {
    const inst = matchInstrument(await st.client.instruments(), symbol)
    if (!inst) throw new Error(`Symbol ${symbol} is not on this MatchTrader account`)
    return inst
  }

  // ── Comment tags ────────────────────────────────────────────────────────

  private async ensureTags(st: AccountState): Promise<void> {
    if (!this.tagStore || this.now() - st.tagsLoadedAt < TAG_TTL_MS) return
    try {
      const stored = await this.tagStore.load(st.credential.brokerAccountId)
      for (const [key, entry] of stored) if (!st.tags.has(key)) st.tags.set(key, entry)
      st.tagsLoadedAt = this.now()
    } catch (error) {
      console.warn(`[matchtrader] comment tags could not be loaded: ${friendlyMatchtraderError(error)}`)
      // Try again in about 30 seconds instead of on every read.
      st.tagsLoadedAt = this.now() - TAG_TTL_MS + 30_000
    }
  }

  private rememberTag(st: AccountState, ids: string[], entry: TagEntry): void {
    if (!entry.comment) return
    for (const orderId of new Set(ids.filter(Boolean))) {
      st.tags.set(tagKey(orderId), entry)
      void this.tagStore?.put(st.credential.brokerAccountId, orderId, entry).catch(error => {
        console.warn(`[matchtrader] comment tag was not saved: ${friendlyMatchtraderError(error)}`)
      })
    }
  }

  // ── Placing and confirming ──────────────────────────────────────────────

  private async sendEntry(st: AccountState, args: OrderSendArgs): Promise<OrderResult> {
    const inst = await this.instrumentFor(st, args.symbol)
    const side = sideForOperation(args.operation)
    const type = orderTypeForOperation(args.operation)
    const rawPrice = type === 'market' ? undefined : positive(args.price)
    if (type !== 'market' && rawPrice == null) throw new Error('MatchTrader pending order is missing a price')

    let qty: number
    try {
      qty = sizeLots(Number(args.volume), inst.symbol, inst)
    } catch (error) {
      if (error instanceof MatchtraderSizingError) throw withCause(error.message, error)
      throw error
    }
    const price = rawPrice == null ? undefined : roundPrice(rawPrice, inst)
    const stopLoss = positive(args.stoploss) == null ? undefined : roundPrice(Number(args.stoploss), inst)
    const takeProfit = positive(args.takeprofit) == null ? undefined : roundPrice(Number(args.takeprofit), inst)
    const key = entryKey({
      comment: args.comment,
      symbol: inst.symbol,
      operation: args.operation,
      qty,
      price,
      stopLoss,
      takeProfit,
      now: this.now(),
    })
    const entry = (): TagEntry => ({
      comment: String(args.comment ?? ''),
      symbol: inst.symbol,
      side: side === 'SELL' ? 'sell' : 'buy',
      at: this.now(),
    })
    const ctx = { args, inst, qty, price, stopLoss, takeProfit }

    if (type !== 'market') {
      const before = new Set((await this.readPending(st)).map(row => tagKey(row.id)))
      const earlier = st.uncertain.get(key)
      if (earlier?.kind === 'order') {
        const hit = await this.findNewPending(st, earlier.before, inst, side, type, qty)
        if (hit) {
          st.uncertain.delete(key)
          this.rememberTag(st, [hit.id], entry())
          return this.pendingResult({ kind: 'order', row: hit }, ctx)
        }
      }
      let orderId: string
      try {
        orderId = await st.client.createPending({
          instrument: inst.symbol,
          orderSide: side,
          volume: qty,
          price,
          type: type.toUpperCase(),
          slPrice: stopLoss ?? 0,
          tpPrice: takeProfit ?? 0,
          isMobile: false,
        })
      } catch (error) {
        if (!(error instanceof MatchtraderApiError) || !error.uncertain) throw error
        const hit = await this.findNewPending(st, before, inst, side, type, qty).catch(() => null)
        if (!hit) {
          st.uncertain.set(key, { before, kind: 'order' })
          throw withCause(`MatchTrader did not confirm the pending order (${friendlyMatchtraderError(error)}); it was not sent again`, error)
        }
        this.rememberTag(st, [hit.id], entry())
        return this.pendingResult({ kind: 'order', row: hit }, ctx)
      }
      const listed = (await this.readPending(st).catch(() => [])).find(row => tagKey(row.id) === tagKey(orderId))
      this.rememberTag(st, [orderId], entry())
      return this.pendingResult({
        kind: 'order',
        row: listed ?? { id: orderId, symbol: inst.symbol, side: side === 'SELL' ? 'sell' : 'buy', lots: qty, type, price, stopLoss, takeProfit, raw: {} },
      }, ctx)
    }

    const before = new Set((await this.readPositions(st)).map(row => tagKey(row.id)))
    // A repeat of an entry whose first attempt got no answer must not be sent blind.
    const earlier = st.uncertain.get(key)
    if (earlier?.kind === 'position') {
      const hit = await this.findNewPosition(st, earlier.before, inst, side, qty)
      if (hit) {
        st.uncertain.delete(key)
        this.rememberTag(st, [hit.id], entry())
        return this.positionResult({ kind: 'position', row: hit, orderId: hit.id }, ctx)
      }
    }

    let orderId: string
    try {
      orderId = await st.client.openPosition({
        instrument: inst.symbol,
        orderSide: side,
        volume: qty,
        slPrice: stopLoss ?? 0,
        tpPrice: takeProfit ?? 0,
        isMobile: false,
      })
    } catch (error) {
      if (!(error instanceof MatchtraderApiError) || !error.uncertain) throw error
      // No usable answer. Look for the new position; never send it again from here.
      await this.sleep(FILL_POLL_MS)
      const hit = await this.findNewPosition(st, before, inst, side, qty).catch(() => null)
      if (!hit) {
        st.uncertain.set(key, { before, kind: 'position' })
        throw withCause(`MatchTrader did not confirm the ${inst.symbol} order (${friendlyMatchtraderError(error)}); it was not sent again`, error)
      }
      this.rememberTag(st, [hit.id], entry())
      return this.positionResult({ kind: 'position', row: hit, orderId: hit.id }, ctx)
    }

    const landed = await this.confirmFill(st, orderId, before, inst, side, qty)
    if (!landed) {
      st.uncertain.set(key, { before, kind: 'position' })
      throw new Error(`MatchTrader accepted order ${orderId} but its position could not be confirmed`)
    }
    this.rememberTag(st, [orderId, landed.row.id], entry())
    return this.positionResult({ kind: 'position', row: landed.row, orderId }, ctx)
  }

  private positionResult(
    landed: Extract<Landed, { kind: 'position' }>,
    ctx: { args: OrderSendArgs; inst: MatchtraderInstrument; qty: number; price: number | undefined; stopLoss: number | undefined; takeProfit: number | undefined },
  ): OrderResult {
    const ticket = ticketFromId(landed.row.id)
    return {
      ticket,
      positionTicket: ticket,
      orderTicket: ticketFromId(landed.orderId) || ticket,
      openPrice: landed.row.openPrice ?? ctx.price,
      stopLoss: ctx.stopLoss,
      takeProfit: ctx.takeProfit,
      lots: landed.row.lots > 0 ? landed.row.lots : ctx.qty,
      symbol: ctx.inst.symbol,
      orderType: ctx.args.operation,
      comment: ctx.args.comment,
    }
  }

  private pendingResult(
    landed: Extract<Landed, { kind: 'order' }>,
    ctx: { args: OrderSendArgs; inst: MatchtraderInstrument; qty: number; price: number | undefined; stopLoss: number | undefined; takeProfit: number | undefined },
  ): OrderResult {
    const ticket = ticketFromId(landed.row.id)
    return {
      ticket,
      orderTicket: ticket,
      openPrice: ctx.price,
      stopLoss: ctx.stopLoss,
      takeProfit: ctx.takeProfit,
      lots: ctx.qty,
      symbol: ctx.inst.symbol,
      orderType: ctx.args.operation,
      state: 'Placed',
      comment: ctx.args.comment,
    }
  }

  /** A position that did not exist in `before` and matches the entry. Newest wins. */
  private async findNewPosition(
    st: AccountState,
    before: Set<string>,
    inst: MatchtraderInstrument,
    side: 'BUY' | 'SELL',
    qty: number,
  ): Promise<PositionRow | null> {
    return this.findNewPositionIn(await this.readPositions(st), before, inst, side, qty)
  }

  private async findNewPending(
    st: AccountState,
    before: Set<string>,
    inst: MatchtraderInstrument,
    side: 'BUY' | 'SELL',
    type: string,
    qty: number,
  ): Promise<PendingRow | null> {
    const wantSide = side === 'SELL' ? 'sell' : 'buy'
    const symbolKey = normalizeSymbolKey(inst.symbol)
    const hits = (await this.readPending(st)).filter(row =>
      !before.has(tagKey(row.id))
      && row.side === wantSide
      && row.type.toLowerCase().includes(type)
      && normalizeSymbolKey(row.symbol) === symbolKey
      && Math.abs(row.lots - qty) < 1e-6,
    )
    return hits[0] ?? null
  }

  /**
   * The open response is only an acknowledgement. Look for the position by the returned order id (the
   * position id is expected to match), then by any new position that fits the entry.
   */
  private async confirmFill(
    st: AccountState,
    orderId: string,
    before: Set<string>,
    inst: MatchtraderInstrument,
    side: 'BUY' | 'SELL',
    qty: number,
  ): Promise<Extract<Landed, { kind: 'position' }> | null> {
    for (let attempt = 0; attempt < FILL_POLLS; attempt += 1) {
      const positions = await this.readPositions(st)
      const direct = positions.find(row => tagKey(row.id) === tagKey(orderId))
      if (direct) return { kind: 'position', row: direct, orderId }
      const similar = await this.findNewPositionIn(positions, before, inst, side, qty)
      if (similar) return { kind: 'position', row: similar, orderId }
      if (attempt < FILL_POLLS - 1) await this.sleep(FILL_POLL_MS)
    }
    return null
  }

  private findNewPositionIn(
    positions: PositionRow[],
    before: Set<string>,
    inst: MatchtraderInstrument,
    side: 'BUY' | 'SELL',
    qty: number,
  ): PositionRow | null {
    const wantSide = side === 'SELL' ? 'sell' : 'buy'
    const symbolKey = normalizeSymbolKey(inst.symbol)
    const hits = positions.filter(row =>
      !before.has(tagKey(row.id))
      && row.side === wantSide
      && normalizeSymbolKey(row.symbol) === symbolKey
      && Math.abs(row.lots - qty) < 1e-6,
    )
    hits.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
    return hits[0] ?? null
  }

  // ── Positions and protection ────────────────────────────────────────────

  private async findTicket(st: AccountState, ticket: number): Promise<Found> {
    const positions = await this.readPositions(st)
    const direct = positions.find(row => ticketFromId(row.id) === ticket)
    if (direct) return { kind: 'position', row: direct }
    const pending = (await this.readPending(st)).find(row => ticketFromId(row.id) === ticket)
    if (pending) return { kind: 'order', row: pending }
    throw new Error(`MatchTrader unknown ticket ${ticket}: ${GONE}`)
  }

  /** undefined / null leaves a side alone, a price sets it, 0 or less removes it. */
  private protectionIntent(value: number | null | undefined, inst: MatchtraderInstrument): number | 'remove' | undefined {
    if (value == null) return undefined
    const n = Number(value)
    if (!Number.isFinite(n)) return undefined
    if (n <= 0) return 'remove'
    return roundPrice(n, inst)
  }

  private async modifyPosition(
    st: AccountState,
    row: PositionRow,
    inst: MatchtraderInstrument,
    args: OrderModifyArgs,
  ): Promise<OrderResult> {
    const wantSl = this.protectionIntent(args.stoploss, inst)
    const wantTp = this.protectionIntent(args.takeprofit, inst)
    // The edit takes both prices, with 0 meaning none, so the side we are not changing is sent as it is now.
    const sl = wantSl === undefined ? row.stopLoss ?? 0 : wantSl === 'remove' ? 0 : wantSl
    const tp = wantTp === undefined ? row.takeProfit ?? 0 : wantTp === 'remove' ? 0 : wantTp
    if (wantSl !== undefined || wantTp !== undefined) {
      await st.client.editPosition({
        instrument: row.symbol,
        id: row.id,
        orderSide: row.side === 'sell' ? 'SELL' : 'BUY',
        volume: row.lots,
        slPrice: sl,
        tpPrice: tp,
        isMobile: false,
      })
    }
    return {
      ticket: args.ticket,
      positionTicket: args.ticket,
      stopLoss: sl > 0 ? sl : undefined,
      takeProfit: tp > 0 ? tp : undefined,
      symbol: row.symbol,
      lots: row.lots,
    }
  }

  private async modifyPending(
    st: AccountState,
    row: PendingRow,
    inst: MatchtraderInstrument,
    args: OrderModifyArgs,
  ): Promise<OrderResult> {
    const wantSl = this.protectionIntent(args.stoploss, inst)
    const wantTp = this.protectionIntent(args.takeprofit, inst)
    const sl = wantSl === undefined ? row.stopLoss ?? 0 : wantSl === 'remove' ? 0 : wantSl
    const tp = wantTp === undefined ? row.takeProfit ?? 0 : wantTp === 'remove' ? 0 : wantTp
    let price = row.price
    const wantPrice = positive(args.price)
    if (wantPrice != null) price = roundPrice(wantPrice, inst)
    if (args.price != null || wantSl !== undefined || wantTp !== undefined) {
      await st.client.editPending({
        instrument: row.symbol,
        id: row.id,
        orderSide: row.side === 'sell' ? 'SELL' : 'BUY',
        type: row.type.toUpperCase(),
        volume: row.lots,
        slPrice: sl,
        tpPrice: tp,
        priceOrder: price ?? 0,
        isMobile: false,
      })
    }
    return {
      ticket: args.ticket,
      orderTicket: args.ticket,
      openPrice: price,
      stopLoss: sl > 0 ? sl : undefined,
      takeProfit: tp > 0 ? tp : undefined,
      symbol: row.symbol,
      lots: row.lots,
      state: 'Placed',
    }
  }

  /** Close price and money from the closed-positions list. A missing row never fails a close that went through. */
  private async closeFill(
    st: AccountState,
    row: PositionRow,
    since: number,
  ): Promise<{ closePrice: number | undefined; profit: number | undefined; swap: number | undefined; commission: number | undefined } | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const closed = await st.client.closedPositions(since - 5 * 60_000, this.now() + 5 * 60_000)
        const mine = closed
          .filter(item => tagKey(item.id) === tagKey(row.id))
          .sort((a, b) => (parseServerTime(b.time) ?? 0) - (parseServerTime(a.time) ?? 0))
        const latest = mine[0]
        if (latest) {
          return {
            closePrice: positive(finite(latest.closePrice)),
            profit: finite(latest.profit),
            swap: finite(latest.swap),
            commission: finite(latest.commission),
          }
        }
      } catch {
        return undefined
      }
      if (attempt < 2) await this.sleep(FILL_POLL_MS)
    }
    return undefined
  }
}

export function createMatchtraderProvider(options?: MatchtraderProviderOptions): MatchtraderProvider {
  return new MatchtraderProvider(options)
}

let singleton: MatchtraderProvider | undefined

export function getMatchtraderProvider(): MatchtraderProvider {
  if (!singleton) {
    singleton = new MatchtraderProvider({
      loadCredentials: async accountId => {
        const { loadMatchtraderCredential } = await import('./matchtrader/credentials')
        return loadMatchtraderCredential(accountId)
      },
      tagStore: {
        load: async brokerAccountId => (await import('./matchtrader/credentials')).supabaseTagStore.load(brokerAccountId),
        put: async (brokerAccountId, orderId, entry) => (await import('./matchtrader/credentials')).supabaseTagStore.put(brokerAccountId, orderId, entry),
      },
    })
  }
  return singleton
}
