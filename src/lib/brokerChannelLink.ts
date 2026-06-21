import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerAccount, Json, ManualSettings, TelegramChannel } from '../types/database'
import { BROKER_ACCOUNT_CLIENT_SELECT } from './brokerAccountSelect'
import {
  buildDefaultChannelTradingConfig,
  channelManualSettingsComplete,
  normalizeChannelTradingConfigsMap,
  normalizeChannelUuid,
  resolveChannelConfigEntry,
} from './channelTradingConfig'
import { isBrokerCopyEnabled } from './brokerLink'
import {
  deleteBrokerChannelTradingConfig,
  upsertBrokerChannelTradingConfigs,
} from './brokerChannelTradingConfigs'
import {
  DEFAULT_CHANNEL_FILTERS,
  normalizeChannelMessageFiltersMap,
  type ChannelFilters,
} from './channelMessageFilters'

export type BrokerChannelFilterFields = {
  enforce_signal_channel_filter?: boolean | null
  signal_channel_ids?: string[] | null
}

export function normalizeSignalChannelIds(raw: string[] | null | undefined): string[] {
  if (!raw?.length) return []
  return raw.map(id => String(id).trim().toLowerCase()).filter(Boolean)
}

/** Mirrors worker/src/brokerChannelFilter.ts */
export function channelMatchesBrokerSignal(
  broker: BrokerChannelFilterFields,
  channelId: string | null,
): boolean {
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (!ids.length || !channelId) return false
  return ids.includes(channelId)
}

export function getBrokerDisplayLabel(broker: BrokerAccount): string {
  return broker.label?.trim() || broker.broker_name?.trim() || broker.account_login?.trim() || 'Account'
}

export function brokersMatchingChannel(brokers: BrokerAccount[], channelId: string): BrokerAccount[] {
  return brokers.filter(b => isBrokerCopyEnabled(b) && channelMatchesBrokerSignal(b, channelId))
}

export function brokersNotMatchingChannel(brokers: BrokerAccount[], channelId: string): BrokerAccount[] {
  return brokers.filter(b => isBrokerCopyEnabled(b) && !channelMatchesBrokerSignal(b, channelId))
}

export async function connectChannelToBroker(
  supabase: SupabaseClient,
  userId: string,
  broker: BrokerAccount,
  channelId: string,
  options?: { defaultChannelFilters?: ChannelFilters },
): Promise<{ broker: BrokerAccount | null; error: string | null }> {
  const normalizedChannelId = normalizeChannelUuid(channelId)
  if (!normalizedChannelId) {
    return { broker: null, error: 'Invalid channel id' }
  }
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (ids.includes(normalizedChannelId)) {
    return { broker, error: null }
  }

  const nextIds = [...ids, normalizedChannelId]
  const configs = normalizeChannelTradingConfigsMap(broker.channel_trading_configs)
  if (!resolveChannelConfigEntry(configs, normalizedChannelId)) {
    const isSoleChannel = nextIds.length === 1
    const legacy = broker.manual_settings && typeof broker.manual_settings === 'object' && !Array.isArray(broker.manual_settings)
      ? (broker.manual_settings as ManualSettings)
      : null
    configs[normalizedChannelId] = isSoleChannel && channelManualSettingsComplete(legacy)
      ? {
          copier_mode: broker.copier_mode === 'ai' ? 'ai' : 'manual',
          manual_settings: legacy,
          ai_settings: (broker.ai_settings ?? {}) as Json,
        }
      : buildDefaultChannelTradingConfig()
    const { error: configErr } = await upsertBrokerChannelTradingConfigs(
      supabase,
      userId,
      broker.id,
      { [normalizedChannelId]: configs[normalizedChannelId]! },
    )
    if (configErr) return { broker: null, error: configErr }
  }
  const filters = normalizeChannelMessageFiltersMap(broker.channel_message_filters)
  if (!filters[normalizedChannelId]) {
    filters[normalizedChannelId] = { ...(options?.defaultChannelFilters ?? DEFAULT_CHANNEL_FILTERS) }
  }

  const { data, error } = await supabase
    .from('broker_accounts')
    .update({
      signal_channel_ids: nextIds,
      enforce_signal_channel_filter: true,
      channel_message_filters: filters,
    })
    .eq('id', broker.id)
    .eq('user_id', userId)
    .select(BROKER_ACCOUNT_CLIENT_SELECT)
    .single()

  if (error) return { broker: null, error: error.message }
  return { broker: data as unknown as BrokerAccount, error: null }
}

/** Link one channel to every active broker that does not already have it. */
export async function linkChannelToAllActiveBrokers(
  supabase: SupabaseClient,
  userId: string,
  channelId: string,
  brokers: BrokerAccount[],
  options?: { defaultChannelFilters?: ChannelFilters },
): Promise<{ brokers: BrokerAccount[]; error: string | null }> {
  const active = brokers.filter(b => isBrokerCopyEnabled(b))
  if (active.length === 0) return { brokers, error: null }

  let nextBrokers = [...brokers]
  for (const broker of active) {
    if (channelMatchesBrokerSignal(broker, channelId)) continue
    const { broker: updated, error } = await connectChannelToBroker(supabase, userId, broker, channelId, options)
    if (error) return { brokers: nextBrokers, error }
    if (updated) {
      nextBrokers = nextBrokers.map(b => (b.id === updated.id ? updated : b))
    }
  }
  return { brokers: nextBrokers, error: null }
}

export async function disconnectChannelFromBroker(
  supabase: SupabaseClient,
  userId: string,
  broker: BrokerAccount,
  channelId: string,
): Promise<{ broker: BrokerAccount | null; error: string | null }> {
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (!ids.includes(channelId)) {
    return { broker, error: null }
  }

  const nextIds = ids.filter(id => id !== channelId)
  const { error: configErr } = await deleteBrokerChannelTradingConfig(supabase, broker.id, channelId)
  if (configErr) return { broker: null, error: configErr }
  const filters = normalizeChannelMessageFiltersMap(broker.channel_message_filters)
  delete filters[channelId]

  const { data, error } = await supabase
    .from('broker_accounts')
    .update({
      signal_channel_ids: nextIds,
      enforce_signal_channel_filter: nextIds.length > 0,
      channel_message_filters: filters,
    })
    .eq('id', broker.id)
    .eq('user_id', userId)
    .select(BROKER_ACCOUNT_CLIENT_SELECT)
    .single()

  if (error) return { broker: null, error: error.message }
  return { broker: data as unknown as BrokerAccount, error: null }
}

/** Drop deleted channel ids from broker whitelists; never auto-add links. */
export async function pruneStaleBrokerChannelIds(
  supabase: SupabaseClient,
  userId: string,
  channels: TelegramChannel[],
  brokers: BrokerAccount[],
): Promise<BrokerAccount[]> {
  if (!brokers.length) return brokers

  const channelIdSet = new Set(channels.map(c => c.id))
  let result = [...brokers]

  for (const broker of brokers) {
    const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
    if (!ids.length) continue
    const validIds = ids.filter(id => channelIdSet.has(id))
    if (validIds.length === ids.length) continue

    const removedIds = ids.filter(id => !channelIdSet.has(id))
    let filters = normalizeChannelMessageFiltersMap(broker.channel_message_filters)
    for (const removedId of removedIds) {
      await deleteBrokerChannelTradingConfig(supabase, broker.id, removedId)
      delete filters[removedId]
    }

    const { data, error } = await supabase
      .from('broker_accounts')
      .update({
        signal_channel_ids: validIds,
        channel_message_filters: filters,
      })
      .eq('id', broker.id)
      .eq('user_id', userId)
      .select(BROKER_ACCOUNT_CLIENT_SELECT)
      .single()

    if (!error && data) {
      result = result.map(b => (b.id === broker.id ? (data as unknown as BrokerAccount) : b))
    }
  }

  return result
}
