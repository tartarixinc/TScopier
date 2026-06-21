import { describe, it } from 'node:test'
import {
  DEFAULT_CHANNEL_KEYWORDS,
  parseChannelMessageSync,
} from './parseSignal'
import { assertLatencyBudget, benchmarkSync } from './test/perfBudget'

const SAMPLE_MESSAGES = [
  'Gold buy now @ 4500\nSL 4490\nTP: 4510',
  'BUY XAUUSD NOW SL 2650 TP 2700 TP 2750',
  'SELL GOLD 2655\nSL 2665\nTP 2640',
  'Close all now',
  'Good morning traders, market outlook for the week ahead.',
  'If you are happy, close now',
  'EURUSD buy now SL 1.0850 TP 1.0900',
  'BTCUSD sell @ 65000 SL 66000 TP 63000',
]

describe('parseChannelMessageSync latency', () => {
  it('parses a mixed batch within latency budget', () => {
    let i = 0
    const samples = benchmarkSync(() => {
      const msg = SAMPLE_MESSAGES[i % SAMPLE_MESSAGES.length]!
      parseChannelMessageSync(msg, DEFAULT_CHANNEL_KEYWORDS, null)
      i += 1
    }, 400)

    assertLatencyBudget('parseChannelMessageSync', samples, 12)
  })
})
