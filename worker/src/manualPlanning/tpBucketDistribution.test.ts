import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildDistributedPerLegTakeProfits,
  distributeCountAcrossTpBuckets,
} from './tpBucketDistribution'

test('distributeCountAcrossTpBuckets: 50/30/20 on 10 legs', () => {
  const counts = distributeCountAcrossTpBuckets(10, [
    { label: 'TP1', percent: 50 },
    { label: 'TP2', percent: 30 },
    { label: 'TP3', percent: 20 },
  ])
  assert.deepEqual(counts, [5, 3, 2])
})

test('buildDistributedPerLegTakeProfits: maps legs to TP1/TP2/TP3 prices', () => {
  const prices = buildDistributedPerLegTakeProfits({
    openLegCount: 10,
    finalTps: [4530, 4510, 4490],
    tpLots: [
      { label: 'TP1', lot: 0, percent: 50, enabled: true },
      { label: 'TP2', lot: 0, percent: 30, enabled: true },
      { label: 'TP3', lot: 0, percent: 20, enabled: true },
    ],
  })
  assert.equal(prices.length, 10)
  assert.equal(prices.filter(p => p === 4530).length, 5)
  assert.equal(prices.filter(p => p === 4510).length, 3)
  assert.equal(prices.filter(p => p === 4490).length, 2)
})
