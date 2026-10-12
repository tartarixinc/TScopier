import { describe, expect, it } from 'vitest'
import {
  connectedSignalSources,
  mergeAddedSignalSourceOrder,
  signalSourceTabOrder,
} from './signalSourceTabs'

describe('signalSourceTabs', () => {
  it('keeps tabs in the order sources were added', () => {
    expect(signalSourceTabOrder(
      ['tradingview', 'whatsapp', 'telegram'],
      ['telegram', 'whatsapp', 'tradingview'],
    )).toEqual(['tradingview', 'whatsapp', 'telegram'])
  })

  it('hides a source until it is connected', () => {
    expect(signalSourceTabOrder(
      ['telegram', 'whatsapp', 'discord'],
      ['telegram'],
    )).toEqual(['telegram'])
  })

  it('appends a connected source that was not recorded yet', () => {
    expect(signalSourceTabOrder(['whatsapp'], ['whatsapp', 'discord'])).toEqual(['whatsapp', 'discord'])
  })

  it('treats only a live connection as connected', () => {
    expect(connectedSignalSources({
      hasTelegramSession: false,
      whatsappStatus: 'qr',
      discordInstallations: 0,
      tradingViewWebhooks: 0,
    })).toEqual([])
    expect(connectedSignalSources({
      hasTelegramSession: true,
      whatsappStatus: 'connected',
      discordInstallations: 1,
      tradingViewWebhooks: 2,
    })).toEqual(['telegram', 'whatsapp', 'discord', 'tradingview'])
  })

  it('records new sources after the ones already added', () => {
    expect(mergeAddedSignalSourceOrder(
      ['tradingview'],
      ['whatsapp'],
      ['telegram'],
      'discord',
    )).toEqual(['tradingview', 'whatsapp', 'telegram', 'discord'])
  })
})