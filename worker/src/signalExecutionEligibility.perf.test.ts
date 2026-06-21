import { describe, it } from 'node:test'
import { evaluateParsedSignalExecutionEligibility } from './signalExecutionEligibility'
import { assertLatencyBudget, benchmarkSync } from './test/perfBudget'

const CASES = [
  {
    parsed: { action: 'buy', symbol: 'XAUUSD', sl: 2650, tp: [2700], entry_price: 2660 },
    raw: 'BUY XAUUSD NOW SL 2650 TP 2700',
  },
  {
    parsed: { action: 'sell', symbol: 'EURUSD', sl: 1.09, tp: [1.08], entry_price: 1.085 },
    raw: 'SELL EURUSD SL 1.09 TP 1.08',
  },
  {
    parsed: { action: 'close' },
    raw: 'Close all now',
  },
  {
    parsed: { action: 'ignore' },
    raw: 'Good morning everyone',
  },
]

describe('signalExecutionEligibility latency', () => {
  it('evaluates eligibility within latency budget', () => {
    let i = 0
    const samples = benchmarkSync(() => {
      const c = CASES[i % CASES.length]!
      evaluateParsedSignalExecutionEligibility(c.parsed, c.raw, null)
      i += 1
    }, 800)

    assertLatencyBudget('evaluateParsedSignalExecutionEligibility', samples, 2)
  })
})
