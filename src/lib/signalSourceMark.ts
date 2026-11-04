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
