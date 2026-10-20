import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { accountModeFromSummary, brokerAccountModeForPlatform } from './brokerAccountMode'

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
