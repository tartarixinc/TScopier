/**
 * Phase 1 broker seam.
 *
 * The interface deliberately mirrors the FXSocket API shapes consumed by the
 * worker. Phase 1 is transport plumbing only: callers must see the same
 * arguments and return values they saw before the seam was introduced.
 */
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
import type { MtHistoryProfile } from './mtTradeFields'
import type { BrokerAccountMode } from './copyShared/brokerAccountMode'

export type BrokerProviderName = 'fxsocket' | 'mtapi' | 'ctrader' | 'binance' | 'bybit' | 'kucoin' | 'dxtrade' | 'tradelocker' | 'matchtrader'

export type {
  AccountSummary as BrokerAccountSummary,
  MtPlatform,
  OrderCloseArgs,
  OrderModifyArgs,
  OrderResult as BrokerOrderResult,
  OrderSendArgs,
  QuoteResult as BrokerQuote,
  SymbolParams as BrokerSymbolParams,
}

export interface BrokerProvider {
  readonly name: BrokerProviderName

  seedPlatformCache(id: string, platform: MtPlatform | string | null | undefined): void
  getV1Account(id: string): ReturnType<FxsocketBrokerClient['getV1Account']>
  connectEx(args: { id: string; server: string; login: string; password: string; platform?: MtPlatform }): Promise<string>
  connectByToken(id: string): Promise<void>
  ensureConnected(id: string): Promise<void>
  checkConnect(id: string): Promise<void>
  disconnect(id: string): Promise<void>
  keepSessionAlive(id: string): Promise<boolean>
  keepSessionAliveDetailed(id: string): ReturnType<FxsocketBrokerClient['keepSessionAliveDetailed']>
  verifyTradingReady(id: string): Promise<boolean>

  orderSend(id: string, args: OrderSendArgs): Promise<OrderResult>
  orderModify(id: string, args: OrderModifyArgs): Promise<OrderResult>
  orderClose(id: string, args: OrderCloseArgs): Promise<OrderResult>

  openedOrders(id: string): Promise<unknown[]>
  closedOrders(id: string): Promise<unknown[]>
  orderHistory(id: string, from: string, to: string, timeoutMs?: number): Promise<unknown[]>
  historyPositions(id: string, from: string, to: string): Promise<unknown[]>
  orderHistoryPage(
    id: string,
    from: string,
    to: string,
    pageNumber: number,
    ordersPerPage?: number,
  ): Promise<{ orders: unknown[]; pagesCount: number }>
  closedOrdersHistory(
    id: string,
    from: string,
    to: string,
    profile?: MtHistoryProfile,
  ): Promise<unknown[]>
  closedOrdersHistoryLite(
    id: string,
    from: string,
    to: string,
    profile?: MtHistoryProfile,
    maxPages?: number,
    ordersPerPage?: number,
  ): Promise<unknown[]>

  accountSummary(id: string): Promise<AccountSummary>
  /**
   * Hedging vs netting for this account, asked of the venue itself.
   *
   * Optional on purpose: only providers that can answer authoritatively
   * implement it (the crypto venues read their position mode; the MT and FX
   * platforms either report it elsewhere or have no such field). Callers treat
   * a missing method, a null and a thrown error the same way — "unknown" — and
   * must keep failing closed on unknown rather than assuming a mode.
   */
  accountMode?(id: string): Promise<BrokerAccountMode | null>
  /**
   * Whether the venue still holds a position for this symbol and side.
   *
   * Used to confirm that a source trade is gone on venues whose closed history
   * cannot name the ticket we track (no per-position id, so a stop-loss or a
   * manual close is recorded against the closing order). "Flat for that symbol
   * and side" proves the ticket is gone; "still holding" and "could not answer"
   * both mean unconfirmed, so the copy must stay open.
   */
  stillHoldsPosition?(id: string, symbol: string, side: 'buy' | 'sell'): Promise<boolean | null>
  quote(id: string, symbol: string): Promise<QuoteResult>
  symbolParams(id: string, symbol: string): Promise<SymbolParams>
  symbols(id: string): Promise<unknown[]>
  mtStatus(id: string, platformHint?: MtPlatform): Promise<FxsocketMtStatus>
  terminalStatus(id: string, platformHint?: MtPlatform): Promise<FxsocketTerminalStatus>
}
