import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeWithProtectiveLegSl,
  mostProtectiveOpenLegSl,
  resolveEffectiveStoplossPriority,
  unanimousLegSl,
  isSlMoreProtective,
} from './basketEffectiveStops'
import type { BasketOpenLeg } from './basketSlTpReconcile'

function leg(sl: number | null): BasketOpenLeg {
  return {
    id: 't1',
    signal_id: 'sig',
    metaapi_order_id: '1',
    opened_at: '2026-06-17T11:00:00Z',
    lot_size: 0.01,
    sl,
    tp: 4265,
    entry_price: 4255,
    direction: 'buy',
    symbol: 'XAUUSD',
  }
}

describe('resolveEffectiveStoplossPriority', () => {
  it('prefers mgmt signal SL over anchor and channel', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: 4242,
      channelSl: 4240,
      legConsensus: null,
    })
    assert.equal(r.stoploss, 4242)
    assert.equal(r.source, 'mgmt_signal')
  })

  it('uses channel memory when no mgmt signal', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: null,
      channelSl: 4242,
      legConsensus: null,
    })
    assert.equal(r.stoploss, 4242)
    assert.equal(r.source, 'channel_memory')
  })

  it('keeps anchor when channel is stale and no mgmt', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: null,
      channelSl: null,
      legConsensus: null,
    })
    assert.equal(r.stoploss, 4245)
    assert.equal(r.source, 'anchor')
  })

  it('uses leg consensus when channel write failed but legs agree on adjusted SL', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: null,
      channelSl: null,
      legConsensus: 4242,
    })
    assert.equal(r.stoploss, 4242)
    assert.equal(r.source, 'leg_consensus')
  })
})

describe('unanimousLegSl', () => {
  it('returns shared SL when all legs match', () => {
    assert.equal(unanimousLegSl([leg(4242), leg(4242)]), 4242)
  })

  it('returns null when legs disagree', () => {
    assert.equal(unanimousLegSl([leg(4242), leg(4245)]), null)
  })
})

describe('mostProtectiveOpenLegSl', () => {
  it('returns highest SL for buy legs', () => {
    assert.equal(mostProtectiveOpenLegSl([leg(4242), leg(4248)], true), 4248)
  })

  it('returns lowest SL for sell legs', () => {
    const sellLeg = { ...leg(4248), direction: 'sell' as const }
    const sellLeg2 = { ...leg(4242), direction: 'sell' as const }
    assert.equal(mostProtectiveOpenLegSl([sellLeg, sellLeg2], false), 4242)
  })
})

describe('mergeWithProtectiveLegSl', () => {
  it('keeps tighter leg SL over anchor for buys', () => {
    assert.equal(mergeWithProtectiveLegSl(4245, 4248, true), 4248)
  })
})

describe('isSlMoreProtective', () => {
  it('detects buy leg SL above target', () => {
    assert.equal(isSlMoreProtective(4248, 4245, true), true)
    assert.equal(isSlMoreProtective(4245, 4248, true), false)
  })
})
