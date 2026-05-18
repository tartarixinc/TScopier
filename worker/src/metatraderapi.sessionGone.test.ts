import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMtSessionGoneMessage } from './metatraderapi'

describe('isMtSessionGoneMessage', () => {
  it('detects client-not-found from MT bridge', () => {
    assert.equal(
      isMtSessionGoneMessage('Client with id = 2dea21ee-72f3-4ea0-852f-cda48006eed5 not found (:0)'),
      true,
    )
  })

  it('ignores unrelated errors', () => {
    assert.equal(isMtSessionGoneMessage('Symbol not found'), false)
  })
})
