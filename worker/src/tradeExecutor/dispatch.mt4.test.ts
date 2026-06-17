import test from 'node:test'
import assert from 'node:assert/strict'
import { brokerEligibleForSignal } from './dispatch'
import type { TradeExecutorContext } from './context'
import type { BrokerRow, SignalRow } from './types'

const ctx = { brokerActivatedAt: new Map<string, number>() } as unknown as TradeExecutorContext

function broker(overrides: Partial<BrokerRow> = {}): BrokerRow {
  return {
    id: 'broker-1',
    user_id: 'user-1',
    is_active: true,
    platform: 'MT4',
    metaapi_account_id: 'fx-uuid',
    ...overrides,
  } as BrokerRow
}

function signal(createdAt?: string): SignalRow {
  return { id: 'signal-1', created_at: createdAt ?? new Date().toISOString() } as SignalRow
}

test('brokerEligibleForSignal allows active MT4 brokers', () => {
  assert.equal(brokerEligibleForSignal(ctx, broker(), signal()), true)
})

test('brokerEligibleForSignal still blocks inactive brokers regardless of platform', () => {
  assert.equal(brokerEligibleForSignal(ctx, broker({ is_active: false }), signal()), false)
  assert.equal(brokerEligibleForSignal(ctx, broker({ platform: 'MT5', is_active: false }), signal()), false)
})
