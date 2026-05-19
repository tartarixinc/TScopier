import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  signalMatchesExecutorMode,
} from './tradeSignalActions'

describe('tradeSignalActions', () => {
  test('isEntryAction', () => {
    assert.equal(isEntryAction('buy'), true)
    assert.equal(isEntryAction('modify'), false)
  })

  test('signalMatchesExecutorMode entry vs mgmt', () => {
    assert.equal(signalMatchesExecutorMode({ action: 'buy' }, 'entry'), true)
    assert.equal(signalMatchesExecutorMode({ action: 'buy' }, 'mgmt'), false)
    assert.equal(signalMatchesExecutorMode({ action: 'close' }, 'mgmt'), true)
    assert.equal(signalMatchesExecutorMode({ action: 'close' }, 'entry'), false)
  })

  test('dispatchPriorityForAction', () => {
    assert.equal(dispatchPriorityForAction('sell'), 'high')
    assert.equal(dispatchPriorityForAction('modify'), 'normal')
  })
})
