/**
 * A dormant-subscription cleanup can deliberately remove the FxSocket remote
 * session while retaining the broker and its trade history for audit. These
 * four persisted fields are the explicit cleanup signature. Keep this narrow:
 * a broker that is merely reconnecting must continue to use remote operations.
 */
export interface RemoteBrokerState {
  fxsocket_status?: string | null
  connection_status?: string | null
  terminal_connected?: boolean | null
  trade_allowed?: boolean | null
}

export function isExplicitlyUnavailableRemoteBroker(broker: RemoteBrokerState | null | undefined): boolean {
  return broker?.fxsocket_status === 'disconnected'
    && broker.connection_status === 'error'
    && broker.terminal_connected === false
    && broker.trade_allowed === false
}

/** Return only brokers for which remote FxSocket work remains meaningful. */
export function availableRemoteBrokers<T extends RemoteBrokerState>(brokers: readonly T[]): T[] {
  return brokers.filter(broker => !isExplicitlyUnavailableRemoteBroker(broker))
}
