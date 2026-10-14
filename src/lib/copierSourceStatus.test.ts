import { describe, expect, it } from 'vitest'
import {
  resolveCopierProcessState,
  resolveCopierSourceLinks,
  resolveCopierStatusHeadline,
} from './copierSourceStatus'

const idle = {
  loaded: true,
  hasTelegramSession: false,
  telegramAccountStatus: 'unknown' as const,
  signalListenerStatus: 'unknown' as const,
  telegramHealthUnreported: false,
  discordChannels: 0,
  whatsappStatus: null,
  whatsappChannels: 0,
  tradingViewConnected: false,
}

describe('copierSourceStatus', () => {
  it('does not treat a missing Telegram account as an issue when another source is connected', () => {
    const links = resolveCopierSourceLinks({
      ...idle,
      discordChannels: 2,
      whatsappStatus: 'connected',
      whatsappChannels: 1,
      tradingViewConnected: true,
    })
    expect(links.telegram).toBe('not_connected')
    expect(links.discord).toBe('connected')
    expect(links.whatsapp).toBe('connected')
    expect(links.tradingview).toBe('connected')
    expect(resolveCopierStatusHeadline({
      hasActiveSubscription: true,
      brokerIssue: false,
      links,
    })).toBe('ready')
    expect(resolveCopierProcessState(links)).toBe('operational')
  })

  it('keeps Telegram offline as a row problem without failing the copier when WhatsApp is connected', () => {
    const links = resolveCopierSourceLinks({
      ...idle,
      hasTelegramSession: true,
      telegramAccountStatus: 'linked',
      signalListenerStatus: 'disconnected',
      whatsappStatus: 'connected',
      whatsappChannels: 1,
    })
    expect(links.telegram).toBe('offline')
    expect(resolveCopierStatusHeadline({
      hasActiveSubscription: true,
      brokerIssue: false,
      links,
    })).toBe('ready')
    expect(resolveCopierProcessState(links)).toBe('operational')
  })

  it('reports an issue when the only source is a disconnected Telegram listener', () => {
    const links = resolveCopierSourceLinks({
      ...idle,
      hasTelegramSession: true,
      telegramAccountStatus: 'linked',
      signalListenerStatus: 'failed',
    })
    expect(resolveCopierStatusHeadline({
      hasActiveSubscription: true,
      brokerIssue: false,
      links,
    })).toBe('issues')
    expect(resolveCopierProcessState(links)).toBe('offline')
  })

  it('reports an issue when WhatsApp groups exist but the session is disconnected and nothing else is connected', () => {
    const links = resolveCopierSourceLinks({
      ...idle,
      whatsappStatus: 'disconnected',
      whatsappChannels: 1,
    })
    expect(links.whatsapp).toBe('offline')
    expect(resolveCopierStatusHeadline({
      hasActiveSubscription: true,
      brokerIssue: false,
      links,
    })).toBe('issues')
  })

  it('says there is no signal source when nothing is connected', () => {
    const links = resolveCopierSourceLinks(idle)
    expect(resolveCopierStatusHeadline({
      hasActiveSubscription: true,
      brokerIssue: false,
      links,
    })).toBe('no_source')
    expect(resolveCopierProcessState(links)).toBe('stopped')
  })

  it('still flags broker problems when a source is connected', () => {
    const links = resolveCopierSourceLinks({ ...idle, tradingViewConnected: true })
    expect(resolveCopierStatusHeadline({
      hasActiveSubscription: true,
      brokerIssue: true,
      links,
    })).toBe('issues')
  })
})
