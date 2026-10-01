import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { reconcileGoneNewsTrade } from './newsTradingMonitor'
import { isPositionGoneCloseError } from './orderModifyBenign'

// Regression for prod incident 2026-08-21 (signal 0cfaf2d5): NewsTradingMonitor
// fired pre-news closes on basket tickets the broker no longer knew ("unknown
// ticket") and, because it never reconciled the gone trades, re-fired on every
// news event — 89 failed order_close_audit rows over Aug 12-18. The broker
// "unknown ticket" reply means the flat outcome already happened.

test('isPositionGoneCloseError: unknown ticket classifies as gone-position close', () => {
  assert.equal(isPositionGoneCloseError('unknown ticket'), true)
  assert.equal(isPositionGoneCloseError('OrderClose: unknown ticket'), true)
  assert.equal(isPositionGoneCloseError('UNKNOWN TICKET'), true)
})

test('isPositionGoneCloseError: related gone-position replies still classify', () => {
  assert.equal(isPositionGoneCloseError('invalid ticket'), true)
  assert.equal(isPositionGoneCloseError('already closed'), true)
  assert.equal(isPositionGoneCloseError('no such order'), true)
  assert.equal(isPositionGoneCloseError('MT4 error 4108: Invalid request'), true)
})

test('isPositionGoneCloseError: real failures stay non-benign', () => {
  assert.equal(isPositionGoneCloseError('Insufficient funds'), false)
  assert.equal(isPositionGoneCloseError('trade context busy'), false)
  assert.equal(isPositionGoneCloseError('HTTP 500'), false)
})

test('reconcileGoneNewsTrade: unknown ticket alone leaves the trade open', async () => {
  const supabase = {
    from: () => { throw new Error('identity uncertainty must not mutate the trade') },
  }
  const ok = await reconcileGoneNewsTrade(supabase as never, 'trade-1')
  assert.equal(ok, false)
})

test('reconcileGoneNewsTrade: reports false when the row is not open', async () => {
  const supabase = {
    from: () => ({
      update: () => {
        const builder = {
          eq: () => {
            return {
              eq: () => ({ select: async () => ({ data: [], error: null }) }),
            }
          },
        }
        return builder
      },
    }),
  }
  const ok = await reconcileGoneNewsTrade(supabase as never, 'trade-2')
  assert.equal(ok, false)
})
