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
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (!ids.length || !channelId) return false
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
): Promise<{ broker: BrokerAccount | null; error: string | null }> {
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (ids.includes(channelId)) {
    return { broker, error: null }
  }

  const nextIds = [...ids, channelId]

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

/** Link one channel to every active broker that does not already have it. */
export async function linkChannelToAllActiveBrokers(
  supabase: SupabaseClient,
  userId: string,
  channelId: string,
  brokers: BrokerAccount[],
): Promise<{ brokers: BrokerAccount[]; error: string | null }> {
  const active = brokers.filter(b => b.is_active)
  if (active.length === 0) return { brokers, error: null }

  let nextBrokers = [...brokers]
  for (const broker of active) {
    if (channelMatchesBrokerSignal(broker, channelId)) continue
    const { broker: updated, error } = await connectChannelToBroker(supabase, userId, broker, channelId)
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

  const { data, error } = await supabase
    .from('broker_accounts')
    .update({
      signal_channel_ids: nextIds,
      enforce_signal_channel_filter: nextIds.length > 0,
    })
    .eq('id', broker.id)
    .eq('user_id', userId)
    .select('*')
    .single()

  if (error) return { broker: null, error: error.message }
  return { broker: data as BrokerAccount, error: null }
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

    const { data, error } = await supabase
      .from('broker_accounts')
      .update({ signal_channel_ids: validIds })
      .eq('id', broker.id)
      .eq('user_id', userId)
      .select('*')
      .single()

    if (!error && data) {
      result = result.map(b => (b.id === broker.id ? (data as BrokerAccount) : b))
    }
  }

  return result
}
