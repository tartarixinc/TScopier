import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  accountModeFromBrokerRow,
  accountModeFromSummary,
  brokerAccountModeForPlatform,
} from './brokerAccountMode'

test('derives the mode from the MT summary method field', () => {
  assert.equal(accountModeFromSummary({ method: 'Hedging' }), 'hedging')
  assert.equal(accountModeFromSummary({ Method: 'NETTING' }), 'netting')
  assert.equal(accountModeFromSummary({ method: 'Exchange' }), 'netting')
  assert.equal(accountModeFromSummary({ method: 'Demo' }), 'unknown')
  assert.equal(accountModeFromSummary({}), 'unknown')
  assert.equal(accountModeFromSummary(null), 'unknown')
  assert.equal(accountModeFromSummary(undefined), 'unknown')
})

test('MT4 is always hedging regardless of the summary', () => {
  assert.equal(brokerAccountModeForPlatform('MT4', {}), 'hedging')
  assert.equal(brokerAccountModeForPlatform('mt4', { method: 'Netting' }), 'hedging')
})

test('MT5 uses the reported method and unknown when it is missing', () => {
  assert.equal(brokerAccountModeForPlatform('MT5', { method: 'Hedging' }), 'hedging')
  assert.equal(brokerAccountModeForPlatform('MT5', { method: 'Netting' }), 'netting')
  assert.equal(brokerAccountModeForPlatform('MT5', {}), 'unknown')
})

test('a stored mode always wins over platform knowledge', () => {
  assert.equal(accountModeFromBrokerRow({ provider: 'ctrader', margin_mode: 'netting' }), 'netting')
  assert.equal(accountModeFromBrokerRow({ provider: 'mtapi', platform: 'MT5', margin_mode: 'hedging' }), 'hedging')
  assert.equal(accountModeFromBrokerRow({ provider: 'dxtrade', dxtrade_is_position_based: false, margin_mode: 'hedging' }), 'hedging')
})

test('MT4 stays hedging when the stored mode is unknown', () => {
  assert.equal(accountModeFromBrokerRow({ provider: 'mtapi', platform: 'MT4', margin_mode: 'unknown' }), 'hedging')
})

test('platforms with no mode field answer hedging for their own provider', () => {
  for (const provider of ['ctrader', 'tradelocker', 'matchtrader']) {
    assert.equal(accountModeFromBrokerRow({ provider, margin_mode: 'unknown' }), 'hedging')
  }
  // ...and never for another provider, so an MT5 or crypto account still reads
  // unknown (fail closed) instead of inheriting that answer.
  assert.equal(accountModeFromBrokerRow({ provider: 'mtapi', platform: 'MT5', margin_mode: 'unknown' }), 'unknown')
  assert.equal(accountModeFromBrokerRow({ provider: 'binance', margin_mode: 'unknown' }), 'unknown')
  assert.equal(accountModeFromBrokerRow({ provider: 'fxsocket', platform: 'MT5', margin_mode: 'unknown' }), 'unknown')
})

test('DXtrade answers from the stored position-based flag, including all three states', () => {
  assert.equal(accountModeFromBrokerRow({ provider: 'dxtrade', dxtrade_is_position_based: true, margin_mode: 'unknown' }), 'hedging')
  assert.equal(accountModeFromBrokerRow({ provider: 'dxtrade', dxtrade_is_position_based: false, margin_mode: 'unknown' }), 'netting')
  assert.equal(accountModeFromBrokerRow({ provider: 'dxtrade', dxtrade_is_position_based: null, margin_mode: 'unknown' }), 'unknown')
  assert.equal(accountModeFromBrokerRow({ provider: 'dxtrade', margin_mode: 'unknown' }), 'unknown')
})

test('a legacy null provider with a stored mode still reads that mode', () => {
  assert.equal(accountModeFromBrokerRow({ provider: null, platform: 'MT5', margin_mode: 'hedging' }), 'hedging')
  assert.equal(accountModeFromBrokerRow({ provider: null, platform: 'MT5', margin_mode: null }), 'unknown')
})
