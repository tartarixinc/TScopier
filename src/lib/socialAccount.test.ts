import { describe, expect, it } from 'vitest'
import { maskBrokerAccountIdentifier, resolveSocialAccountMode } from './socialAccount'
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
})
