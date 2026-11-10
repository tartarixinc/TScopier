import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allTakeProfitsBeyondMarket, entryPriceMovedAdverse } from './signalEntryPriceGuard'

describe('entryPriceMovedAdverse', () => {
  const base = {
    entryPrice: 4276,
    zoneLow: null,
    zoneHigh: null,
    tolerancePips: 10,
    pipSize: 0.1,
  }

  it('buy: blocks when ask is above entry beyond tolerance', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'buy', bid: 4277, ask: 4278 }), true)
  })

  it('buy: allows ask within tolerance of entry', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'buy', bid: 4275, ask: 4276.5 }), false)
  })

  it('buy: allows ask below entry (better price)', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'buy', bid: 4273, ask: 4274 }), false)
  })

  it('sell: blocks when bid is below entry beyond tolerance', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'sell', bid: 4274, ask: 4275 }), true)
  })

  it('sell: allows bid within tolerance of entry', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'sell', bid: 4275.5, ask: 4276 }), false)
  })

  it('sell: allows bid above entry (better price)', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'sell', bid: 4278, ask: 4279 }), false)
  })

  it('buy zone: blocks when ask exceeds zone high plus tolerance', () => {
    assert.equal(entryPriceMovedAdverse({
      ...base,
      action: 'buy',
      entryPrice: null,
      zoneLow: 4270,
      zoneHigh: 4276,
      bid: 4277,
      ask: 4278,
    }), true)
  })

  it('sell zone: blocks when bid drops below zone low minus tolerance', () => {
    assert.equal(entryPriceMovedAdverse({
      ...base,
      action: 'sell',
      entryPrice: null,
      zoneLow: 4270,
      zoneHigh: 4276,
      bid: 4268,
      ask: 4269,
    }), true)
  })

  it('zero tolerance blocks any adverse move', () => {
    assert.equal(entryPriceMovedAdverse({
      ...base,
      action: 'buy',
      tolerancePips: 0,
      bid: 4276,
      ask: 4276.2,
    }), true)
    assert.equal(entryPriceMovedAdverse({
      ...base,
      action: 'buy',
      tolerancePips: 0,
      bid: 4276,
      ask: 4276,
    }), false)
  })

  it('no entry anchor never blocks', () => {
    assert.equal(entryPriceMovedAdverse({
      ...base,
      action: 'buy',
      entryPrice: null,
      zoneLow: null,
      zoneHigh: null,
      bid: 4290,
      ask: 4291,
    }), false)
  })

  it('invalid quotes never block', () => {
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'buy', bid: NaN, ask: 4278 }), false)
    assert.equal(entryPriceMovedAdverse({ ...base, action: 'buy', bid: 0, ask: 4278 }), false)
  })

  it('falls back to a sane pip size when params are missing', () => {
    const r = entryPriceMovedAdverse({
      ...base,
      action: 'sell',
      pipSize: null,
      bid: 4275.998,
      ask: 4276,
    })
    assert.equal(r, true)
  })
})

describe('allTakeProfitsBeyondMarket', () => {
  // Luis / Gold PRO case: BUY entry 4017 filled at 4116.7 with TPs 4020/4024/4026.
  const quote = { bid: 4116.5, ask: 4116.7, symbol: 'XAUUSD' }

  it('buy: true when every TP is at/below the ask (the Luis case)', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'buy',
      tpLevels: [4020, 4024, 4026],
      ...quote,
    }), true)
  })

  it('buy: false when at least one TP is above the ask', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'buy',
      tpLevels: [4020, 4150],
      ...quote,
    }), false)
  })

  it('sell: true when every TP is at/above the bid', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'sell',
      tpLevels: [4150, 4160],
      ...quote,
    }), true)
  })

  it('sell: false when at least one TP is below the bid', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'sell',
      tpLevels: [4100, 4160],
      ...quote,
    }), false)
  })

  it('treats a level too close to the quote as unusable (all stripped → skip)', () => {
    // Valid side for a buy but inside the strip min-distance (ref * 1e-5 floor).
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'buy',
      tpLevels: [4116.71],
      ...quote,
    }), true)
  })

  it('ignores pip-denominated ladders', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'buy',
      tpLevels: [15, 30],
      tpUnit: 'pips',
      ...quote,
    }), false)
  })

  it('ignores levels that cannot be prices for this quote', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'buy',
      tpLevels: [15, 30],
      ...quote,
    }), false)
  })

  it('empty or missing ladders never block', () => {
    assert.equal(allTakeProfitsBeyondMarket({ action: 'buy', tpLevels: [], ...quote }), false)
    assert.equal(allTakeProfitsBeyondMarket({ action: 'buy', tpLevels: null, ...quote }), false)
    assert.equal(allTakeProfitsBeyondMarket({ action: 'buy', tpLevels: undefined, ...quote }), false)
    assert.equal(allTakeProfitsBeyondMarket({ action: 'buy', tpLevels: [4020], bid: 0, ask: 0 }), false)
  })

  it('non-numeric and non-positive levels are not judged', () => {
    assert.equal(allTakeProfitsBeyondMarket({ action: 'buy', tpLevels: ['x', -1, 0], ...quote }), false)
  })

  it('unknown direction never blocks', () => {
    assert.equal(allTakeProfitsBeyondMarket({
      action: 'long' as 'buy',
      tpLevels: [4020],
      ...quote,
    }), false)
  })
})
