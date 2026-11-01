import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string) => readFileSync(`src/${rel}`, 'utf8')

/**
 * A broker that refuses the stop must fail the copy. Resending the order with
 * SL/TP zeroed opens a naked position and was the mechanism behind unprotected
 * live trades, so no send path may contain that fallback again.
 */
describe('no order path retries without the stops', () => {
  const files = [
    'tradeExecutor/orderLegExecution.ts',
    'tradeExecutor/strictEntryPending.ts',
    'tradeExecutor/layeringModeBrokerPending.ts',
    'tradeExecutor/materializeBrokerRangePendingLegs.ts',
    'virtualPendingMonitor.ts',
  ]

  for (const file of files) {
    it(`${file} has no naked retry`, () => {
      const src = read(file)
      assert.doesNotMatch(src, /retry without stops/i)
      assert.doesNotMatch(src, /stops_fallback|stopsFallback/)
      // A send with both stops zeroed after a rejection (any whitespace layout).
      assert.doesNotMatch(src, /stoploss:\s*0\s*,\s*takeprofit:\s*0/)
      assert.doesNotMatch(src, /takeprofit:\s*0\s*,\s*stoploss:\s*0/)
      assert.doesNotMatch(src, /sendWithStopsFallback/)
    })
  }

  it('the stop rejection is reported as a broker reason', () => {
    const src = read('brokerTradeError.ts')
    assert.match(src, /BROKER_REJECTED_STOPS/)
    assert.match(src, /isInvalidStopsMessage/)
  })
})
