import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  bundleSteadyLegTps,
  bundleTpOrderMap,
  remapBundleLegTpsByTpOrder,
} from './tpBundleIdentity'

// Ladder ordered nearest → farthest as parsed (buy: ascending).
const buyLadder = [1900, 1910, 1920]

test('steady state keeps each leg own TP', () => {
  const tps = bundleSteadyLegTps({ currentTps: [1900, 1910, 1920], ladder: buyLadder })
  assert.deepEqual(tps, [1900, 1910, 1920])
})

test('steady state backfills naked legs positionally', () => {
  const tps = bundleSteadyLegTps({ currentTps: [0, null, undefined], ladder: buyLadder })
  assert.deepEqual(tps, [1900, 1910, 1920])
})

test('steady state keeps own TP when a middle level is missing', () => {
  // TP3 leg survives a closed TP2 leg — it must keep 1920, not be pulled to TP2.
  const tps = bundleSteadyLegTps({ currentTps: [1900, 0, 1920], ladder: buyLadder })
  assert.deepEqual(tps, [1900, 1910, 1920])
})

test('reladder maps levels 1:1 by TP order (buy ascending)', () => {
  const tps = remapBundleLegTpsByTpOrder({
    legs: [1900, 1910, 1920],
    ladder: [2000, 2010, 2020],
    isBuy: true,
  })
  assert.deepEqual(tps, [2000, 2010, 2020])
})

test('reladder keeps leg order independent of input order (buy)', () => {
  const tps = remapBundleLegTpsByTpOrder({
    legs: [1920, 1900, 1910],
    ladder: [2000, 2010, 2020],
    isBuy: true,
  })
  // 1900 was nearest → gets 2000, 1910 → 2010, 1920 → 2020.
  assert.deepEqual(tps, [2020, 2000, 2010])
})

test('reladder sell sorts nearest (highest price) first', () => {
  const tps = remapBundleLegTpsByTpOrder({
    legs: [1920, 1910, 1900],
    ladder: [1900, 1910, 1920],
    isBuy: false,
  })
  // nearest for sell = highest = 1920 → ladder[0]=1900; 1910 → 1910; 1900 → 1920.
  assert.deepEqual(tps, [1900, 1910, 1920])
})

test('reladder surplus legs keep their own TP', () => {
  const tps = remapBundleLegTpsByTpOrder({
    legs: [1900, 1910, 1920],
    ladder: [2000, 2010],
    isBuy: true,
  })
  assert.deepEqual(tps, [2000, 2010, 1920])
})

test('reladder with no ladder keeps own TPs', () => {
  const tps = remapBundleLegTpsByTpOrder({ legs: [1900, null, 1920], ladder: [], isBuy: true })
  assert.deepEqual(tps, [1900, 0, 1920])
})

test('bundleTpOrderMap maps by leg id', () => {
  const map = bundleTpOrderMap({
    legs: [
      { id: 'a', tp: 1900 },
      { id: 'b', tp: 1910 },
      { id: 'c', tp: 1920 },
    ],
    ladder: [2000, 2010, 2020],
    isBuy: true,
  })
  assert.equal(map.get('a'), 2000)
  assert.equal(map.get('b'), 2010)
  assert.equal(map.get('c'), 2020)
})
