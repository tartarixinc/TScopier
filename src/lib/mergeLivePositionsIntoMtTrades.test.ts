import { describe, expect, it } from 'vitest'
import type { BrokerAccount } from '../types/database'
import type { MtTrade } from './fxsocketBroker'
import { mergeLivePositionsIntoMtTrades } from './mergeLivePositionsIntoMtTrades'

const account = {
  id: 'broker-1',
  label: 'Demo',
  broker_name: 'IC Markets',
} as BrokerAccount

function mtTrade(overrides: Partial<MtTrade> & Pick<MtTrade, 'ticket'>): MtTrade {
  return {
    id: `broker-1:${overrides.ticket}`,
    broker_id: 'broker-1',
    broker_label: 'Demo',
    broker_name: 'IC Markets',
    symbol: 'BTCUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.25,
    entry_price: 64281.47,
    sl: null,
    tp: null,
    close_price: null,
    profit: null,
    swap: 0,
    commission: 0,
    comment: null,
    magic: null,
    opened_at: '2026-06-14T16:53:23.000Z',
    closed_at: null,
    state: null,
    status: 'open',
    ...overrides,
  }
}

describe('mergeLivePositionsIntoMtTrades', () => {
  it('patches open profit and comment from WS rows', () => {
    const merged = mergeLivePositionsIntoMtTrades(
      [mtTrade({ ticket: 1705377546, profit: null })],
      account,
      [{
        ticket: 1705377546,
        symbol: 'BTCUSD',
        type: 'Buy',
        kind: 'position',
        lots: 0.25,
        profit: -7.86,
        comment: 'TScopier:TestSignalCh:4a6c0a6b:',
      }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.profit).toBe(-7.86)
    expect(merged[0]?.comment).toBe('TScopier:TestSignalCh:4a6c0a6b:')
  })

  it('adds synthetic open legs missing from REST history', () => {
    const merged = mergeLivePositionsIntoMtTrades(
      [],
      account,
      [{
        ticket: 1705377546,
        symbol: 'BTCUSD',
        type: 'Buy',
        kind: 'position',
        lots: 0.25,
        profit: -7.86,
        comment: 'TScopier:TestSignalCh:4a6c0a6b:',
        openTime: '2026-06-14T16:53:23.000Z',
      }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0]?.ticket).toBe(1705377546)
    expect(merged[0]?.status).toBe('open')
  })
})
