import { describe, expect, it } from 'vitest'
import { computeMaxDrawdownPct, computeReturnPct } from './maxDrawdown'

const trade = (day: number, profit: number) => ({ closedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z`, profit })

describe('computeMaxDrawdownPct', () => {
  it('measures the worst peak-to-trough decline of the balance curve', () => {
    // 1000 -> 1100 (peak) -> 990 -> 1040 -> 1200 (new peak) -> 1140
    const dd = computeMaxDrawdownPct(1000, [trade(1, 100), trade(2, -110), trade(3, 50), trade(4, 160), trade(5, -60)])
    expect(dd).toBe(10) // (1100 - 990) / 1100
  })

  it('is zero for a curve that only rises, and orders trades by close time', () => {
    expect(computeMaxDrawdownPct(1000, [trade(1, 10), trade(2, 20)])).toBe(0)
    expect(computeMaxDrawdownPct(1000, [trade(2, -100), trade(1, 200)])).toBe(Math.round(((1200 - 1100) / 1200) * 10000) / 100)
  })

  it('counts a loss from the starting balance as drawdown', () => {
    expect(computeMaxDrawdownPct(1000, [trade(1, -50)])).toBe(5)
  })

  it('is null without a usable baseline and ignores unfinished trades', () => {
    expect(computeMaxDrawdownPct(null, [trade(1, 10)])).toBeNull()
    expect(computeMaxDrawdownPct(0, [trade(1, 10)])).toBeNull()
    expect(computeMaxDrawdownPct(1000, [{ closedAt: null, profit: -500 }, { closedAt: trade(1, 0).closedAt, profit: null }])).toBe(0)
  })
})

describe('computeReturnPct', () => {
  it('is realized P/L over the baseline balance', () => {
    expect(computeReturnPct(50000, [{ profit: 1333.94 }])).toBe(2.67)
    expect(computeReturnPct(1000, [{ profit: -50 }, { profit: 20 }])).toBe(-3)
  })
  it('is null without a baseline or trades', () => {
    expect(computeReturnPct(null, [{ profit: 1 }])).toBeNull()
    expect(computeReturnPct(1000, [])).toBeNull()
  })
})
