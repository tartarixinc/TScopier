import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerAccount, CopyLimitState, Json, ManualSettings } from '../types/database'
import { normalizeCopyLimitState } from './copyLimitTypes'
import { DEFAULT_MANUAL_SETTINGS, ensurePersistedManualSettings } from './defaultManualSettings'
import {
  type ChannelTradingConfig,
  type ChannelTradingConfigsMap,
  normalizeChannelTradingConfigsMap,
  normalizeChannelUuid,
} from './channelTradingConfig'

export const BROKER_CHANNEL_TRADING_CONFIG_SELECT =
  'id,broker_account_id,channel_id,copier_mode,manual_settings,ai_settings,copy_limit_state,updated_at'

export interface BrokerChannelTradingConfigRow {
  id: string
  broker_account_id: string
  channel_id: string
  copier_mode: 'ai' | 'manual'
  manual_settings: ManualSettings
  ai_settings: Json
  copy_limit_state?: CopyLimitState
  updated_at: string
}

export { ensurePersistedManualSettings } from './defaultManualSettings'

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
        (row.manual_settings ?? {}) as ManualSettings,
      ),
      ai_settings: (row.ai_settings ?? {}) as Json,
      copy_limit_state: normalizeCopyLimitState(row.copy_limit_state),
    }
  }
  return out
}

export function mergeBrokerWithChannelTradingConfigRows(
  broker: BrokerAccount,
  rows: BrokerChannelTradingConfigRow[],
): BrokerAccount {
  if (!rows.length) return broker
  const fromTable = channelTradingConfigsMapFromRows(rows)
  const jsonbMap = normalizeChannelTradingConfigsMap(broker.channel_trading_configs)
  return {
    ...broker,
    channel_trading_configs: { ...jsonbMap, ...fromTable } as Json,
  }
}

export async function fetchBrokerChannelTradingConfigRows(
  supabase: SupabaseClient,
  brokerAccountId: string,
): Promise<{ rows: BrokerChannelTradingConfigRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('broker_channel_trading_configs')
    .select(BROKER_CHANNEL_TRADING_CONFIG_SELECT)
    .eq('broker_account_id', brokerAccountId)

  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as BrokerChannelTradingConfigRow[], error: null }
}

export async function fetchBrokerChannelTradingConfigRowsForBrokers(
  supabase: SupabaseClient,
  brokerAccountIds: string[],
): Promise<{ rows: BrokerChannelTradingConfigRow[]; error: string | null }> {
  if (!brokerAccountIds.length) return { rows: [], error: null }
  const { data, error } = await supabase
    .from('broker_channel_trading_configs')
    .select(BROKER_CHANNEL_TRADING_CONFIG_SELECT)
    .in('broker_account_id', brokerAccountIds)

  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as BrokerChannelTradingConfigRow[], error: null }
}

function toUpsertRow(
  userId: string,
  brokerAccountId: string,
  channelId: string,
  config: ChannelTradingConfig,
): Record<string, unknown> {
  const key = normalizeChannelUuid(channelId)
  if (!key) throw new Error('Invalid channel id')
  return {
    user_id: userId,
    broker_account_id: brokerAccountId,
    channel_id: key,
    copier_mode: config.copier_mode === 'ai' ? 'ai' : 'manual',
    manual_settings: ensurePersistedManualSettings(
      (config.manual_settings ?? DEFAULT_MANUAL_SETTINGS) as ManualSettings,
    ),
    ai_settings: (config.ai_settings ?? {}) as Json,
  }
}

export async function upsertBrokerChannelTradingConfigs(
  supabase: SupabaseClient,
  userId: string,
  brokerAccountId: string,
  configs: ChannelTradingConfigsMap,
): Promise<{ error: string | null }> {
  const rows = Object.entries(configs)
    .map(([channelId, config]) => toUpsertRow(userId, brokerAccountId, channelId, config))
  if (!rows.length) return { error: null }

  const { data, error } = await supabase
    .from('broker_channel_trading_configs')
    .upsert(rows, { onConflict: 'broker_account_id,channel_id' })
    .select('id')

  if (error) return { error: error.message }
  if (!data?.length) {
    return { error: 'Channel configuration was not saved. Please try again.' }
  }
  return { error: null }
}

export async function deleteBrokerChannelTradingConfig(
  supabase: SupabaseClient,
  brokerAccountId: string,
  channelId: string,
): Promise<{ error: string | null }> {
  const key = normalizeChannelUuid(channelId)
  if (!key) return { error: 'Invalid channel id' }

  const { error } = await supabase
    .from('broker_channel_trading_configs')
    .delete()
    .eq('broker_account_id', brokerAccountId)
    .eq('channel_id', key)

  return { error: error?.message ?? null }
}

export async function deleteBrokerChannelTradingConfigsExcept(
  supabase: SupabaseClient,
  brokerAccountId: string,
  keepChannelIds: string[],
): Promise<{ error: string | null }> {
  const keep = new Set(
    keepChannelIds.map(id => normalizeChannelUuid(id)).filter(Boolean) as string[],
  )
  const { rows, error: fetchError } = await fetchBrokerChannelTradingConfigRows(
    supabase,
    brokerAccountId,
  )
  if (fetchError) return { error: fetchError }

  const toRemove = rows
    .map(row => normalizeChannelUuid(row.channel_id))
    .filter((id): id is string => {
      if (!id) return false
      return !keep.has(id)
    })

  if (!toRemove.length) return { error: null }

  const { error } = await supabase
    .from('broker_channel_trading_configs')
    .delete()
    .eq('broker_account_id', brokerAccountId)
    .in('channel_id', toRemove)

  return { error: error?.message ?? null }
}
