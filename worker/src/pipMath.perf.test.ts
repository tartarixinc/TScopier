import { describe, it } from 'node:test'
import { classifySymbol } from './pipMath'
import { assertLatencyBudget, benchmarkSync } from './test/perfBudget'

const SYMBOLS = [
  'EURUSD',
  'USDJPY',
  'XAUUSD',
  'BTCUSD',
  'US30',
  'EURUSDm',
  'XAUUSD.r',
  'GBPJPY',
  'WTI',
  'NAS100',
]

describe('classifySymbol latency', () => {
  it('classifies symbols within latency budget', () => {
    let i = 0
    const samples = benchmarkSync(() => {
      classifySymbol(SYMBOLS[i % SYMBOLS.length]!)
      i += 1
    }, 2000)

    assertLatencyBudget('classifySymbol', samples, 0.15)
  })
})
