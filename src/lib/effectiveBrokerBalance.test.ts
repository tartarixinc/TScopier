import { describe, expect, it } from 'vitest'
import { effectiveAccountSummaryBalance, effectiveBrokerBalance } from './effectiveBrokerBalance'

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

  it('falls back to equity when balance is missing', () => {
    expect(effectiveAccountSummaryBalance({ balance: null, equity: 10_050 })).toBe(10_050)
  })
})
