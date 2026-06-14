import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildTicketTimeLookup,
  hydrateMtTradesFromLookups,
  mtTradeMissingDisplayTime,
} from './mtTradeTimestamps.ts'
import type { MtTrade } from './fxsocketBroker.ts'

test('buildTicketTimeLookup: FxSocket OrderHistory deal time', () => {
  const lookup = buildTicketTimeLookup([
    {
      ticket: 1401725372,
      symbol: 'XAUUSD',
      type: 'Sell',
      entry: 'Out',
      volume: 0.12,
      price: 4291.71,
      profit: 0,
      time: '2026-06-14T14:13:01Z',
    },
  ])
  const hit = lookup.get(1401725372)
  assert.ok(hit?.closed_at)
  assert.equal(new Date(hit!.closed_at!).toISOString(), '2026-06-14T14:13:01.000Z')
})

test('buildTicketTimeLookup: MT5 broker dot date', () => {
  const lookup = buildTicketTimeLookup([
    { ticket: 99, time: '2026.06.14 14:13:01', profit: 1, volume: 0.1, symbol: 'EURUSD' },
  ])
  assert.ok(lookup.get(99)?.closed_at)
})

test('hydrateMtTradesFromLookups fills missing closed_at', () => {
  const trade: MtTrade = {
    id: 'b:1401725372',
    broker_id: 'b',
    broker_label: 'Demo',
    broker_name: 'ICMarketsSC-Demo',
    ticket: 1401725372,
    symbol: 'XAUUSD',
    direction: 'sell',
    type: 'Sell',
    lot_size: 0.12,
    entry_price: 4291.71,
    sl: null,
    tp: null,
    close_price: null,
    profit: 0,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: null,
    closed_at: null,
    state: null,
    status: 'closed',
  }
  assert.equal(mtTradeMissingDisplayTime(trade), true)
  const lookup = buildTicketTimeLookup([
    { ticket: 1401725372, time: '2026-06-14T14:13:01Z' },
  ])
  const [hydrated] = hydrateMtTradesFromLookups([trade], { b: lookup })
  assert.equal(mtTradeMissingDisplayTime(hydrated), false)
})
