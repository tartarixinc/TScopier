import { describe, expect, it } from 'vitest'
import {
  copyPriceOfferLabel,
  dollarsToCopyPriceCents,
  readMonthlyCopyPriceCents,
} from './socialCopyPrice'

const labels = { free: 'Copy for Free', paid: 'Copy for {amount}/Month' }

describe('copy price', () => {
  it('labels a free trader without an amount', () => {
    expect(copyPriceOfferLabel(0, amount => `$${amount}`, labels)).toBe('Copy for Free')
  })

  it('labels a paid trader with the formatted monthly amount', () => {
    expect(copyPriceOfferLabel(5000, amount => `$${amount}`, labels)).toBe('Copy for $50/Month')
  })

  it('reads a stored cent amount and falls back when the value is missing', () => {
    expect(readMonthlyCopyPriceCents('2500', 0)).toBe(2500)
    expect(readMonthlyCopyPriceCents(null, 5000)).toBe(5000)
    expect(readMonthlyCopyPriceCents('nope', 0)).toBe(0)
  })

  it('stores whole dollars as USD cents', () => {
    expect(dollarsToCopyPriceCents(50)).toBe(5000)
    expect(dollarsToCopyPriceCents(0)).toBe(0)
  })
})