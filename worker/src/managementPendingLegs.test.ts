import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pendingLegsToCancelScopes } from './managementPendingLegs'
import type { RangePendingMgmtRow } from './managementPendingLegs'

describe('pendingLegsToCancelScopes', () => {
  it('dedupes by signal broker symbol', () => {
    const legs: RangePendingMgmtRow[] = [
      {
        id: '1',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 0,
        is_buy: true,
        anchor_price: 4500,
        stoploss: 4470,
        takeprofit: 4600,
        cwe_close_price: null,
        status: 'pending',
      },
      {
        id: '2',
        signal_id: 'sig-a',
        broker_account_id: 'b1',
        symbol: 'XAUUSD',
        step_idx: 1,
        is_buy: true,
        anchor_price: 4490,
        stoploss: 4470,
        takeprofit: 4600,
        cwe_close_price: null,
        status: 'pending',
      },
    ]
    const scopes = pendingLegsToCancelScopes(legs)
    assert.equal(scopes.length, 1)
    assert.equal(scopes[0]!.signalId, 'sig-a')
  })
})
