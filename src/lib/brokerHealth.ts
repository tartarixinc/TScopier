import type { BrokerAccount } from '../types/database'
import { parseMtAccountTradeMode } from './brokerFromServer'
import {
  isFxsocketMtStatusHealthy,
  terminalHealthRowPatchFromMtStatus,
  type FxsocketMtStatus,
} from './fxsocketMtStatus'

export type BrokerTerminalHealthPhase = 'healthy' | 'unhealthy' | 'checking' | 'paused'

type BrokerTerminalHealthLabels = {
  statusHealthy: string
  statusUnhealthy: string
  statusHealthChecking: string
}

function isBrokerLinking(
  account: Pick<BrokerAccount, 'connection_status' | 'fxsocket_status' | 'terminal_connected' | 'trade_allowed' | 'live_terminal_health_phase'> & {
    mtapi_status?: string | null
    ctrader_status?: string | null
    binance_status?: string | null
    bybit_status?: string | null
    kucoin_status?: string | null
    dxtrade_status?: string | null
    tradelocker_status?: string | null
    matchtrader_status?: string | null
  },
): boolean {
  if (account.live_terminal_health_phase === 'healthy' || account.live_terminal_health_phase === 'unhealthy') {
    return false
  }
  if (account.terminal_connected === true && account.trade_allowed === true) return false
  if (account.mtapi_status === 'connected' || account.ctrader_status === 'connected' || account.binance_status === 'connected' || account.bybit_status === 'connected' || account.kucoin_status === 'connected' || account.dxtrade_status === 'connected' || account.tradelocker_status === 'connected' || account.matchtrader_status === 'connected') return false
  if (account.connection_status === 'pending') return true
  const fx = account.fxsocket_status
  return fx === 'connecting' || account.mtapi_status === 'connecting' || account.ctrader_status === 'connecting' || account.binance_status === 'connecting' || account.bybit_status === 'connecting' || account.kucoin_status === 'connecting' || account.dxtrade_status === 'connecting' || account.tradelocker_status === 'connecting' || account.matchtrader_status === 'connecting'
}

export function brokerTerminalHealthPhase(
  account: Pick<
    BrokerAccount,
    | 'is_active'
    | 'connection_status'
    | 'fxsocket_status'
    | 'mtapi_status'
    | 'ctrader_status'
    | 'binance_status'
    | 'bybit_status'
    | 'kucoin_status'
    | 'dxtrade_status'
    | 'tradelocker_status'
    | 'matchtrader_status'
    | 'terminal_connected'
    | 'trade_allowed'
    | 'live_terminal_health_phase'
  >,
): BrokerTerminalHealthPhase {
  if (!account.is_active) return 'paused'
  if (isBrokerLinking(account)) return 'checking'
  if (account.live_terminal_health_phase) return account.live_terminal_health_phase
  if (account.terminal_connected == null || account.trade_allowed == null) return 'checking'
  if (account.terminal_connected === true && account.trade_allowed === true) {
    return 'healthy'
  }
  return 'unhealthy'
}

export function brokerTerminalHealthLabel(
  account: Pick<
    BrokerAccount,
    | 'is_active'
    | 'connection_status'
    | 'fxsocket_status'
    | 'mtapi_status'
    | 'ctrader_status'
    | 'binance_status'
    | 'bybit_status'
    | 'kucoin_status'
    | 'dxtrade_status'
    | 'tradelocker_status'
    | 'matchtrader_status'
    | 'terminal_connected'
    | 'trade_allowed'
    | 'live_terminal_health_phase'
  >,
  labels: BrokerTerminalHealthLabels,
): string | null {
  const phase = brokerTerminalHealthPhase(account)
  if (phase === 'paused') return null
  if (phase === 'healthy') return labels.statusHealthy
  if (phase === 'unhealthy') return labels.statusUnhealthy
  return labels.statusHealthChecking
}

export function brokerTerminalHealthBadgeVariant(
  account: Pick<
    BrokerAccount,
    | 'is_active'
    | 'connection_status'
    | 'fxsocket_status'
    | 'mtapi_status'
    | 'ctrader_status'
    | 'binance_status'
    | 'bybit_status'
    | 'kucoin_status'
    | 'dxtrade_status'
    | 'tradelocker_status'
    | 'matchtrader_status'
    | 'terminal_connected'
    | 'trade_allowed'
    | 'live_terminal_health_phase'
  >,
): 'primary' | 'error' | 'neutral' | null {
  const phase = brokerTerminalHealthPhase(account)
  if (phase === 'paused') return null
  if (phase === 'healthy') return 'primary'
  if (phase === 'unhealthy') return 'error'
  return 'neutral'
}

export function brokerAccountHealthPatchFromMtStatus(
  status: FxsocketMtStatus,
): Pick<
  BrokerAccount,
  'terminal_connected' | 'trade_allowed' | 'live_terminal_health_phase' | 'linked_account_type'
> & {
  connection_status?: 'connected'
} {
  const legacyPatch = terminalHealthRowPatchFromMtStatus(status)
  const healthy = isFxsocketMtStatusHealthy(status)
  return {
    ...legacyPatch,
    live_terminal_health_phase: healthy ? 'healthy' : 'unhealthy',
    linked_account_type: parseMtAccountTradeMode(status.account?.type),
    ...(healthy ? { connection_status: 'connected' as const } : {}),
  }
}
