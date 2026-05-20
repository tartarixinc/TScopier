/** Broker row fields used to decide whether a signal's channel may be copied. */
export type BrokerChannelFilterFields = {
  enforce_signal_channel_filter?: boolean | null
  signal_channel_ids?: string[] | null
}

export function normalizeSignalChannelIds(raw: string[] | null | undefined): string[] {
  if (!raw?.length) return []
  return raw.map(String).filter(Boolean)
}

/**
 * True when this broker should copy signals from `channelId`.
 * Channels copy only when explicitly listed in `signal_channel_ids`.
 */
export function channelMatchesBrokerSignal(
  broker: BrokerChannelFilterFields,
  channelId: string | null,
): boolean {
  const ids = normalizeSignalChannelIds(broker.signal_channel_ids)
  if (!ids.length || !channelId) return false
  return ids.includes(channelId)
}
