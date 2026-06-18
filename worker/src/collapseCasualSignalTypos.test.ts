import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collapseCasualSignalTypos } from './collapseCasualSignalTypos'

describe('collapseCasualSignalTypos', () => {
  it('collapses stretched breakeven', () => {
    assert.equal(collapseCasualSignalTypos('Set breakevennnnnnnn'), 'Set breakeven')
    assert.equal(collapseCasualSignalTypos('breakevennn noowwwww'), 'breakeven now')
  })

  it('collapses break even with extra letters', () => {
    assert.equal(collapseCasualSignalTypos('move stop to break evennn'), 'move stop to break even')
  })

  it('leaves normal breakeven unchanged', () => {
    assert.equal(
      collapseCasualSignalTypos('Move SL to breakeven on XAUUSD'),
      'Move SL to breakeven on XAUUSD',
    )
  })
})
