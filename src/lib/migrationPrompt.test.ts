import { describe, expect, it } from 'vitest'
import type { BrokerAccount } from '../types/database'
import {
  isMigrationSwitchCase,
  isPromptDismissible,
  pickPromptBroker,
} from './migrationPrompt'

function broker(overrides: Partial<BrokerAccount> & { id: string }): BrokerAccount {
  return {
    label: 'Test account',
    platform: 'MT5',
    provider: 'fxsocket',
    is_active: true,
    connection_status: 'connected',
    ...overrides,
  } as BrokerAccount
}

const needsReconnect = [
  broker({ id: 'a', provider: 'mtapi', mtapi_status: null }),
  broker({ id: 'b' }),
]

describe('pickPromptBroker', () => {
  it('picks the first account that needs reconnecting', () => {
    expect(pickPromptBroker(needsReconnect, new Set())?.id).toBe('a')
  })

  it('skips paused accounts — they are not copying anything', () => {
    const list = [
      broker({ id: 'paused', is_active: false }),
      broker({ id: 'live' }),
    ]
    expect(pickPromptBroker(list, new Set())?.id).toBe('live')
  })

  it('skips an account whose reconnect is already in flight', () => {
    expect(pickPromptBroker(needsReconnect, new Set(['a']))?.id).toBe('b')
  })

  it('returns null when nothing needs reconnecting', () => {
    expect(pickPromptBroker([], new Set())).toBeNull()
  })

  it('returns null when every candidate is paused or in flight', () => {
    expect(pickPromptBroker(needsReconnect, new Set(['a', 'b']))).toBeNull()
  })
})

describe('isPromptDismissible', () => {
  it('refuses to close while the shown account needs reconnecting', () => {
    expect(isPromptDismissible(needsReconnect, needsReconnect[0])).toBe(false)
  })

  it('allows closing a dialog the customer opened for an account that is fine', () => {
    const manual = broker({ id: 'manual', connection_status: 'error' })
    expect(isPromptDismissible(needsReconnect, manual)).toBe(true)
  })

  it('is false when no account is shown', () => {
    expect(isPromptDismissible(needsReconnect, null)).toBe(false)
  })
})

describe('isMigrationSwitchCase', () => {
  it('is the migration case for an MTAPI row that has never connected', () => {
    expect(isMigrationSwitchCase(broker({ id: 'm', provider: 'mtapi', mtapi_status: null }))).toBe(true)
  })

  it('is not the migration case once MTAPI has reported a status', () => {
    expect(isMigrationSwitchCase(broker({ id: 'm', provider: 'mtapi', mtapi_status: 'connected' }))).toBe(false)
    expect(isMigrationSwitchCase(broker({ id: 'm', provider: 'mtapi', mtapi_status: 'error' }))).toBe(false)
  })

  it('is not the migration case for an ordinary FxSocket account', () => {
    expect(isMigrationSwitchCase(broker({ id: 'f', provider: 'fxsocket' }))).toBe(false)
    expect(isMigrationSwitchCase(null)).toBe(false)
  })
})
