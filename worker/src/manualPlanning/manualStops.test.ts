import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { deriveManualStopsWithClamp } from './manualStops'

const baseCtx = {
  point: 0.0001,
  digits: 5,
  minLot: 0.01,
  lotStep: 0.01,
  contractSize: null,
  stopsLevel: 0,
  freezeLevel: 0,
  defaultLot: 0.01,
  lastBalance: 10000,
}

test('deriveManualStopsWithClamp: predefined SL ignores signal SL price', () => {
  const entry = 1.1
  const signalSl = 1.095
  const { finalSl, pip } = deriveManualStopsWithClamp({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: entry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: signalSl,
      tp: [1.12],
      lot_size: null,
    },
    manual: {
      use_predefined_sl_pips: true,
      predefined_sl_pips: 30,
      use_predefined_tp_pips: false,
    },
    channelKeywords: null,
    resolvedSymbol: 'EURUSD',
    ctx: baseCtx,
    entryAnchor: entry,
    isBuy: true,
  })
  const expected = Number((entry - 30 * pip).toFixed(5))
  assert.ok(finalSl != null)
  assert.equal(Number(finalSl.toFixed(5)), expected)
  assert.notEqual(finalSl, signalSl)
})

test('deriveManualStopsWithClamp: predefined TP ignores signal TP prices', () => {
  const entry = 1.1
  const { finalTps, pip } = deriveManualStopsWithClamp({
    parsed: {
      action: 'buy',
      symbol: 'EURUSD',
      entry_price: entry,
      entry_zone_low: null,
      entry_zone_high: null,
      sl: 1.07,
      tp: [1.5, 1.6],
      lot_size: null,
    },
    manual: {
      use_predefined_sl_pips: false,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [20, 40],
    },
    channelKeywords: null,
    resolvedSymbol: 'EURUSD',
    ctx: baseCtx,
    entryAnchor: entry,
    isBuy: true,
  })
  assert.equal(finalTps.length, 2)
  assert.equal(Number(finalTps[0]!.toFixed(5)), Number((entry + 20 * pip).toFixed(5)))
  assert.equal(Number(finalTps[1]!.toFixed(5)), Number((entry + 40 * pip).toFixed(5)))
  assert.notEqual(Number(finalTps[0]!.toFixed(5)), 1.5)
})
