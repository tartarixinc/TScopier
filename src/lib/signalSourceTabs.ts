import type { SignalSourceKind } from './signalSourceMark'

export const SIGNAL_SOURCE_ORDER: SignalSourceKind[] = ['telegram', 'whatsapp', 'discord', 'tradingview']

export function connectedSignalSources(input: {
  hasTelegramSession: boolean
  whatsappStatus: string | null
  discordInstallations: number
  tradingViewWebhooks: number
}): SignalSourceKind[] {
  const found: SignalSourceKind[] = []
  if (input.hasTelegramSession) found.push('telegram')
  if (String(input.whatsappStatus ?? '').trim().toLowerCase() === 'connected') found.push('whatsapp')
  if (input.discordInstallations > 0) found.push('discord')
  if (input.tradingViewWebhooks > 0) found.push('tradingview')
  return found
}

export function appendSignalSource(order: SignalSourceKind[], kind: SignalSourceKind): SignalSourceKind[] {
  return order.includes(kind) ? order : [...order, kind]
}

/** Remember sources in the order the user added them, then any already-connected sources not yet recorded. */
export function mergeAddedSignalSourceOrder(
  stored: SignalSourceKind[],
  pending: SignalSourceKind[],
  connected: SignalSourceKind[],
  extra?: SignalSourceKind | null,
): SignalSourceKind[] {
  const order: SignalSourceKind[] = []
  for (const kind of [...stored, ...pending, ...connected]) {
    if (!order.includes(kind)) order.push(kind)
  }
  if (extra && !order.includes(extra)) order.push(extra)
  return order
}

/** Tab list follows addition order and omits sources that are not connected. */
export function signalSourceTabOrder(
  addedOrder: SignalSourceKind[],
  connected: SignalSourceKind[],
): SignalSourceKind[] {
  const connectedSet = new Set(connected)
  const tabs: SignalSourceKind[] = []
  const seen = new Set<SignalSourceKind>()
  for (const kind of addedOrder) {
    if (!connectedSet.has(kind) || seen.has(kind)) continue
    seen.add(kind)
    tabs.push(kind)
  }
  for (const kind of connected) {
    if (seen.has(kind)) continue
    seen.add(kind)
    tabs.push(kind)
  }
  return tabs
}
