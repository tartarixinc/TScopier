/**
 * Simulated FxSocket / MetaTrader bridge failures after dispatch.
 * FxSocket hosts MT4/MT5 terminals — REST for OrderSend, WebSocket for live streams.
 */
export type BrokerFailureMode =
  | 'none'
  | 'fxsocket_session_down'
  | 'fxsocket_order_send_fail'
  | 'fxsocket_ws_disconnected'

export const BROKER_FAILURE_SKIP_REASON: Record<Exclude<BrokerFailureMode, 'none'>, string> = {
  fxsocket_session_down: 'fxsocket_session_down',
  fxsocket_order_send_fail: 'fxsocket_order_send_failed',
  fxsocket_ws_disconnected: 'fxsocket_ws_disconnected',
}

export function brokerFailureLabel(mode: BrokerFailureMode): string {
  switch (mode) {
    case 'none':
      return 'none'
    case 'fxsocket_session_down':
      return 'FxSocket session expired / heartbeat keepSessionAlive failed'
    case 'fxsocket_order_send_fail':
      return 'FxSocket REST OrderSend rejected'
    case 'fxsocket_ws_disconnected':
      return 'FxSocket WebSocket stream disconnected'
    default:
      return mode
  }
}
