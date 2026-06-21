import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type ChannelTradingConfigsMap,
  normalizeChannelTradingConfigsMap,
  normalizeChannelUuid,
} from './channelTradingConfig'
import { normalizeCopyLimitState } from './copyLimitTypes'

export interface BrokerChannelTradingConfigRow {
  broker_account_id: string
  channel_id: string
  copier_mode: 'ai' | 'manual' | string
  manual_settings: Record<string, unknown>
  ai_settings: Record<string, unknown>
  copy_limit_state?: Record<string, unknown>
}

const BROKER_CHANNEL_TRADING_CONFIG_SELECT =
  'broker_account_id,channel_id,copier_mode,manual_settings,ai_settings,copy_limit_state'

function ensurePersistedManualSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const schemaVersion = Number(settings.schema_version ?? 1)
  return {
    ...settings,
    schema_version: Number.isFinite(schemaVersion) && schemaVersion > 0 ? schemaVersion : 1,
  }
}

export function channelTradingConfigsMapFromRows(
  rows: BrokerChannelTradingConfigRow[],
): ChannelTradingConfigsMap {
  const out: ChannelTradingConfigsMap = {}
  for (const row of rows) {
    const key = normalizeChannelUuid(row.channel_id)
    if (!key) continue
    out[key] = {
      copier_mode: row.copier_mode === 'ai' ? 'ai' : 'manual',
      manual_settings: ensurePersistedManualSettings(
        row.manual_settings && typeof row.manual_settings === 'object'
          ? row.manual_settings
          : {},
      ),
      ai_settings: row.ai_settings && typeof row.ai_settings === 'object' ? row.ai_settings : {},
      copy_limit_state: normalizeCopyLimitState(row.copy_limit_state),
    }
  }
  return out
}

export function mergeChannelTradingConfigsFromTable(
  jsonbConfigs: unknown,
  tableRows: BrokerChannelTradingConfigRow[],
): Record<string, unknown> {
  const fromTable = channelTradingConfigsMapFromRows(tableRows)
  const jsonbMap = normalizeChannelTradingConfigsMap(jsonbConfigs)
  return { ...jsonbMap, ...fromTable }
}

export async function fetchBrokerChannelTradingConfigRows(
  supabase: SupabaseClient,
  brokerAccountIds: string[],
): Promise<BrokerChannelTradingConfigRow[]> {
  if (!brokerAccountIds.length) return []
  const { data, error } = await supabase
    .from('broker_channel_trading_configs')
    .select(BROKER_CHANNEL_TRADING_CONFIG_SELECT)
    .in('broker_account_id', brokerAccountIds)

  if (error) {
    console.error('[brokerChannelTradingConfigs] fetch failed:', error.message)
    return []
  }
  return (data ?? []) as BrokerChannelTradingConfigRow[]
}

/** Latest per-channel row — table wins over stale `broker_accounts.channel_trading_configs`. */
export async function fetchBrokerChannelTradingConfigRow(
  supabase: SupabaseClient,
  brokerAccountId: string,
  channelId: string,
): Promise<BrokerChannelTradingConfigRow | null> {
  const key = normalizeChannelUuid(channelId)
  if (!key) return null
  const { data, error } = await supabase
    .from('broker_channel_trading_configs')
    .select(BROKER_CHANNEL_TRADING_CONFIG_SELECT)
    .eq('broker_account_id', brokerAccountId)
    .eq('channel_id', key)
    .maybeSingle()

  if (error) {
    console.warn(
      `[brokerChannelTradingConfigs] fetch row failed broker=${brokerAccountId} channel=${key}: ${error.message}`,
    )
    return null
  }
  return (data ?? null) as BrokerChannelTradingConfigRow | null
}

export function applyBrokerChannelTradingConfigRow<T extends { channel_trading_configs?: unknown }>(
  broker: T,
  configRow: BrokerChannelTradingConfigRow,
): T {
  return {
    ...broker,
    channel_trading_configs: mergeChannelTradingConfigsFromTable(
      broker.channel_trading_configs,
      [configRow],
    ),
  }
}

/**
 * Merge the persisted per-channel table row into a cached broker before execution.
 * UI saves land in `broker_channel_trading_configs` without touching `broker_accounts`,
 * so the in-memory cache can miss `range_trading` / leg caps until restart.
 */
export async function fetchFreshBrokerForChannel<T extends { id: string; channel_trading_configs?: unknown }>(
  supabase: SupabaseClient,
  broker: T,
  channelId: string | null | undefined,
): Promise<T> {
  if (!channelId) return broker
  const row = await fetchBrokerChannelTradingConfigRow(supabase, broker.id, channelId)
  if (!row) return broker
  return applyBrokerChannelTradingConfigRow(broker, row)
}
