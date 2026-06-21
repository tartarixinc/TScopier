import { describe, expect, it } from 'vitest'
import {
  effectiveAccountSummaryBalance,
  effectiveBrokerBalance,
  resolveBrokerTotalBalance,
} from './effectiveBrokerBalance'

describe('effectiveBrokerBalance', () => {
  it('adds credit to balance', () => {
    expect(effectiveBrokerBalance(10_000, 5_000)).toBe(15_000)
  })

  it('returns balance when credit is absent', () => {
    expect(effectiveBrokerBalance(10_000)).toBe(10_000)
  })

  it('returns credit when balance is absent', () => {
    expect(effectiveBrokerBalance(null, 5_000)).toBe(5_000)
  })
})

describe('effectiveAccountSummaryBalance', () => {
  it('prefers balance plus credit over equity', () => {
    expect(effectiveAccountSummaryBalance({ balance: 10_000, credit: 5_000, equity: 15_050 })).toBe(15_000)
  })

  it('derives balance plus credit from equity minus profit when credit is omitted', () => {
    expect(
      effectiveAccountSummaryBalance({ balance: 147.96, equity: 793.23, profit: 0 }),
    ).toBe(793.23)
  })

  it('derives balance plus credit with open floating P/L', () => {
    expect(
      effectiveAccountSummaryBalance({ balance: 10_000, equity: 10_050, profit: 50 }),
    ).toBe(10_000)
  })

  it('falls back to equity when balance is missing', () => {
    expect(effectiveAccountSummaryBalance({ balance: null, equity: 10_050 })).toBe(10_050)
  })
})

describe('resolveBrokerTotalBalance', () => {
  it('detects prop-style credit-heavy cached rows', () => {
    expect(resolveBrokerTotalBalance({ last_balance: 147.96, last_equity: 793.23 })).toBe(793.23)
  })

  it('keeps effective balance when equity gap is likely open P/L', () => {
    expect(resolveBrokerTotalBalance({ last_balance: 10_000, last_equity: 10_050 })).toBe(10_000)
  })

  it('subtracts open P/L when provided', () => {
    expect(
      resolveBrokerTotalBalance(
        { last_balance: 10_000, last_equity: 10_050 },
        { openPnl: 50 },
      ),
    ).toBe(10_000)
  })
})
