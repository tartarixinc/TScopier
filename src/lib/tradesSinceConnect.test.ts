import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MtTrade } from './fxsocketBroker'
import {
  filterMtTradesSinceConnect,
  isMtTradeSinceConnect,
  resolveBrokerConnectMs,
} from './tradesSinceConnect'

function trade(overrides: Partial<MtTrade> & Pick<MtTrade, 'broker_id' | 'ticket'>): MtTrade {
  return {
    id: `${overrides.broker_id}:${overrides.ticket}`,
    broker_label: 'Acct',
    broker_name: 'Broker',
    symbol: 'XAUUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.1,
    entry_price: 2500,
    sl: null,
    tp: null,
    close_price: 2510,
    profit: 100,
    swap: 0,
    commission: 0,
    comment: null,
    magic: null,
    opened_at: '2026-06-10T10:00:00.000Z',
    closed_at: '2026-06-10T12:00:00.000Z',
    state: null,
    status: 'closed',
    ...overrides,
  }
}

describe('tradesSinceConnect', () => {
  it('resolveBrokerConnectMs prefers performance_baseline_captured_at', () => {
    assert.equal(
      resolveBrokerConnectMs({
        performance_baseline_captured_at: '2026-06-14T13:58:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
      }),
      Date.parse('2026-06-14T13:58:00.000Z'),
    )
  })

  it('resolveBrokerConnectMs uses latest of baseline and last_activated_at', () => {
    assert.equal(
      resolveBrokerConnectMs({
        performance_baseline_captured_at: '2026-01-01T00:00:00.000Z',
        last_activated_at: '2026-06-14T13:58:00.000Z',
        created_at: '2025-01-01T00:00:00.000Z',
      }),
      Date.parse('2026-06-14T13:58:00.000Z'),
    )
  })

  it('filterMtTradesSinceConnect drops pre-connect closed trades', () => {
    const accounts = [{
      id: 'broker-1',
      performance_baseline_captured_at: '2026-06-14T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    }]
    const trades = [
      trade({ broker_id: 'broker-1', ticket: 1, opened_at: '2026-06-01T10:00:00.000Z', closed_at: '2026-06-01T12:00:00.000Z' }),
      trade({ broker_id: 'broker-1', ticket: 2, opened_at: '2026-06-15T10:00:00.000Z', closed_at: '2026-06-15T12:00:00.000Z' }),
    ]
    const filtered = filterMtTradesSinceConnect(trades, accounts)
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0]?.ticket, 2)
  })

  it('isMtTradeSinceConnect excludes positions opened before connect even if still open', () => {
    const connectMs = Date.parse('2026-06-14T00:00:00.000Z')
    const map = new Map([['broker-1', connectMs]])
    assert.equal(
      isMtTradeSinceConnect(
        trade({
          broker_id: 'broker-1',
          ticket: 3,
          status: 'open',
          opened_at: '2026-06-01T10:00:00.000Z',
          closed_at: null,
        }),
        map,
      ),
      false,
    )
    assert.equal(
      isMtTradeSinceConnect(
        trade({
          broker_id: 'broker-1',
          ticket: 4,
          status: 'open',
          opened_at: '2026-06-15T10:00:00.000Z',
          closed_at: null,
        }),
        map,
      ),
      true,
    )
  })
})
