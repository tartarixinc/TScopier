import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BrokerAccount } from '../types/database'
import { sortLinkedAccounts, type LinkedAccountSortContext } from './linkedAccountSort'

function account(
  id: string,
  patch: Partial<BrokerAccount> = {},
): BrokerAccount {
  return {
    id,
    user_id: 'u1',
    label: id,
    platform: 'mt5',
    is_active: true,
    connection_status: 'connected',
    created_at: '2026-01-01T00:00:00Z',
    ...patch,
  } as BrokerAccount
}

const ctx = (
  patch: Partial<LinkedAccountSortContext> = {},
): LinkedAccountSortContext => ({
  balances: {},
  performance: {},
  connectPnlByAccountId: {},
  ...patch,
})

describe('sortLinkedAccounts', () => {
  it('sorts accounts by label ascending', () => {
    const rows = sortLinkedAccounts(
      [account('b', { label: 'Beta' }), account('a', { label: 'Alpha' })],
      'account',
      'asc',
      ctx(),
    )
    assert.deepEqual(rows.map(r => r.id), ['a', 'b'])
  })

  it('sorts balance descending with nulls last', () => {
    const rows = sortLinkedAccounts(
      [
        account('low', { last_balance: 100 }),
        account('high', { last_balance: 500 }),
        account('none', { last_balance: null }),
      ],
      'balance',
      'desc',
      ctx(),
    )
    assert.deepEqual(rows.map(r => r.id), ['high', 'low', 'none'])
  })

  it('sorts status with active connected accounts first when descending', () => {
    const rows = sortLinkedAccounts(
      [
        account('paused', {
          is_active: false,
          connection_status: 'connected',
          fxsocket_account_id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
        }),
        account('off', { is_active: false, connection_status: 'disconnected' }),
        account('active', {
          is_active: true,
          connection_status: 'connected',
          fxsocket_account_id: 'b2b2b2b2-b2b2-4789-a012-3456789abcde',
        }),
      ],
      'status',
      'desc',
      ctx(),
    )
    assert.deepEqual(rows.map(r => r.id), ['active', 'paused', 'off'])
  })

  it('paused connected session-linked accounts rank above disconnected', () => {
    const rows = sortLinkedAccounts(
      [
        account('disconnected', { is_active: false, connection_status: 'disconnected' }),
        account('paused-linked', {
          is_active: false,
          connection_status: 'connected',
          fxsocket_account_id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
        }),
      ],
      'status',
      'desc',
      ctx(),
    )
    assert.deepEqual(rows.map(r => r.id), ['paused-linked', 'disconnected'])
  })
})
