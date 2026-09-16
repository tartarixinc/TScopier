/** Lossless BrokerProvider adapter for the existing FXSocket client. */
import type {
  AccountSummary,
  FxsocketBrokerClient,
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
import { getFxsocketClient } from './fxsocketClient'
import type { BrokerProvider } from './brokerProvider'
import type { MtHistoryProfile } from './mtTradeFields'

export class FxsocketProvider implements BrokerProvider {
  readonly name = 'fxsocket' as const

  constructor(readonly client: FxsocketBrokerClient) {}

  seedPlatformCache(id: string, platform: MtPlatform | string | null | undefined): void {
    this.client.seedPlatformCache(id, platform)
  }
  getV1Account(id: string): ReturnType<FxsocketBrokerClient['getV1Account']> {
    return this.client.getV1Account(id)
  }
  connectEx(args: { id: string; server: string; login: string; password: string; platform?: MtPlatform }): Promise<string> {
    return this.client.connectEx(args)
  }
  connectByToken(id: string): Promise<void> { return this.client.connectByToken(id) }
  ensureConnected(id: string): Promise<void> { return this.client.ensureConnected(id) }
  checkConnect(id: string): Promise<void> { return this.client.checkConnect(id) }
  disconnect(id: string): Promise<void> { return this.client.disconnect(id) }
  keepSessionAlive(id: string): Promise<boolean> { return this.client.keepSessionAlive(id) }
  keepSessionAliveDetailed(id: string): ReturnType<FxsocketBrokerClient['keepSessionAliveDetailed']> {
    return this.client.keepSessionAliveDetailed(id)
  }
  verifyTradingReady(id: string): Promise<boolean> { return this.client.verifyTradingReady(id) }
  orderSend(id: string, args: OrderSendArgs): Promise<OrderResult> { return this.client.orderSend(id, args) }
  orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult> { return this.client.orderModify(id, args) }
  orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult> { return this.client.orderClose(id, args) }
  openedOrders(id: string): Promise<unknown[]> { return this.client.openedOrders(id) }
  closedOrders(id: string): Promise<unknown[]> { return this.client.closedOrders(id) }
  orderHistory(id: string, from: string, to: string): Promise<unknown[]> {
    return this.client.orderHistory(id, from, to)
  }
  historyPositions(id: string, from: string, to: string): Promise<unknown[]> {
    return this.client.historyPositions(id, from, to)
  }
  orderHistoryPage(id: string, from: string, to: string, pageNumber: number, ordersPerPage?: number): Promise<{ orders: unknown[]; pagesCount: number }> {
    return this.client.orderHistoryPage(id, from, to, pageNumber, ordersPerPage)
  }
  closedOrdersHistory(id: string, from: string, to: string, profile?: MtHistoryProfile): Promise<unknown[]> {
    return this.client.closedOrdersHistory(id, from, to, profile)
  }
  closedOrdersHistoryLite(id: string, from: string, to: string, profile?: MtHistoryProfile, maxPages?: number, ordersPerPage?: number): Promise<unknown[]> {
    return this.client.closedOrdersHistoryLite(id, from, to, profile, maxPages, ordersPerPage)
  }
  accountSummary(id: string): Promise<AccountSummary> { return this.client.accountSummary(id) }
  quote(id: string, symbol: string): Promise<QuoteResult> { return this.client.quote(id, symbol) }
  symbolParams(id: string, symbol: string): Promise<SymbolParams> { return this.client.symbolParams(id, symbol) }
  symbols(id: string): Promise<unknown[]> { return this.client.symbols(id) }
  mtStatus(id: string, platformHint?: MtPlatform): Promise<FxsocketMtStatus> {
    return this.client.mtStatus(id, platformHint)
  }
  terminalStatus(id: string, platformHint?: MtPlatform): Promise<FxsocketTerminalStatus> {
    return this.client.terminalStatus(id, platformHint)
  }
}

/** Preserve the existing authoritative null when FXSocket is not configured. */
export function createFxsocketProvider(): FxsocketProvider | null {
  const client = getFxsocketClient()
  return client ? new FxsocketProvider(client) : null
}
