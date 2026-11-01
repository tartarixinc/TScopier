import { describe, expect, it } from 'vitest'
import { isVerifiedSocialBrokerTicket, maskBrokerAccountIdentifier, normalizeSocialBrokerTicket, resolveSocialAccountMode } from './socialAccount'
import type { BrokerAccount } from '../types/database'

function account(patch: Partial<BrokerAccount>): BrokerAccount {
  return { provider: 'fxsocket', linked_account_type: null, ...patch } as BrokerAccount
}

describe('social account presentation', () => {
  it('maps trusted demo and live values', () => {
    expect(resolveSocialAccountMode(account({ linked_account_type: 'Demo' }))).toBe('demo')
    expect(resolveSocialAccountMode(account({ linked_account_type: 'Live' }))).toBe('live')
    expect(resolveSocialAccountMode(account({ provider: 'ctrader', ctrader_environment: 'demo' }))).toBe('demo')
    expect(resolveSocialAccountMode(account({ provider: 'CTRADER', ctrader_environment: 'LIVE' }))).toBe('live')
  })

  it('never treats a missing account type as live', () => {
    expect(resolveSocialAccountMode(account({}))).toBe('unknown')
    expect(resolveSocialAccountMode(account({ linked_account_type: 'PropFirm' }))).toBe('unknown')
    expect(resolveSocialAccountMode(account({ provider: 'ctrader', linked_account_type: 'Live', ctrader_environment: 'demo' }))).toBe('unknown')
  })

  it('masks account identifiers', () => {
    expect(maskBrokerAccountIdentifier('12345678')).toBe('\u2022\u2022\u2022\u20221234'.replace('1234', '5678'))
    expect(maskBrokerAccountIdentifier(null)).toBe('Identifier unavailable')
  })

  it('validates provider-specific broker ticket identities', () => {
    for (const ticket of [null, undefined, '', ' ', 'NaN', 'Infinity', '1.2', '0', '000']) {
      expect(isVerifiedSocialBrokerTicket('mtapi', ticket)).toBe(false)
    }
    expect(isVerifiedSocialBrokerTicket('fxsocket', '000123')).toBe(true)
    expect(normalizeSocialBrokerTicket('fxsocket', '000123')).toBe('123')
    expect(isVerifiedSocialBrokerTicket('fxsocket', '9007199254740992')).toBe(false)
    expect(isVerifiedSocialBrokerTicket('mtapi', '123')).toBe(true)
    expect(isVerifiedSocialBrokerTicket(null, 'NaN')).toBe(false)
    expect(isVerifiedSocialBrokerTicket('ctrader', 'deal-abc')).toBe(true)
    expect(isVerifiedSocialBrokerTicket('ctrader', '  ')).toBe(false)
    expect(normalizeSocialBrokerTicket('ctrader', '  deal-abc  ')).toBe('deal-abc')
    expect(normalizeSocialBrokerTicket('ctrader', 'bad' + String.fromCharCode(0) + 'id')).toBeNull()
  })
})
