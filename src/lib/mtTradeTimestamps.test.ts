import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  applyCloseTimesToTrades,
  applyTimesToTrades,
  buildOpenedOrderTimeLookup,
  buildPositionTimeLookup,
  buildTicketTimeLookup,
  formatTradeCloseTimeLabel,
  mtTradeMissingDisplayTime,
} from './mtTradeTimestamps.ts'
import {
  resolveMtCloseTimestamp,
  resolveMtOpenTimestamp,
} from './mtTradeFieldsClient.ts'
import type { MtTrade } from './fxsocketBroker.ts'

test('resolveMtCloseTimestamp: OPEN_TIME dot-format string', () => {
  const iso = resolveMtCloseTimestamp({ ticket: 1, CLOSE_TIME: '2025.01.15 20:54:24.928' })
  assert.equal(iso, new Date('2025-01-15T20:54:24.928').toISOString())
})

test('resolveMtOpenTimestamp: OPEN_TIME dot-format string', () => {
  const iso = resolveMtOpenTimestamp({ ticket: 1, OPEN_TIME: '2025.01.15 20:51:41.117' })
  assert.equal(iso, new Date('2025-01-15T20:51:41.117').toISOString())
})

test('applyCloseTimesToTrades sets closed_at for closed trades via position_ticket', () => {
  const trade: MtTrade = {
    id: 'b:9001',
    broker_id: 'b',
    broker_label: 'Demo',
    broker_name: 'ICMarketsSC-Demo',
    ticket: 9001,
    position_ticket: 5001,
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
  const lookup = buildTicketTimeLookup([
    {
      ticket: 9001,
      time: '2026-06-14T14:13:01Z',
      dealInternalIn: { ticket: 5001, openTime: '2026-06-14T12:00:00Z' },
    },
  ])
  const [hydrated] = applyCloseTimesToTrades([trade], { b: lookup })
  assert.equal(mtTradeMissingDisplayTime(hydrated), false)
  assert.equal(hydrated.closed_at, '2026-06-14T14:13:01.000Z')
})

test('applyCloseTimesToTrades sets closed_at for closed trades', () => {
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
  const [hydrated] = applyCloseTimesToTrades([trade], { b: lookup })
  assert.equal(mtTradeMissingDisplayTime(hydrated), false)
  assert.equal(hydrated.closed_at, '2026-06-14T14:13:01.000Z')
})

test('buildOpenedOrderTimeLookup: FxSocket OpenedOrders openTime', () => {
  const lookup = buildOpenedOrderTimeLookup([
    {
      ticket: 211438758,
      symbol: 'BTCUSD',
      type: 'Buy',
      kind: 'position',
      openTime: '2026-06-14T16:53:23.000Z',
    },
  ])
  const hit = lookup.get(211438758)
  assert.ok(hit?.opened_at)
  assert.equal(new Date(hit!.opened_at!).toISOString(), '2026-06-14T16:53:23.000Z')
})

test('buildPositionTimeLookup: PositionHistory positionId + closeTime', () => {
  const lookup = buildPositionTimeLookup([
    {
      positionId: 1705406717,
      symbol: 'BTCUSD',
      type: 'Buy',
      volume: 0.25,
      openTime: '2026-06-02T10:55:57.000Z',
      closeTime: '2026-06-02T11:13:04.000Z',
    },
  ])
  const hit = lookup.get(1705406717)
  assert.equal(hit?.closed_at, '2026-06-02T11:13:04.000Z')
  assert.equal(hit?.opened_at, '2026-06-02T10:55:57.000Z')
})

test('formatTradeCloseTimeLabel: closed uses close time, open uses open time', () => {
  const closed: MtTrade = {
    id: 'b:1',
    broker_id: 'b',
    broker_label: 'Demo',
    broker_name: 'ICMarketsSC-Demo',
    ticket: 1,
    symbol: 'BTCUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.25,
    entry_price: 64000,
    sl: null,
    tp: null,
    close_price: 64100,
    profit: 2.5,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: '2026-06-02T10:55:57.000Z',
    closed_at: '2026-06-02T11:13:04.000Z',
    state: null,
    status: 'closed',
  }
  const open: MtTrade = { ...closed, status: 'open', closed_at: null }
  assert.notEqual(formatTradeCloseTimeLabel(closed), '—')
  assert.notEqual(formatTradeCloseTimeLabel(open), '—')
})

test('applyTimesToTrades sets closed_at from PositionHistory lookup by positionId', () => {
  const trade: MtTrade = {
    id: 'b:1705406717',
    broker_id: 'b',
    broker_label: 'Demo',
    broker_name: 'ICMarketsSC-Demo',
    ticket: 1705406717,
    position_ticket: 1705406717,
    symbol: 'BTCUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.25,
    entry_price: 63985.28,
    sl: null,
    tp: null,
    close_price: 64000,
    profit: 2.78,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: null,
    closed_at: null,
    state: null,
    status: 'closed',
  }
  const lookup = buildPositionTimeLookup([
    {
      positionId: 1705406717,
      openTime: '2026-06-02T10:55:57.000Z',
      closeTime: '2026-06-02T11:13:04.000Z',
    },
  ])
  const [hydrated] = applyTimesToTrades([trade], { b: lookup })
  assert.equal(mtTradeMissingDisplayTime(hydrated), false)
  assert.equal(hydrated.closed_at, '2026-06-02T11:13:04.000Z')
})

test('applyTimesToTrades sets opened_at for open trades', () => {
  const trade: MtTrade = {
    id: 'b:211438758',
    broker_id: 'b',
    broker_label: 'Demo',
    broker_name: 'ICMarketsSC-Demo',
    ticket: 211438758,
    symbol: 'BTCUSD',
    direction: 'buy',
    type: 'Buy',
    lot_size: 0.25,
    entry_price: 105000,
    sl: null,
    tp: null,
    close_price: null,
    profit: -1.2,
    swap: null,
    commission: null,
    comment: null,
    magic: null,
    opened_at: null,
    closed_at: null,
    state: null,
    status: 'open',
  }
  assert.equal(mtTradeMissingDisplayTime(trade), true)
  const lookup = buildOpenedOrderTimeLookup([
    { ticket: 211438758, openTime: '2026-06-14T16:53:23.000Z' },
  ])
  const [hydrated] = applyTimesToTrades([trade], { b: lookup })
  assert.equal(mtTradeMissingDisplayTime(hydrated), false)
  assert.equal(hydrated.opened_at, '2026-06-14T16:53:23.000Z')
})
