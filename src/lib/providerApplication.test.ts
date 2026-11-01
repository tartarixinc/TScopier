import { describe, expect, it } from 'vitest'
import type { BrokerAccount } from '../types/database'
import {
  centsToPriceInput,
  emptyProviderDraft,
  formatAccountAmount,
  priceInputToCents,
  providerAccountIneligibility,
  providerShareTargets,
  providerShareUrl,
  snapshotFreshness,
  validateProviderStep,
  SNAPSHOT_STALE_AFTER_MS,
} from './providerApplication'

function account(overrides: Partial<BrokerAccount> = {}): BrokerAccount {
  return {
    id: 'acct-1',
    is_active: true,
    provider: 'fxsocket',
    platform: 'MT5',
    connection_status: 'connected',
    fxsocket_status: 'connected',
    linked_account_type: 'Demo',
    ...overrides,
  } as unknown as BrokerAccount
}

describe('provider price input', () => {
  it.each([
    ['0', 0], ['50', 5000], ['49.99', 4999], ['  12.5 ', 1250], ['100000', 10_000_000],
  ])('parses %s', (input, cents) => expect(priceInputToCents(input)).toBe(cents))

  it.each([[''], ['-1'], ['abc'], ['1.234'], ['100001'], ['1e3']])('rejects %s', input => {
    expect(priceInputToCents(input)).toBeNull()
  })

  it('round-trips cents to an input string', () => {
    expect(centsToPriceInput(null)).toBe('')
    expect(centsToPriceInput(0)).toBe('0')
    expect(centsToPriceInput(5000)).toBe('50')
    expect(centsToPriceInput(4999)).toBe('49.99')
  })
})

describe('provider account eligibility', () => {
  it('accepts a connected, active MT5 demo account', () => {
    expect(providerAccountIneligibility(account())).toBeNull()
  })

  it('blocks disconnected, unsupported, inactive and mode-unknown accounts', () => {
    expect(providerAccountIneligibility(account({ connection_status: 'disconnected', fxsocket_status: 'disconnected' } as Partial<BrokerAccount>))).toBe('not_connected')
    expect(providerAccountIneligibility(account({ platform: 'cTrader', provider: 'ctrader' } as Partial<BrokerAccount>))).not.toBeNull()
    expect(providerAccountIneligibility(account({ is_active: false }))).toBe('inactive')
    expect(providerAccountIneligibility(account({ linked_account_type: null } as Partial<BrokerAccount>))).toBe('mode_unverified')
  })
})

describe('provider wizard validation', () => {
  const connected = account()

  it('step 1 requires an account and a matching type', () => {
    const draft = emptyProviderDraft()
    expect(validateProviderStep(1, draft, null)).toMatch(/Select the account/)
    expect(validateProviderStep(1, { ...draft, brokerAccountId: 'acct-1' }, connected)).toMatch(/account type/)
    expect(validateProviderStep(1, { ...draft, brokerAccountId: 'acct-1', accountKind: 'live' }, connected)).toMatch(/connected as Demo/)
    expect(validateProviderStep(1, { ...draft, brokerAccountId: 'acct-1', accountKind: 'demo' }, connected)).toBeNull()
  })

  it('step 1 requires a prop firm name for prop accounts', () => {
    const draft = { ...emptyProviderDraft(), brokerAccountId: 'acct-1', accountKind: 'prop' as const }
    expect(validateProviderStep(1, draft, connected)).toMatch(/prop firm/)
    expect(validateProviderStep(1, { ...draft, propFirmName: 'FTMO' }, connected)).toBeNull()
  })

  it('step 1 blocks a disconnected account', () => {
    const offline = account({ connection_status: 'disconnected', fxsocket_status: 'disconnected' } as Partial<BrokerAccount>)
    expect(validateProviderStep(1, { ...emptyProviderDraft(), brokerAccountId: 'acct-1', accountKind: 'demo' }, offline)).toMatch(/Reconnect/)
  })

  it('step 2 requires an explicit price (0 is free)', () => {
    const draft = emptyProviderDraft()
    expect(validateProviderStep(2, draft, null)).toMatch(/Free or enter/)
    expect(validateProviderStep(2, { ...draft, priceUsd: '0' }, null)).toBeNull()
    expect(validateProviderStep(2, { ...draft, priceUsd: 'abc' }, null)).toMatch(/Enter a price/)
    expect(validateProviderStep(2, { ...draft, priceUsd: '10', bio: 'x'.repeat(501) }, null)).toMatch(/bio/)
  })

  it('step 3 validates social links', () => {
    const draft = emptyProviderDraft()
    expect(validateProviderStep(3, draft, null)).toBeNull()
    expect(validateProviderStep(3, { ...draft, links: { telegram: 'https://t.me/trader' } }, null)).toBeNull()
    expect(validateProviderStep(3, { ...draft, links: { telegram: 'https://t.me.evil.example/trader' } }, null)).not.toBeNull()
    expect(validateProviderStep(3, { ...draft, links: { x: 'http://x.com/trader' } }, null)).not.toBeNull()
  })
})

describe('snapshot freshness and formatting', () => {
  const now = Date.parse('2026-11-01T12:00:00Z')

  it('flags stale and unknown snapshots', () => {
    expect(snapshotFreshness(null, now)).toBe('unknown')
    expect(snapshotFreshness('nonsense', now)).toBe('unknown')
    expect(snapshotFreshness(new Date(now - 60_000).toISOString(), now)).toBe('fresh')
    expect(snapshotFreshness(new Date(now - SNAPSHOT_STALE_AFTER_MS - 1).toISOString(), now)).toBe('stale')
  })

  it('formats amounts in the account currency and tolerates missing values', () => {
    expect(formatAccountAmount(null, 'USD')).toBe('\u2014')
    expect(formatAccountAmount(1234.5, 'USD')).toContain('1,234.50')
    expect(formatAccountAmount(10, 'XXL')).toContain('XXL')
  })
})

describe('share links', () => {
  it('builds the public url from the slug', () => {
    expect(providerShareUrl('https://app.tscopier.ai/', 'jane-doe')).toBe('https://app.tscopier.ai/p/jane-doe')
  })

  it('encodes share targets', () => {
    const targets = providerShareTargets('https://app.tscopier.ai/p/jane-doe', 'Jane & Co')
    expect(targets.map(target => target.key)).toEqual(['x', 'telegram', 'whatsapp'])
    for (const target of targets) {
      expect(target.href).toContain(encodeURIComponent('https://app.tscopier.ai/p/jane-doe').slice(0, 20))
      expect(target.href).not.toContain('Jane & Co')
    }
  })
})
