import { describe, expect, it } from 'vitest'
import { resolveAccountDeposit } from './accountDeposit'

describe('resolveAccountDeposit', () => {
  it('prefers broker deposit history over the starting baseline', () => {
    expect(resolveAccountDeposit({
      total_deposits: 12_500,
      performance_baseline_balance: 10_000,
    })).toBe(12_500)
  })

  it('falls back to the performance baseline (initial deposit at connect)', () => {
    expect(resolveAccountDeposit({
      total_deposits: null,
      performance_baseline_balance: '499993.55',
    })).toBe(499_993.55)
  })

  it('is null when neither total is known', () => {
    expect(resolveAccountDeposit(null)).toBeNull()
    expect(resolveAccountDeposit({})).toBeNull()
  })
})
