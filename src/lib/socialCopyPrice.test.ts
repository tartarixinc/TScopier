import { describe, expect, it } from 'vitest'
import {
  copyPriceOfferLabel,
  dollarsToCopyPriceCents,
} from './socialCopyPrice'

const labels = { free: 'Copy for Free', paid: 'Copy for {amount}/Month' }

describe('copy price', () => {
  it('labels a free trader without an amount', () => {
    expect(copyPriceOfferLabel(0, amount => `$${amount}`, labels)).toBe('Copy for Free')
  })

  it('labels a paid trader with the formatted monthly amount', () => {
    expect(copyPriceOfferLabel(5000, amount => `$${amount}`, labels)).toBe('Copy for $50/Month')
  })

  it('stores whole dollars as USD cents', () => {
    expect(dollarsToCopyPriceCents(50)).toBe(5000)
    expect(dollarsToCopyPriceCents(0)).toBe(0)
  })
})