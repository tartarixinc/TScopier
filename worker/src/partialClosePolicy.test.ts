import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { planPartialClose, verifyPartialCloseReduction } from './partialClosePolicy'

describe('partial close volume policy', () => {
  it('rejects 50% of 0.01 when broker min and step are 0.01', () => {
    assert.deepEqual(planPartialClose({
      currentVolume: 0.01,
      requestedFraction: 0.5,
      minVolume: 0.01,
      volumeStep: 0.01,
      maxVolume: 100,
    }), {
      ok: false,
      reason: 'partial_close_unavailable_for_position_size',
      rawCloseVolume: 0.005,
    })
  })

  it('closes 0.01 from 0.02 at a 0.01 broker step', () => {
    assert.deepEqual(planPartialClose({
      currentVolume: 0.02,
      requestedFraction: 0.5,
      minVolume: 0.01,
      volumeStep: 0.01,
      maxVolume: 100,
    }), {
      ok: true,
      closeVolume: 0.01,
      expectedRemainingVolume: 0.01,
      rawCloseVolume: 0.01,
    })
  })

  it('never rounds a partial reduction into a full close', () => {
    const result = planPartialClose({
      currentVolume: 0.015,
      requestedFraction: 0.9,
      minVolume: 0.01,
      volumeStep: 0.01,
    })
    assert.equal(result.ok, false)
  })

  it('accepts only an authoritative compatible remaining volume', () => {
    assert.deepEqual(verifyPartialCloseReduction({
      originalVolume: 0.02,
      requestedCloseVolume: 0.01,
      observedRemainingVolume: 0.01,
      volumeStep: 0.01,
    }), { ok: true })
    assert.equal(verifyPartialCloseReduction({
      originalVolume: 0.02,
      requestedCloseVolume: 0.01,
      observedRemainingVolume: 0.02,
      volumeStep: 0.01,
    }).ok, false)
    assert.equal(verifyPartialCloseReduction({
      originalVolume: 0.02,
      requestedCloseVolume: 0.01,
      observedRemainingVolume: Number.NaN,
      volumeStep: 0.01,
    }).ok, false)
    assert.equal(verifyPartialCloseReduction({
      originalVolume: 0.02,
      requestedCloseVolume: 0.01,
      observedRemainingVolume: 0,
      volumeStep: 0.01,
    }).ok, false)
  })
})
