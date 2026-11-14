import { describe, expect, it } from 'vitest'
import { buildBrokerOpenBookFromTrades, splitOpenBookRows } from './brokerOpenBook'
import type { MtTrade } from './fxsocketBroker'

function trade(partial: Partial<MtTrade> & Pick<MtTrade, 'id' | 'broker_id' | 'type' | 'status'>): MtTrade {
  return {
    broker_label: '',
    broker_name: null,
    ticket: 1,
    symbol: 'EURUSD',
    direction: 'buy',
    lot_size: 0.1,
    entry_price: 1.1,
    sl: null,
    tp: null,
    close_price: null,
    profit: null,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: null,
    closed_at: null,
    state: null,
    ...partial,
  }
}

describe('splitOpenBookRows', () => {
  it('splits market vs pending and ignores closed', () => {
    const rows = [
      trade({ id: '1', broker_id: 'a', type: 'buy', status: 'open', profit: 10 }),
      trade({ id: '2', broker_id: 'a', type: 'buy limit', status: 'open' }),
      trade({ id: '3', broker_id: 'a', type: 'sell stop', status: 'open' }),
      trade({ id: '4', broker_id: 'a', type: 'sell', status: 'closed', profit: 5 }),
    ]
    const { market, pending } = splitOpenBookRows(rows)
    expect(market.map(t => t.id)).toEqual(['1'])
    expect(pending.map(t => t.id)).toEqual(['2', '3'])
  })
})

describe('buildBrokerOpenBookFromTrades', () => {
  it('counts market opens per broker and sums market PnL', () => {
    const book = buildBrokerOpenBookFromTrades([
      trade({ id: '1', broker_id: 'b1', type: 'buy', status: 'open', profit: 12.5 }),
      trade({ id: '2', broker_id: 'b1', type: 'buy limit', status: 'open', profit: 0 }),
      trade({ id: '3', broker_id: 'b2', type: 'sell', status: 'open', profit: -3 }),
      trade({ id: '4', broker_id: 'b2', type: 'sell stop', status: 'open' }),
    ])
    expect(book.marketOpenCount).toBe(2)
    expect(book.pendingOpenCount).toBe(2)
    expect(book.byBroker.b1).toMatchObject({
      marketOpenCount: 1,
      pendingOpenCount: 1,
      openPnl: 12.5,
    })
    expect(book.byBroker.b2).toMatchObject({
      marketOpenCount: 1,
      pendingOpenCount: 1,
      openPnl: -3,
    })
  })

  it('scopes to requested account ids', () => {
    const book = buildBrokerOpenBookFromTrades(
      [
        trade({ id: '1', broker_id: 'b1', type: 'buy', status: 'open', profit: 1 }),
        trade({ id: '2', broker_id: 'b2', type: 'buy', status: 'open', profit: 2 }),
      ],
      ['b1'],
    )
    expect(book.marketOpenCount).toBe(1)
    expect(book.byBroker.b2).toBeUndefined()
  })
})
