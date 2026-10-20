import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { en } from '../i18n/locales/en'
import {
  CLOSE_REASON_LABEL_KEYS,
  resolveTradeCloseReason,
} from './tradeCloseReason.ts'

/**
 * Guards the worker ↔ frontend contract: every reason the worker can write
 * must be understood by the frontend and must have an English label, otherwise
 * the trade modal would fall through to price inference and print a sentence
 * about stop loss / take profit for a trade closed for a different reason.
 */
function workerCloseReasons(): string[] {
  const source = readFileSync('worker/src/tradeCloseReasons.ts', 'utf8')
  const start = source.indexOf('TRADE_CLOSE_REASON = {')
  assert.ok(start > 0, 'TRADE_CLOSE_REASON block missing from worker/src/tradeCloseReasons.ts')
  const end = source.indexOf('} as const', start)
  assert.ok(end > start, 'TRADE_CLOSE_REASON block not terminated with `} as const`')
  const block = source.slice(start, end)
  const codes = [...block.matchAll(/^\s+[A-Z_0-9]+:\s*['"]([^'"]+)['"]/gm)].map(m => m[1]!)
  // Floor so a partial parse (renamed const, moved terminator, stray brace)
  // cannot silently pass both guards below.
  assert.ok(codes.length >= 10, `only ${codes.length} close reason codes parsed`)
  return codes
}

test('every worker close reason is understood by the frontend', () => {
  for (const code of workerCloseReasons()) {
    assert.equal(
      resolveTradeCloseReason(code, { sl: null, tp: null, close_price: null }),
      code,
      `worker writes '${code}' but the frontend does not know it`,
    )
  }
})

test('every worker close reason has a non-empty English label', () => {
  const trades = en.trades as unknown as Record<string, string>
  for (const code of workerCloseReasons()) {
    const key = CLOSE_REASON_LABEL_KEYS[code as keyof typeof CLOSE_REASON_LABEL_KEYS]
    assert.ok(key, `no label key mapped for '${code}'`)
    const label = trades[key]
    assert.ok(typeof label === 'string' && label.trim().length > 0, `empty en label for '${code}'`)
  }
})

test('broker-side reasons and the fallback are labelled too', () => {
  const trades = en.trades as unknown as Record<string, string>
  for (const code of ['stop_loss', 'take_profit', 'unknown'] as const) {
    const key = CLOSE_REASON_LABEL_KEYS[code]
    const label = trades[key]
    assert.ok(label && label.trim().length > 0, `empty en label for '${code}'`)
  }
})
