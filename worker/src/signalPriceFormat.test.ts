import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseSignalPriceToken } from './signalPriceFormat'

describe('parseSignalPriceToken', () => {
  it('parses comma thousands', () => {
    assert.equal(parseSignalPriceToken('4,572.25'), 4572.25)
    assert.equal(parseSignalPriceToken('4,590.01'), 4590.01)
  })

  it('parses plain decimals', () => {
    assert.equal(parseSignalPriceToken('2650.5'), 2650.5)
  })
})
