import { describe, expect, it } from 'vitest'
import {
  parseFxsocketAccountStreamData,
  parseFxsocketOpenPositionCount,
  parseFxsocketPositionsStreamData,
  resolveFxsocketFloatingOpenPnl,
  shouldApplyAccountStreamOpenPnl,
  sumOpenPnlByBroker,
  countOpenMarketPositionsByBroker,
} from './fxsocketStreamParse'

describe('parseFxsocketAccountStreamData', () => {
  it('reads camelCase AccountSummary fields', () => {
    const snap = parseFxsocketAccountStreamData({
      balance: 10_000,
      equity: 10_050.5,
      profit: 50.5,
      currency: 'USD',
    })
    expect(snap.balance).toBe(10_000)
    expect(snap.equity).toBe(10_050.5)
    expect(snap.openPnl).toBe(50.5)
    expect(snap.currency).toBe('USD')
  })

  it('reads PascalCase fields from MT protobuf-style payloads', () => {
    const snap = parseFxsocketAccountStreamData({
      Balance: 5000,
      Equity: 4975,
      Profit: -25,
    })
    expect(snap.balance).toBe(5000)
    expect(snap.equity).toBe(4975)
    expect(snap.openPnl).toBe(-25)
  })

  it('adds broker credit to balance', () => {
    const snap = parseFxsocketAccountStreamData({
      balance: 10_000,
      credit: 5_000,
      equity: 15_050.5,
      profit: 50.5,
    })
    expect(snap.balance).toBe(15_000)
    expect(snap.equity).toBe(15_050.5)
    expect(snap.openPnl).toBe(50.5)
  })

  it('derives floating P/L from equity minus balance+credit when profit is absent', () => {
    const snap = parseFxsocketAccountStreamData({
      balance: 1000,
      credit: 500,
      equity: 1512.34,
    })
    expect(snap.balance).toBe(1500)
    expect(snap.openPnl).toBeCloseTo(12.34)
    expect(snap.openPnlSource).toBe('derived')
  })

  it('derives floating P/L from equity minus balance when profit is absent', () => {
    const snap = parseFxsocketAccountStreamData({
      balance: 1000,
      equity: 1012.34,
    })
    expect(snap.openPnl).toBeCloseTo(12.34)
    expect(snap.openPnlSource).toBe('derived')
  })

  it('does not apply misleading zero account profit when positions are open', () => {
    const snap = parseFxsocketAccountStreamData({
      balance: 164_732.99,
      equity: 164_732.99,
      profit: 0,
    })
    expect(snap.openPnl).toBe(0)
    expect(shouldApplyAccountStreamOpenPnl(snap, 3)).toBe(false)
    expect(shouldApplyAccountStreamOpenPnl(snap, 0)).toBe(true)
  })
})

describe('parseFxsocketOpenPositionCount', () => {
  it('counts only market positions, not pending orders', () => {
    expect(parseFxsocketOpenPositionCount([
      { kind: 'position', operation: 'Buy', ticket: 1 },
      { kind: 'pending', operation: 'BuyLimit', ticket: 2 },
      { operation: 'Sell', ticket: 3 },
      { type: 2, ticket: 4 },
    ])).toBe(2)
    expect(parseFxsocketOpenPositionCount([])).toBe(0)
    expect(parseFxsocketOpenPositionCount(null)).toBe(0)
  })
})

describe('parseFxsocketPositionsStreamData', () => {
  it('sums profit, swap, and commission on open market positions', () => {
    const snap = parseFxsocketPositionsStreamData([
      { kind: 'position', operation: 'Buy', profit: 100, swap: 1.5, commission: -0.5 },
      { kind: 'position', operation: 'Sell', Profit: -25, Swap: 0.25 },
      { kind: 'pending', operation: 'BuyLimit', profit: 999 },
    ])
    expect(snap.openTrades).toBe(2)
    expect(snap.openPnl).toBe(76.25)
  })

  it('returns zero open P/L when there are no market positions', () => {
    expect(parseFxsocketPositionsStreamData([])).toEqual({ openTrades: 0, openPnl: 0 })
    expect(parseFxsocketPositionsStreamData([
      { kind: 'pending', operation: 'BuyLimit', ticket: 1 },
    ])).toEqual({ openTrades: 0, openPnl: 0 })
  })

  it('parses FxSocket REST/WS position rows (kind position)', () => {
    const snap = parseFxsocketPositionsStreamData([
      {
        kind: 'position',
        symbol: 'XAUUSD',
        lots: 0.35,
        profit: -12.5,
        swap: 0.1,
      },
    ])
    expect(snap.openTrades).toBe(1)
    expect(snap.openPnl).toBe(-12.4)
  })

  it('unwraps nested positions envelopes', () => {
    const snap = parseFxsocketPositionsStreamData({
      positions: [
        { kind: 'position', symbol: 'EURUSD', lots: 0.1, profit: 5 },
      ],
    })
    expect(snap.openTrades).toBe(1)
    expect(snap.openPnl).toBe(5)
  })
})

describe('sumOpenPnlByBroker', () => {
  it('sums open leg profit swap commission per broker', () => {
    const totals = sumOpenPnlByBroker([
      { broker_id: 'a', status: 'open', type: 'Buy', profit: 10, swap: 1 },
      { broker_id: 'a', status: 'open', type: 'Sell', profit: -3, commission: -0.5 },
      { broker_id: 'a', status: 'open', type: 'Buy Limit', profit: 99 },
      { broker_id: 'b', status: 'closed', type: 'Buy', profit: 50 },
    ])
    expect(totals).toEqual({ a: 7.5 })
  })
})

describe('countOpenMarketPositionsByBroker', () => {
  it('ignores pending MtTrade rows', () => {
    const counts = countOpenMarketPositionsByBroker([
      { broker_id: 'a', status: 'open', type: 'Buy' },
      { broker_id: 'a', status: 'open', type: 'Buy Limit' },
      { broker_id: 'b', status: 'closed', type: 'Sell' },
    ])
    expect(counts).toEqual({ a: 1 })
  })
})

describe('resolveFxsocketFloatingOpenPnl', () => {
  it('prefers equity minus balance when explicit profit is misleading zero', () => {
    const pnl = resolveFxsocketFloatingOpenPnl({
      balance: 1000,
      equity: 1012.34,
      openPnl: 0,
      openPnlSource: 'explicit',
    }, 3)
    expect(pnl).toBeCloseTo(12.34)
  })
})
