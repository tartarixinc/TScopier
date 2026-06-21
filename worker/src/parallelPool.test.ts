import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parallelMap } from './parallelPool'

describe('parallelMap', () => {
  it('runs all items with bounded concurrency', async () => {
    const order: number[] = []
    let inFlight = 0
    let maxInFlight = 0

    await parallelMap([0, 1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(r => setTimeout(r, 5))
      order.push(n)
      inFlight -= 1
      return n * 2
    })

    assert.equal(order.length, 6)
    assert.ok(maxInFlight <= 2, `expected max concurrency 2, saw ${maxInFlight}`)
  })

  it('returns results in input order', async () => {
    const results = await parallelMap(['a', 'b', 'c'], 3, async (s, i) => `${s}${i}`)
    assert.deepEqual(results, ['a0', 'b1', 'c2'])
  })

  it('returns empty array for empty input', async () => {
    const results = await parallelMap([], 6, async () => 1)
    assert.deepEqual(results, [])
  })
})
