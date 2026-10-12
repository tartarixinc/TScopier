import type { SignalListenerStatus, TelegramAccountStatus } from './copierHealthStatus'
import type { SignalSourceKind } from './signalSourceMark'

export type CopierSourceLink =
  | 'checking'
  | 'not_connected'
  | 'connected'
  | 'reconnect'
  | 'reconnecting'
  | 'offline'
  | 'unknown'

export type CopierSourceLinks = Record<SignalSourceKind, CopierSourceLink>

export type CopierStatusHeadline = 'subscription' | 'issues' | 'checking' | 'unknown' | 'no_source' | 'ready'

export type CopierProcessState = 'checking' | 'operational' | 'degraded' | 'offline' | 'stopped' | 'unknown'

const SOURCE_ORDER: SignalSourceKind[] = ['telegram', 'discord', 'whatsapp', 'tradingview']

export function resolveCopierSourceLinks(input: {
  loaded: boolean
  hasTelegramSession: boolean
  telegramAccountStatus: TelegramAccountStatus
  signalListenerStatus: SignalListenerStatus
  telegramHealthUnreported: boolean
  discordChannels: number
  whatsappStatus: string | null
  whatsappChannels: number
  tradingViewConnected: boolean
}): CopierSourceLinks {
  if (!input.loaded) {
    return {
      telegram: 'checking',
      discord: 'checking',
      whatsapp: 'checking',
      tradingview: 'checking',
    }
  }

  let telegram: CopierSourceLink = 'not_connected'
  if (input.hasTelegramSession) {
    const account = input.telegramAccountStatus
    const listener = input.signalListenerStatus
    if (account === 'reconnect_required' || account === 'invalid') telegram = 'reconnect'
    else if (listener === 'reconnecting') telegram = 'reconnecting'
    else if (listener === 'disconnected' || listener === 'failed') telegram = 'offline'
    else if (listener === 'unknown') telegram = input.telegramHealthUnreported ? 'unknown' : 'checking'
    else telegram = 'connected'
  }

  const whatsappStatus = String(input.whatsappStatus ?? '').trim().toLowerCase()
  let whatsapp: CopierSourceLink = 'not_connected'
  if (whatsappStatus === 'connected') whatsapp = 'connected'
  else if (whatsappStatus === 'qr') whatsapp = 'reconnecting'
  else if (input.whatsappChannels > 0) whatsapp = 'offline'

  return {
    telegram,
    discord: input.discordChannels > 0 ? 'connected' : 'not_connected',
    whatsapp,
    tradingview: input.tradingViewConnected ? 'connected' : 'not_connected',
  }
}

export function copierSourceIsReady(link: CopierSourceLink): boolean {
  return link === 'connected'
}

export function copierSourceIsIssue(link: CopierSourceLink): boolean {
  return link === 'reconnect' || link === 'offline'
}

export function resolveCopierStatusHeadline(input: {
  hasActiveSubscription: boolean
  brokerIssue: boolean
  links: CopierSourceLinks
}): CopierStatusHeadline {
  if (!input.hasActiveSubscription) return 'subscription'
  const values = SOURCE_ORDER.map(kind => input.links[kind])
  if (values.every(link => link === 'checking')) return 'checking'
  const ready = values.some(copierSourceIsReady)
  const broken = values.some(copierSourceIsIssue)
  if (input.brokerIssue) return 'issues'
  if (ready) return 'ready'
  if (broken) return 'issues'
  if (values.some(link => link === 'checking' || link === 'reconnecting')) return 'checking'
  if (values.some(link => link === 'unknown')) return 'unknown'
  return 'no_source'
}

export function resolveCopierProcessState(links: CopierSourceLinks): CopierProcessState {
  const values = SOURCE_ORDER.map(kind => links[kind])
  if (values.some(copierSourceIsReady)) return 'operational'
  if (values.some(link => link === 'reconnecting')) return 'degraded'
  if (values.some(copierSourceIsIssue)) return 'offline'
  if (values.some(link => link === 'checking')) return 'checking'
  if (values.some(link => link === 'unknown')) return 'unknown'
  return 'stopped'
}
