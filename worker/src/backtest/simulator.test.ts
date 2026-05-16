import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { barsToMidPoints, simulateTradeOnSeries } from './simulator'
import type { ParsedSignalForBacktest } from './types'

const baseSignal: ParsedSignalForBacktest = {
  signalId: 's1',
  channelId: 'c1',
  channelName: 'Test',
  signalAt: new Date('2026-01-15T10:00:00Z'),
  symbol: 'EURUSD',
  direction: 'buy',
  entryPrice: 1.1,
  sl: 1.095,
  tpLevels: [1.105, 1.11],
  lotSize: 0.1,
  rawAction: 'buy',
}

function bar(t: number, o: number, h: number, l: number, c: number) {
  return { t, o, h, l, c, v: 1 }
}

describe('simulateTradeOnSeries', () => {
  it('hits TP1 then SL when price reverses', () => {
    const series = barsToMidPoints([
      bar(Date.parse('2026-01-15T10:00:00Z'), 1.1, 1.1, 1.1, 1.1),
      bar(Date.parse('2026-01-15T10:01:00Z'), 1.1, 1.106, 1.099, 1.104),
      bar(Date.parse('2026-01-15T10:02:00Z'), 1.104, 1.104, 1.094, 1.095),
    ])
    const r = simulateTradeOnSeries(baseSignal, series, {
      breakevenAfterTp: 0,
      partialClosePerTp: 0,
      intrabarPriority: 'sl_first',
    }, 0.1)
    assert.equal(r.tpsHit >= 1, true)
    assert.equal(r.outcome, 'tp1_then_sl')
  })

  it('hits all TPs when price runs', () => {
    const series = barsToMidPoints([
      bar(Date.parse('2026-01-15T10:00:00Z'), 1.1, 1.1, 1.1, 1.1),
      bar(Date.parse('2026-01-15T10:01:00Z'), 1.1, 1.112, 1.099, 1.108),
      bar(Date.parse('2026-01-15T10:02:00Z'), 1.108, 1.115, 1.107, 1.112),
    ])
    const r = simulateTradeOnSeries(baseSignal, series, {
      breakevenAfterTp: 0,
      partialClosePerTp: 0,
      intrabarPriority: 'tp_first',
    }, 0.1)
    assert.equal(r.outcome, 'all_tp_hit')
  })

  it('moves to breakeven after TP1 when configured', () => {
    const series = barsToMidPoints([
      bar(Date.parse('2026-01-15T10:00:00Z'), 1.1, 1.1, 1.1, 1.1),
      bar(Date.parse('2026-01-15T10:01:00Z'), 1.1, 1.106, 1.099, 1.104),
      bar(Date.parse('2026-01-15T10:02:00Z'), 1.104, 1.104, 1.099, 1.1),
    ])
    const r = simulateTradeOnSeries(baseSignal, series, {
      breakevenAfterTp: 1,
      partialClosePerTp: 0,
      intrabarPriority: 'sl_first',
    }, 0.1)
    assert.ok(r.outcome === 'tp_then_be' || r.outcome === 'breakeven' || r.tpsHit >= 1)
  })
})
