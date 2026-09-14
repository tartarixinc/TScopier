/**
 * FxsocketProvider — BrokerProvider implementation wrapping the existing
 * FxsocketBrokerClient. Drop-in wrapper; no behaviour change.
 */
import {
  type BrokerProvider,
  type BrokerProviderName,
  type BrokerAccountSummary,
  type BrokerQuote,
  type BrokerSymbolParams,
  type BrokerOrderResult,
  type BrokerOpenedOrder,
  type MtPlatform,
} from './brokerProvider'
import { getFxsocketClient, type FxsocketBrokerClient } from './fxsocketClient'

export class FxsocketProvider implements BrokerProvider {
  readonly name: BrokerProviderName = 'fxsocket'
  private client: FxsocketBrokerClient

  constructor(client?: FxsocketBrokerClient) {
    this.client = client ?? getFxsocketClient()!
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  async connect(args: {
    user: string
    password: string
    server?: string
    host?: string
    port?: number
    platform: MtPlatform
  }): Promise<string> {
    if (args.server) {
      return this.client.connectEx({
        id: args.user,
        server: args.server,
        login: args.user,
        password: args.password,
      })
    }
    // Fallback: connectEx with server derived from host/port is not supported;
    // callers should always provide server.
    throw new Error('FxsocketProvider.connect requires server name')
  }

  async ensureConnected(id: string): Promise<void> {
    return this.client.ensureConnected(id)
  }

  async checkConnect(id: string): Promise<void> {
    return this.client.checkConnect(id)
  }

  async disconnect(_id: string): Promise<void> {
    // FxSocket sessions are server-side; no client-side disconnect needed.
    void _id
  }

  async keepSessionAlive(id: string): Promise<boolean> {
    return this.client.keepSessionAlive(id)
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  async orderSend(id: string, args: {
    symbol: string
    operation: string
    volume: number
    price?: number | null
    slippage?: number
    stoploss?: number | null
    takeprofit?: number | null
    comment?: string
  }): Promise<BrokerOrderResult> {
    const result = await this.client.orderSend(id, {
      symbol: args.symbol,
      operation: args.operation as never,
      volume: args.volume,
      price: args.price ?? null,
      slippage: args.slippage,
      stoploss: args.stoploss ?? null,
      takeprofit: args.takeprofit ?? null,
      comment: args.comment,
    })
    return normalizeOrderResult(result)
  }

  async orderModify(id: string, args: {
    ticket: number
    stoploss?: number | null
    takeprofit?: number | null
    price?: number | null
  }): Promise<BrokerOrderResult> {
    const result = await this.client.orderModify(id, {
      ticket: args.ticket,
      stoploss: args.stoploss ?? null,
      takeprofit: args.takeprofit ?? null,
      price: args.price ?? null,
    })
    return normalizeOrderResult(result)
  }

  async orderClose(id: string, args: {
    ticket: number
    lots?: number
    price?: number
    slippage?: number
  }): Promise<BrokerOrderResult> {
    const result = await this.client.orderClose(id, {
      ticket: args.ticket,
      lots: args.lots,
      price: args.price,
      slippage: args.slippage,
    })
    return normalizeOrderResult(result)
  }

  // ── Data reads ────────────────────────────────────────────────────────────

  async openedOrders(id: string): Promise<BrokerOpenedOrder[]> {
    const raw = await this.client.openedOrders(id)
    return raw.filter((o): o is BrokerOpenedOrder => o != null && typeof o === 'object')
  }

  async closedOrders(id: string): Promise<unknown[]> {
    return this.client.closedOrders(id)
  }

  async orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    return this.client.orderHistory(id, from, to)
  }

  async historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    return this.client.historyPositions(id, from, to)
  }

  // ── Account ───────────────────────────────────────────────────────────────

  async accountSummary(id: string): Promise<BrokerAccountSummary> {
    const raw = await this.client.accountSummary(id)
    return {
      balance: raw.balance,
      credit: raw.credit,
      profit: raw.profit,
      equity: raw.equity,
      margin: raw.margin,
      freeMargin: raw.freeMargin,
      marginLevel: raw.marginLevel,
      leverage: raw.leverage,
      currency: raw.currency,
    }
  }

  // ── Market ────────────────────────────────────────────────────────────────

  async quote(id: string, symbol: string): Promise<BrokerQuote> {
    return this.client.quote(id, symbol)
  }

  async symbolParams(id: string, symbol: string): Promise<BrokerSymbolParams> {
    const raw = await this.client.symbolParams(id, symbol)
    return {
      symbolName: raw.symbolName,
      digits: raw.symbol?.digits,
      point: raw.symbol?.point,
      contractSize: raw.symbol?.contractSize,
      stopsLevel: raw.symbol?.stopsLevel,
      freezeLevel: raw.symbol?.freezeLevel,
      minLot: raw.groupParams?.minLot,
      maxLot: raw.groupParams?.maxLot,
      lotStep: raw.groupParams?.lotStep,
    }
  }

  async symbols(id: string): Promise<unknown[]> {
    return this.client.symbols(id)
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async mtStatus(id: string): Promise<unknown> {
    return this.client.mtStatus(id)
  }

  async terminalStatus(id: string): Promise<unknown> {
    return this.client.terminalStatus(id)
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeOrderResult(raw: {
  ticket?: number
  openPrice?: number
  stopLoss?: number
  takeProfit?: number
  lots?: number
  symbol?: string
  orderType?: string
  state?: string
  closePrice?: number
  profit?: number
  swap?: number
  commission?: number
  fee?: number
  comment?: string
}): BrokerOrderResult {
  return {
    ticket: raw.ticket ?? 0,
    openPrice: raw.openPrice,
    stopLoss: raw.stopLoss,
    takeProfit: raw.takeProfit,
    lots: raw.lots,
    symbol: raw.symbol,
    orderType: raw.orderType,
    state: raw.state,
    closePrice: raw.closePrice,
    profit: raw.profit,
    swap: raw.swap,
    commission: raw.commission,
    fee: raw.fee,
    comment: raw.comment,
  }
}

/** Factory: create FxsocketProvider from the global singleton. */
export function createFxsocketProvider(): FxsocketProvider {
  return new FxsocketProvider()
}
