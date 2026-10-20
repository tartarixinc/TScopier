import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  inferCloseReasonFromPrices,
  resolveTradeCloseReason,
  tradeCloseReasonLabel,
  type TradeCloseReasonCode,
  type TradeCloseReasonLabels,
} from './tradeCloseReason.ts'

const labels: TradeCloseReasonLabels = {
  reasonNewsPreClose: 'Closed automatically before a scheduled high-impact news release.',
  reasonSignalClose: 'Closed because the signal channel sent a close instruction.',
  reasonSignalRevision: 'Closed because a revised signal replaced it.',
  reasonOppositeSignal: 'Closed because an opposite signal opened a new trade.',
  reasonPartialTp: 'Closed when the last part of a take-profit close finished.',
  reasonAutoManagement: 'Closed by automatic trade management.',
  reasonCloseWorseEntries: 'Closed to make room for better entries.',
  reasonCopyLimitFlatten: 'Closed automatically when the copy limit was reached.',
  reasonUserForceClose: 'Closed by you.',
  reasonPositionGone: 'The position was already gone on the broker when we checked.',
  reasonStopLoss: 'The broker closed it at the stop loss ({price}).',
  reasonTakeProfit: 'The broker closed it at the take profit ({price}).',
  reasonUnknown: 'No close reason was recorded for this trade.',
}

test('stored worker reason wins over price inference', () => {
  assert.equal(
    resolveTradeCloseReason('news_pre_close', { sl: 4098, tp: null, close_price: 4098 }),
    'news_pre_close',
  )
  assert.equal(
    resolveTradeCloseReason('opposite_signal', { sl: null, tp: null, close_price: 1.1 }),
    'opposite_signal',
  )
})

test('unknown stored value falls back to inference, then unknown', () => {
  assert.equal(
    resolveTradeCloseReason('something_new', { sl: 4098, tp: null, close_price: 4098 }),
    'stop_loss',
  )
  assert.equal(resolveTradeCloseReason('something_new', { sl: 10, tp: 20, close_price: 15 }), 'unknown')
})

test('NULL reason infers stop loss / take profit from close price', () => {
  assert.equal(resolveTradeCloseReason(null, { sl: 4098, tp: null, close_price: 4098 }), 'stop_loss')
  assert.equal(resolveTradeCloseReason(null, { sl: null, tp: 4200, close_price: 4200 }), 'take_profit')
  assert.equal(resolveTradeCloseReason(null, { sl: 4098, tp: 4200, close_price: 4150 }), 'unknown')
  assert.equal(resolveTradeCloseReason(null, { sl: null, tp: null, close_price: null }), 'unknown')
})

test('position_gone still gets the SL/TP story when the close price matches', () => {
  assert.equal(
    resolveTradeCloseReason('position_gone', { sl: 4098, tp: null, close_price: 4098 }),
    'stop_loss',
  )
  assert.equal(
    resolveTradeCloseReason('position_gone', { sl: 4098, tp: null, close_price: 4132.286 }),
    'position_gone',
  )
})

test('broker rounding of the close price still matches the level', () => {
  assert.equal(
    inferCloseReasonFromPrices({ sl: 1.0845, tp: null, close_price: 1.0844999 }),
    'stop_loss',
  )
  assert.equal(
    inferCloseReasonFromPrices({ sl: 4098, tp: null, close_price: 4097.99999 }),
    'stop_loss',
  )
})

test('far-away close price never matches SL or TP', () => {
  assert.equal(
    inferCloseReasonFromPrices({ sl: 4098, tp: 4200, close_price: 4132.286 }),
    null,
  )
})

test('FX pip-size gap stays unknown instead of guessing a stop loss', () => {
  // 1 pip (1e-4) is far outside the rounding tolerance: a close that near a
  // level but not on it must not be reported as an SL/TP hit.
  assert.equal(
    inferCloseReasonFromPrices({ sl: 1.0845, tp: null, close_price: 1.0846 }),
    null,
  )
})

test('every reason code maps to a natural-language sentence', () => {
  const codes = [
    'news_pre_close',
    'signal_close',
    'signal_revision',
    'opposite_signal',
    'partial_tp',
    'auto_management',
    'close_worse_entries',
    'copy_limit_flatten',
    'user_force_close',
    'position_gone',
    'stop_loss',
    'take_profit',
    'unknown',
  ] as const
  for (const code of codes) {
    const label = tradeCloseReasonLabel(code, labels, { price: '4098.00000' })
    assert.ok(label.length > 0, code)
    assert.ok(!label.includes('{'), code)
  }
  assert.equal(
    tradeCloseReasonLabel('news_pre_close', labels),
    'Closed automatically before a scheduled high-impact news release.',
  )
  assert.equal(
    tradeCloseReasonLabel('stop_loss', labels, { price: '4098.00000' }),
    'The broker closed it at the stop loss (4098.00000).',
  )
  assert.equal(
    // Deliberately outside the union: exercises the runtime `?? reasonUnknown` fallback.
    tradeCloseReasonLabel('never_seen' as TradeCloseReasonCode, labels),
    'No close reason was recorded for this trade.',
  )
})
