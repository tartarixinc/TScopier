import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerAccount, TelegramChannel } from '../types/database'

export type BrokerChannelFilterFields = {
  enforce_signal_channel_filter?: boolean | null
  signal_channel_ids?: string[] | null
}

export function normalizeSignalChannelIds(raw: string[] | null | undefined): string[] {
  if (!raw?.length) return []
  return raw.map(String).filter(Boolean)
}

/** Mirrors worker/src/brokerChannelFilter.ts */
export function channelMatchesBrokerSignal(
  broker: BrokerChannelFilterFields,
  channelId: string | null,
): boolean {
  if (broker.enforce_signal_channel_filter !== true) return true
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (!ids.length) return true
  if (!channelId) return false
  return ids.includes(channelId)
}

export function getBrokerDisplayLabel(broker: BrokerAccount): string {
  return broker.label?.trim() || broker.broker_name?.trim() || broker.account_login?.trim() || 'Account'
}

export function brokersMatchingChannel(brokers: BrokerAccount[], channelId: string): BrokerAccount[] {
  return brokers.filter(b => b.is_active && channelMatchesBrokerSignal(b, channelId))
}

export function brokersNotMatchingChannel(brokers: BrokerAccount[], channelId: string): BrokerAccount[] {
  return brokers.filter(b => b.is_active && !channelMatchesBrokerSignal(b, channelId))
}

export async function connectChannelToBroker(
  supabase: SupabaseClient,
  userId: string,
  broker: BrokerAccount,
  channelId: string,
  allChannels: TelegramChannel[],
): Promise<{ broker: BrokerAccount | null; error: string | null }> {
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (
    channelMatchesBrokerSignal(broker, channelId)
    && (broker.enforce_signal_channel_filter !== true || ids.includes(channelId))
  ) {
    return { broker, error: null }
  }

  let nextIds: string[]
  if (allChannels.length === 1 && allChannels[0]) {
    nextIds = [allChannels[0].id]
  } else if (ids.length > 0) {
    nextIds = ids.includes(channelId) ? ids : [...ids, channelId]
  } else {
    nextIds = [channelId]
  }

  const { data, error } = await supabase
    .from('broker_accounts')
    .update({
      signal_channel_ids: nextIds,
      enforce_signal_channel_filter: true,
    })
    .eq('id', broker.id)
    .eq('user_id', userId)
    .select('*')
    .single()

  if (error) return { broker: null, error: error.message }
  return { broker: data as BrokerAccount, error: null }
}

/** Fix stale channel ids and ensure a sole channel is linked to active brokers. */
export async function reconcileBrokerChannelLinks(
  supabase: SupabaseClient,
  userId: string,
  channels: TelegramChannel[],
  brokers: BrokerAccount[],
): Promise<BrokerAccount[]> {
  if (!brokers.length || !channels.length) return brokers

  const channelIdSet = new Set(channels.map(c => c.id))
  let result = [...brokers]

  for (const broker of brokers.filter(b => b.is_active)) {
    const current = result.find(b => b.id === broker.id) ?? broker
    const ids = normalizeSignalChannelIds(current.signal_channel_ids)
    const enforce = current.enforce_signal_channel_filter === true

    if (enforce && ids.length > 0) {
      const validIds = ids.filter(id => channelIdSet.has(id))
      if (validIds.length === 0) {
        const nextIds = channels.length === 1 && channels[0] ? [channels[0].id] : channels.map(c => c.id)
        const { data, error } = await supabase
          .from('broker_accounts')
          .update({ signal_channel_ids: nextIds, enforce_signal_channel_filter: true })
          .eq('id', current.id)
          .eq('user_id', userId)
          .select('*')
          .single()
        if (!error && data) {
          result = result.map(b => (b.id === current.id ? (data as BrokerAccount) : b))
        }
        continue
      }
      if (validIds.length < ids.length) {
        const { data, error } = await supabase
          .from('broker_accounts')
          .update({ signal_channel_ids: validIds })
          .eq('id', current.id)
          .eq('user_id', userId)
          .select('*')
          .single()
        if (!error && data) {
          result = result.map(b => (b.id === current.id ? (data as BrokerAccount) : b))
        }
      }
    }

    if (channels.length === 1 && channels[0]) {
      const chId = channels[0].id
      const fresh = result.find(b => b.id === broker.id) ?? current
      if (!channelMatchesBrokerSignal(fresh, chId)) {
        const link = await connectChannelToBroker(supabase, userId, fresh, chId, channels)
        if (link.broker) {
          result = result.map(b => (b.id === broker.id ? link.broker! : b))
        }
      }
    }
  }

  return result
}

export async function linkBrokersToChannelsOnRegister(
  supabase: SupabaseClient,
  userId: string,
  broker: BrokerAccount,
  channels: TelegramChannel[],
): Promise<BrokerAccount> {
  if (channels.length === 1 && channels[0]) {
    const link = await connectChannelToBroker(supabase, userId, broker, channels[0].id, channels)
    return link.broker ?? broker
  }
  return broker
}
