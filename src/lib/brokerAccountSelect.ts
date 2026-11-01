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
  'total_deposits',
  'total_withdrawals',
  'cashflow_synced_at',
  'day_start_balance',
  'day_start_balance_on',
  'is_active',
  'copier_mode',
  'signal_channel_ids',
  'copy_source',
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
  'provider',
  'mtapi_status',
  'ctrader_account_id',
  'ctrader_environment',
  'ctrader_status',
  'binance_account_id',
  'binance_environment',
  'binance_status',
  'binance_margin_usdt',
  'binance_leverage',
  'binance_margin_mode',
  'bybit_account_id',
  'bybit_environment',
  'bybit_status',
  'bybit_margin_usdt',
  'bybit_leverage',
  'kucoin_account_id',
  'kucoin_status',
  'kucoin_margin_usdt',
  'kucoin_leverage',
  'kucoin_margin_mode',
  'dxtrade_account_id',
  'dxtrade_server_url',
  'dxtrade_username',
  'dxtrade_domain',
  'dxtrade_account_code',
  'dxtrade_status',
  'dxtrade_is_position_based',
  'tradelocker_account_id',
  'tradelocker_environment',
  'tradelocker_server',
  'tradelocker_account_ref',
  'tradelocker_status',
  'matchtrader_account_id',
  'matchtrader_server_url',
  'matchtrader_broker_id',
  'matchtrader_trading_account_uuid',
  'matchtrader_status',
  'linked_account_type',
].join(',')

/** Same list without `copy_source`, for databases that have not received that column yet. */
export const BROKER_ACCOUNT_CLIENT_SELECT_WITHOUT_COPY_SOURCE = BROKER_ACCOUNT_CLIENT_SELECT
  .split(',')
  .filter(column => column !== 'copy_source')
  .join(',')

export function missingCopySourceColumn(message: string): boolean {
  return /copy_source/i.test(message) && /schema cache|does not exist/i.test(message)
}

export function missingCtraderColumns(message: string): boolean {
  return /ctrader_(account_id|environment|status)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

export function missingBinanceColumns(message: string): boolean {
  return /binance_(account_id|environment|status|margin_usdt|leverage|margin_mode)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

export function missingBybitColumns(message: string): boolean {
  return /bybit_(account_id|environment|status|margin_usdt|leverage)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

export function missingKucoinColumns(message: string): boolean {
  return /kucoin_(account_id|status|margin_usdt|leverage|margin_mode)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

export function missingDxtradeColumns(message: string): boolean {
  return /dxtrade_(account_id|server_url|username|domain|account_code|status|is_position_based)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

export function missingTradelockerColumns(message: string): boolean {
  return /tradelocker_(account_id|environment|server|account_ref|status)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

export function missingMatchtraderColumns(message: string): boolean {
  return /matchtrader_(account_id|server_url|broker_id|trading_account_uuid|status)/i.test(message)
    && /schema cache|does not exist|column/i.test(message)
}

function columnsAfterSchemaError(columns: string, message: string): string | null {
  const drop = new Set<string>()
  if (missingCopySourceColumn(message)) drop.add('copy_source')
  if (missingCtraderColumns(message)) {
    drop.add('ctrader_account_id')
    drop.add('ctrader_environment')
    drop.add('ctrader_status')
  }
  if (missingBinanceColumns(message)) {
    for (const column of [
      'binance_account_id',
      'binance_environment',
      'binance_status',
      'binance_margin_usdt',
      'binance_leverage',
      'binance_margin_mode',
    ]) drop.add(column)
  }
  if (missingBybitColumns(message)) {
    for (const column of [
      'bybit_account_id',
      'bybit_environment',
      'bybit_status',
      'bybit_margin_usdt',
      'bybit_leverage',
    ]) drop.add(column)
  }
  if (missingKucoinColumns(message)) {
    for (const column of [
      'kucoin_account_id',
      'kucoin_status',
      'kucoin_margin_usdt',
      'kucoin_leverage',
      'kucoin_margin_mode',
    ]) drop.add(column)
  }
  if (missingDxtradeColumns(message)) {
    for (const column of [
      'dxtrade_account_id',
      'dxtrade_server_url',
      'dxtrade_username',
      'dxtrade_domain',
      'dxtrade_account_code',
      'dxtrade_status',
      'dxtrade_is_position_based',
    ]) drop.add(column)
  }
  if (missingTradelockerColumns(message)) {
    for (const column of [
      'tradelocker_account_id',
      'tradelocker_environment',
      'tradelocker_server',
      'tradelocker_account_ref',
      'tradelocker_status',
    ]) drop.add(column)
  }
  if (missingMatchtraderColumns(message)) {
    for (const column of [
      'matchtrader_account_id',
      'matchtrader_server_url',
      'matchtrader_broker_id',
      'matchtrader_trading_account_uuid',
      'matchtrader_status',
    ]) drop.add(column)
  }
  if (drop.size === 0) return null
  const next = columns.split(',').map(column => column.trim()).filter(column => !drop.has(column)).join(',')
  return next === columns ? null : next
}

/** Read broker rows, and retry without columns this database has not received yet. */
export async function selectBrokerAccountColumns<T>(
  run: (columns: string) => PromiseLike<{ data: T; error: { message: string } | null }>,
): Promise<{ data: T; error: { message: string } | null }> {
  let columns = BROKER_ACCOUNT_CLIENT_SELECT
  let result = await run(columns)
  for (let attempt = 0; attempt < 3 && result.error; attempt += 1) {
    const next = columnsAfterSchemaError(columns, result.error.message)
    if (!next) break
    columns = next
    result = await run(columns)
  }
  return result
}
