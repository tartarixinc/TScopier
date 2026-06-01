import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hasTpTouchedLock, loadExistingRangeStepIndices } from './rangePendingFireGuard'

describe('loadExistingRangeStepIndices', () => {
  it('returns step indices from select rows', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                limit: async () => ({
                  data: [{ step_idx: 0 }, { step_idx: 3 }, { step_idx: 3 }],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }
    const steps = await loadExistingRangeStepIndices(
      supabase as never,
      'sig-1',
      'broker-1',
      'XAUUSD',
    )
    assert.deepEqual([...steps].sort((a, b) => a - b), [0, 3])
  })
})

describe('hasTpTouchedLock', () => {
  it('returns true when lock row exists', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: async () => ({
                count: 1,
                error: null,
              }),
            }),
          }),
        }),
      }),
    }
    const out = await hasTpTouchedLock(
      supabase as never,
      { signalId: 'sig-1', brokerAccountId: 'broker-1', symbol: 'XAUUSD' },
    )
    assert.equal(out, true)
  })
})
