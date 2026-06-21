import type { BrokerAccount } from '../types/database'

export type BrokerStatsAccountPreview = Pick<
  BrokerAccount,
  | 'id'
  | 'label'
  | 'broker_name'
  | 'broker_server'
  | 'platform'
  | 'connection_status'
  | 'last_currency'
  | 'performance_baseline_balance'
  | 'performance_baseline_captured_at'
  | 'metaapi_account_id'
  | 'last_balance'
  | 'last_equity'
  | 'is_active'
>

export type BrokerStatsRouteState = {
  accountPreview?: BrokerStatsAccountPreview
}

export function brokerStatsPreviewFromAccount(account: BrokerAccount): BrokerStatsAccountPreview {
  return {
    id: account.id,
    label: account.label,
    broker_name: account.broker_name,
    broker_server: account.broker_server,
    platform: account.platform,
    connection_status: account.connection_status,
    last_currency: account.last_currency,
    performance_baseline_balance: account.performance_baseline_balance,
    performance_baseline_captured_at: account.performance_baseline_captured_at,
    metaapi_account_id: account.metaapi_account_id,
    last_balance: account.last_balance,
    last_equity: account.last_equity,
    is_active: account.is_active,
  }
}
