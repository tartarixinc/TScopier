/**
 * BrokerProvider — unified interface for broker operations.
 *
 * Every broker operation (session lifecycle, orders, reads, health) goes through
 * this interface. FxsocketProvider wraps the existing FXSocket client.
 * MtapiProvider (Phase 2) will wrap MTAPI.
 *
 * Execution safety (idempotent send, ambiguous recovery) sits ABOVE this layer
 * in the trade executor — the provider is a transport, not a safety mechanism.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type BrokerProviderName = 'fxsocket' | 'mtapi'

/** MetaTrader platform. Defined here to avoid coupling the interface to FxSocket. */
export type MtPlatform = 'MT4' | 'MT5'

export interface BrokerAccountSummary {
  balance?: number
  credit?: number
  profit?: number
  equity?: number
  margin?: number
  freeMargin?: number
  marginLevel?: number
  leverage?: number
  currency?: string
  synced?: boolean
}

export interface BrokerQuote {
  symbol: string
  bid: number
  ask: number
  time?: string
}

export interface BrokerSymbolParams {
  symbolName?: string
  digits?: number
  point?: number
  contractSize?: number
  stopsLevel?: number
  freezeLevel?: number
  minLot?: number
  maxLot?: number
  lotStep?: number
}

export interface BrokerOrderResult {
  ticket: number
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
}

export interface BrokerOpenedOrder {
  ticket: number
  symbol: string
  operation: string
  isBuy: boolean
  volume: number
  openPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  [key: string]: unknown
}

// ── Interface ────────────────────────────────────────────────────────────────

export interface BrokerProvider {
  readonly name: BrokerProviderName

  // Session lifecycle
  connect(args: {
    user: string
    password: string
    server?: string
    host?: string
    port?: number
    platform: MtPlatform
  }): Promise<string>
  ensureConnected(id: string): Promise<void>
  checkConnect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  keepSessionAlive(id: string): Promise<boolean>

  // Orders
  orderSend(id: string, args: {
    symbol: string
    operation: string
    volume: number
    price?: number | null
    slippage?: number
    stoploss?: number | null
    takeprofit?: number | null
    comment?: string
  }): Promise<BrokerOrderResult>
  orderModify(id: string, args: {
    ticket: number
    stoploss?: number | null
    takeprofit?: number | null
    price?: number | null
  }): Promise<BrokerOrderResult>
  orderClose(id: string, args: {
    ticket: number
    lots?: number
    price?: number
    slippage?: number
  }): Promise<BrokerOrderResult>

  // Data reads
  openedOrders(id: string): Promise<BrokerOpenedOrder[]>
  closedOrders(id: string): Promise<unknown[]>
  orderHistory(id: string, from: string, to: string): Promise<unknown[]>
  historyPositions(id: string, from: string, to: string): Promise<unknown[]>

  // Account
  accountSummary(id: string): Promise<BrokerAccountSummary>

  // Market
  quote(id: string, symbol: string): Promise<BrokerQuote>
  symbolParams(id: string, symbol: string): Promise<BrokerSymbolParams>
  symbols(id: string): Promise<unknown[]>

  // Health
  mtStatus(id: string): Promise<unknown>
  terminalStatus(id: string): Promise<unknown>
}
