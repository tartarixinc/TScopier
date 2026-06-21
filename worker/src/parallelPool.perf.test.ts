import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parallelMap } from './parallelPool'
import { assertLatencyBudget, benchmarkAsync } from './test/perfBudget'

describe('parallelMap latency', () => {
  it('maps 120 items with concurrency 8 within budget', async () => {
    const items = Array.from({ length: 120 }, (_, i) => i)

    const samples = await benchmarkAsync(async () => {
      const out = await parallelMap(items, 8, async (n) => {
        await new Promise((r) => setTimeout(r, 1))
        return n * 2
      })
      assert.equal(out.length, 120)
      assert.equal(out[0], 0)
      assert.equal(out[119], 238)
    }, 5)

    assertLatencyBudget('parallelMap(120, c=8)', samples, 250)
  })
})
