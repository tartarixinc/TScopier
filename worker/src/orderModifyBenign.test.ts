import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isBenignOrderModifyError } from './orderModifyBenign'

describe('isBenignOrderModifyError', () => {
  it('matches MT5 already-have-parameters message', () => {
    assert.equal(
      isBenignOrderModifyError('Order already have this parameters (:52886408)'),
      true,
    )
  })

  it('does not match unrelated errors', () => {
    assert.equal(isBenignOrderModifyError('Symbol not found: BTCUSD'), false)
    assert.equal(isBenignOrderModifyError('Not enough money'), false)
  })
})
