import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractOpenOrderFromBrokerRaw,
  filterSnapshotStragglerOrdersForClose,
  filterTscopierOrdersForChannelClose,
  type BrokerOpenOrderLike,
} from './managementBrokerClose'

describe('extractOpenOrderFromBrokerRaw', () => {
  it('parses MT5-style order object', () => {
    const o = extractOpenOrderFromBrokerRaw({
      ticket: 12345,
      symbol: 'XAUUSD',
      comment: 'TScopier:SignalsPRO:abc12345',
      lots: 0.1,
      operation: 'Sell',
    })
    assert.deepEqual(o, {
      ticket: 12345,
      symbol: 'XAUUSD',
      comment: 'TScopier:SignalsPRO:abc12345',
      lots: 0.1,
      isBuy: false,
      stopLoss: 0,
      takeProfit: 0,
    })
  })

  it('parses MT4-style position rows (numeric type + order field)', () => {
    const buy = extractOpenOrderFromBrokerRaw({
      order: 555001,
      symbol: 'EURUSD',
      comment: 'TScopier:Ch:abc12345',
      volume: 0.2,
      type: 0,
      kind: 'position',
    })
    assert.deepEqual(buy, {
      ticket: 555001,
      symbol: 'EURUSD',
      comment: 'TScopier:Ch:abc12345',
      lots: 0.2,
      isBuy: true,
      stopLoss: 0,
      takeProfit: 0,
    })

    const sell = extractOpenOrderFromBrokerRaw({
      Ticket: 555002,
      Symbol: 'GBPUSD',
      Comment: 'TScopier:Ch:def67890',
      Lots: 0.15,
      cmd: 1,
    })
    assert.equal(sell?.ticket, 555002)
    assert.equal(sell?.isBuy, false)
  })

  it('parses MT4 pending rows (type 2–5)', () => {
    const buyLimit = extractOpenOrderFromBrokerRaw({
      ticket: 777,
      symbol: 'XAUUSD',
      comment: 'TScopier:Ch:abc12345',
      volume: 0.1,
      type: 2,
      kind: 'pending',
    })
    assert.equal(buyLimit?.isBuy, true)

    const sellStop = extractOpenOrderFromBrokerRaw({
      ticket: 778,
      symbol: 'XAUUSD',
      comment: 'TScopier:Ch:abc12345',
      volume: 0.1,
      cmd: 5,
    })
    assert.equal(sellStop?.isBuy, false)
  })
})

describe('filterTscopierOrdersForChannelClose', () => {
  const orders: BrokerOpenOrderLike[] = [
    {
      ticket: 1,
      symbol: 'XAUUSD',
      comment: 'TScopier:SignalsPRO:abc12345',
      lots: 0.1,
      isBuy: false,
      stopLoss: 2000,
      takeProfit: 2100,
    },
    {
      ticket: 2,
      symbol: 'EURUSD',
      comment: 'TScopier:OtherCh:deadbeef',
      lots: 0.1,
      isBuy: true,
      stopLoss: 1,
      takeProfit: 2,
    },
    {
      ticket: 3,
      symbol: 'XAUUSD',
      comment: 'manual trade',
      lots: 0.1,
      isBuy: true,
      stopLoss: 2000,
      takeProfit: 2100,
    },
  ]

  it('filters by channel slug and UniCopier prefix', () => {
    const out = filterTscopierOrdersForChannelClose({
      orders,
      channelSlug: 'SignalsPRO',
      symbolFilter: null,
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.ticket, 1)
  })

  it('filters by compatible symbol suffix', () => {
    const withSuffix: BrokerOpenOrderLike[] = [{
      ticket: 4,
      symbol: 'XAUUSDm',
      comment: 'TScopier:SignalsPRO:abc12345',
      lots: 0.1,
      isBuy: false,
      stopLoss: 2000,
      takeProfit: 2100,
    }]
    const out = filterTscopierOrdersForChannelClose({
      orders: withSuffix,
      channelSlug: 'SignalsPRO',
      symbolFilter: 'XAUUSD',
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.symbol, 'XAUUSDm')
  })
})

describe('filterSnapshotStragglerOrdersForClose', () => {
  it('closes naked non-comment orphans that were open before close-all', () => {
    const orders: BrokerOpenOrderLike[] = [
      {
        ticket: 10,
        symbol: 'XAUUSDm',
        comment: '',
        lots: 0.15,
        isBuy: true,
        stopLoss: 0,
        takeProfit: 0,
      },
      {
        ticket: 11,
        symbol: 'XAUUSDm',
        comment: 'manual hedge',
        lots: 0.15,
        isBuy: true,
        stopLoss: 4000,
        takeProfit: 4100,
      },
    ]
    const out = filterSnapshotStragglerOrdersForClose({
      orders,
      preCloseTickets: new Set([10, 11]),
      symbolFilter: 'XAUUSD',
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.ticket, 10)
  })

  it('keeps Tscopier-commented snapshot tickets even with stops', () => {
    const orders: BrokerOpenOrderLike[] = [{
      ticket: 12,
      symbol: 'XAUUSDm',
      comment: 'TScopier:SignalsPRO:abc12345',
      lots: 0.1,
      isBuy: true,
      stopLoss: 4000,
      takeProfit: 4100,
    }]
    const out = filterSnapshotStragglerOrdersForClose({
      orders,
      preCloseTickets: new Set([12]),
      symbolFilter: 'XAUUSD',
    })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.ticket, 12)
  })
})
