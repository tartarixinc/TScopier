import type { BrokerAccount } from '../types/database'

/** Linked accounts: newest added first (stable tie-break by id). */
export function sortBrokerAccountsNewestFirst(accounts: BrokerAccount[]): BrokerAccount[] {
  return [...accounts].sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0
    const tb = Date.parse(b.created_at) || 0
    if (tb !== ta) return tb - ta
    return a.id.localeCompare(b.id)
  })
}

/** Columns safe to read from the browser. */
export const BROKER_ACCOUNT_CLIENT_SELECT = [
  'id',
  'user_id',
  'label',
  'platform',
  'metaapi_account_id',
  'fxsocket_account_id',
  'fxsocket_status',
  'terminal_connected',
  'trade_allowed',
  'connection_error',
  'account_login',
  'broker_name',
  'broker_server',
  'connection_status',
  'last_balance',
  'last_equity',
  'last_currency',
  'last_synced_at',
  'performance_baseline_balance',
  'performance_baseline_captured_at',
  'day_start_balance',
  'day_start_balance_on',
  'is_active',
  'copier_mode',
  'signal_channel_ids',
  'enforce_signal_channel_filter',
  'ai_settings',
  'manual_settings',
  'channel_message_filters',
  'channel_trading_configs',
  'default_lot_size',
  'pip_tolerance',
  'max_trades_per_zone',
  'created_at',
  'updated_at',
  'last_activated_at',
].join(',')
