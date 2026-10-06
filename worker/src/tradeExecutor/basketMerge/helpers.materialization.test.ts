import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { manualDispatchAlreadyMaterialized } from './helpers'

function context(counts: Record<string, number>, errorTable?: string) {
  return {
    supabase: {
      from(table: string) {
        const query = {
          select() { return query },
          eq() { return query },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve({
              count: counts[table] ?? 0,
              error: table === errorTable ? { message: 'lookup unavailable' } : null,
            }).then(resolve)
          },
        }
        return query
      },
    },
  }
}

describe('manual revision materialization authority', () => {
  it('treats a durable signal range wait as materialized', async () => {
    const materialized = await manualDispatchAlreadyMaterialized(
      context({ signal_range_entry_waits: 1 }) as never,
      'signal-1',
      'broker-1',
    )
    assert.equal(materialized, true)
  })

  it('returns false only when every durable materialization lookup succeeds empty', async () => {
    const materialized = await manualDispatchAlreadyMaterialized(
      context({}) as never,
      'signal-1',
      'broker-1',
    )
    assert.equal(materialized, false)
  })

  it('fails closed when durable materialization state cannot be read', async () => {
    const materialized = await manualDispatchAlreadyMaterialized(
      context({}, 'trades') as never,
      'signal-1',
      'broker-1',
    )
    assert.equal(materialized, true)
  })
})
