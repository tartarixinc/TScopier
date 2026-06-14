import { describe, expect, it } from 'vitest'
import type { MtTrade } from './fxsocketBroker'
import { resolveDisplayInitialBalance, sumTotalDeposits, computeTradingPnlFromBalanceAndCashFlows } from './performanceBaseline'

function trade(overrides: Partial<MtTrade> & Pick<MtTrade, 'ticket'>): MtTrade {
  return {
    id: `broker-1:${overrides.ticket}`,
    broker_id: 'broker-1',
    broker_label: 'Demo',
    broker_name: 'IC Markets',
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
    opened_at: '2026-01-01T10:00:00',
    closed_at: '2026-01-02T10:00:00',
    state: null,
    status: 'closed',
    ...overrides,
  }
}

describe('resolveDisplayInitialBalance', () => {
  it('corrects stale stored baseline when deposit row reconciles', () => {
    const trades = [
      trade({
        ticket: 0,
        symbol: '',
        direction: '',
        type: 'Balance',
        lot_size: 0,
        profit: 210_000,
        closed_at: '2026-01-01T08:00:00',
      }),
      trade({
        ticket: 1,
        profit: -45_378.67,
        swap: 111.66,
        closed_at: '2026-06-12T16:16:47',
      }),
    ]
    expect(
      resolveDisplayInitialBalance(209_144.06, 163_877.05, trades, 'broker-1'),
    ).toBe(210_000)
  })

  it('keeps link-time stored baseline instead of inferring balance minus pnl', () => {
    const trades = [
      trade({
        ticket: 1,
        profit: -45_602.68,
        closed_at: '2026-06-12T16:16:47',
      }),
    ]
    expect(
      resolveDisplayInitialBalance(210_000, 164_285.66, trades, 'broker-1'),
    ).toBe(210_000)
  })
})

describe('sumTotalDeposits', () => {
  it('sums positive balance operations only', () => {
    const trades = [
      trade({
        ticket: 0,
        symbol: '',
        direction: '',
        type: 'Balance',
        lot_size: 0,
        profit: 210_000,
        closed_at: '2026-01-01T08:00:00',
      }),
      trade({
        ticket: 1,
        profit: -45_602.68,
        closed_at: '2026-06-12T16:16:47',
      }),
    ]
    expect(sumTotalDeposits(trades)).toBe(210_000)
    expect(computeTradingPnlFromBalanceAndCashFlows(164_285.66, trades)).toBe(-45_714.34)
  })
})
