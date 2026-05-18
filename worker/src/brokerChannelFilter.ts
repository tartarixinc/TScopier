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
 * Whitelist applies only when `enforce_signal_channel_filter` is true (saved from
 * Configure Trading). Stale `signal_channel_ids` with enforce off are ignored.
 */
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
