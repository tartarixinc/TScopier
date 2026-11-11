export type SignalSourceKind = 'telegram' | 'discord' | 'whatsapp' | 'tradingview'

export const SIGNAL_SOURCE_MARKS: Record<SignalSourceKind, { iconSrc: string; label: string }> = {
  telegram: { iconSrc: '/Telegram.svg', label: 'Telegram' },
  discord: { iconSrc: '/discord-logo.png', label: 'Discord' },
  whatsapp: { iconSrc: '/whatsapp-icon.png', label: 'WhatsApp' },
  tradingview: { iconSrc: '/tradingview-logo.png', label: 'TradingView' },
}

export function normalizeSignalSourceKind(value: unknown): SignalSourceKind | null {
  const kind = String(value ?? '').trim().toLowerCase()
  if (kind === 'telegram' || kind === 'discord' || kind === 'whatsapp' || kind === 'tradingview') return kind
  return null
}

export function buildChannelSourceKinds(
  channels: Array<{ id: string; source_kind?: string | null }>,
): Record<string, SignalSourceKind> {
  const out: Record<string, SignalSourceKind> = {}
  for (const channel of channels) {
    out[channel.id] = normalizeSignalSourceKind(channel.source_kind) ?? 'telegram'
  }
  return out
}

/**
 * Resolve the platform logo for a Copier log signal.
 * Prefer denormalized `signals.source_kind` so logos survive channel delete
 * (FK sets channel_id NULL). Fall back to the live channel map, then
 * TradingView's parsed_data hint, then Telegram for orphaned signal rows.
 */
export function resolveSignalSourceKind(
  signal: {
    channel_id?: string | null
    source_kind?: string | null
    parsed_data?: unknown
  },
  channelSourceKinds: Record<string, SignalSourceKind> = {},
): SignalSourceKind {
  const stored = normalizeSignalSourceKind(signal.source_kind)
  if (stored) return stored
  if (signal.channel_id) {
    const fromChannel = channelSourceKinds[signal.channel_id]
    if (fromChannel) return fromChannel
  }
  const parsed = signal.parsed_data && typeof signal.parsed_data === 'object'
    ? (signal.parsed_data as Record<string, unknown>)
    : null
  const fromParsed = normalizeSignalSourceKind(parsed?.signal_source)
  if (fromParsed) return fromParsed
  return 'telegram'
}

/**
 * Resolve the human source name for a Copier log signal.
 * Prefer live channel map, then denormalized `source_display_name`, then the
 * platform label — never a bare dash after the source is deleted.
 */
export function resolveSignalSourceName(
  signal: {
    channel_id?: string | null
    source_kind?: string | null
    source_display_name?: string | null
    parsed_data?: unknown
  },
  channelDisplayNames: Record<string, string> = {},
  channelSourceKinds: Record<string, SignalSourceKind> = {},
): string {
  if (signal.channel_id) {
    const live = channelDisplayNames[signal.channel_id]?.trim()
    if (live) return live
  }
  const stored = signal.source_display_name?.trim()
  if (stored) return stored
  return SIGNAL_SOURCE_MARKS[resolveSignalSourceKind(signal, channelSourceKinds)].label
}
