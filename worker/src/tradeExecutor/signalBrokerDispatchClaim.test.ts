import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  claimIsStale,
  claimSignalBrokerDispatch,
  isDuplicateKeyError,
  shouldTakeOverStaleClaim,
} from './signalBrokerDispatchClaim'

describe('signalBrokerDispatchClaim', () => {
  it('isDuplicateKeyError detects postgres unique violations', () => {
    assert.equal(isDuplicateKeyError({ code: '23505' }), true)
    assert.equal(isDuplicateKeyError({ message: 'duplicate key value violates unique constraint' }), true)
    assert.equal(isDuplicateKeyError({ message: 'connection refused' }), false)
    assert.equal(isDuplicateKeyError(null), false)
  })

  it('claimSignalBrokerDispatch returns true on clean insert', async () => {
    const supabase = {
      from() {
        return {
          insert: async () => ({ error: null }),
        }
      },
    }
    assert.equal(await claimSignalBrokerDispatch(supabase as never, 's1', 'b1'), true)
  })

  it('claimSignalBrokerDispatch returns false on duplicate key', async () => {
    const supabase = {
      from() {
        return {
          insert: async () => ({ error: { code: '23505', message: 'duplicate key' } }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }
      },
    }
    assert.equal(await claimSignalBrokerDispatch(supabase as never, 's1', 'b1'), false)
  })

  it('claimSignalBrokerDispatch fails closed on other insert errors', async () => {
    const logs: unknown[] = []
    const supabase = {
      from(table: string) {
        return {
          insert: async (row: unknown) => {
            if (table === 'trade_execution_logs') {
              logs.push(row)
              return { error: null }
            }
            return { error: { code: '57014', message: 'statement timeout' } }
          },
        }
      },
    }
    assert.equal(await claimSignalBrokerDispatch(supabase as never, 's1', 'b1', 'u1'), false)
    assert.equal(logs.length, 1)
    assert.equal((logs[0] as { action: string; user_id: string }).action, 'dispatch_claim_error')
    assert.equal((logs[0] as { user_id: string }).user_id, 'u1')
  })

  it('claimSignalBrokerDispatch skips error log when user_id missing', async () => {
    const logs: unknown[] = []
    const supabase = {
      from(table: string) {
        return {
          insert: async (row: unknown) => {
            if (table === 'trade_execution_logs') {
              logs.push(row)
              return { error: null }
            }
            return { error: { code: '57014', message: 'statement timeout' } }
          },
        }
      },
    }
    assert.equal(await claimSignalBrokerDispatch(supabase as never, 's1', 'b1'), false)
    assert.equal(logs.length, 0)
  })

  it('shouldTakeOverStaleClaim allows revision to reclaim when nothing materialized and not in-flight', () => {
    assert.equal(
      shouldTakeOverStaleClaim({ isRevisionRefresh: true, materialized: false, entryInFlight: false }),
      true,
    )
  })

  it('shouldTakeOverStaleClaim blocks take-over while the first entry is still running', () => {
    assert.equal(
      shouldTakeOverStaleClaim({ isRevisionRefresh: true, materialized: false, entryInFlight: true }),
      false,
    )
  })

  it('shouldTakeOverStaleClaim blocks take-over when the signal already materialized', () => {
    assert.equal(
      shouldTakeOverStaleClaim({ isRevisionRefresh: true, materialized: true, entryInFlight: false }),
      false,
    )
  })

  it('shouldTakeOverStaleClaim is never true for non-revision dispatches', () => {
    assert.equal(
      shouldTakeOverStaleClaim({ isRevisionRefresh: false, materialized: false, entryInFlight: false }),
      false,
    )
  })
})

describe('dispatch claim lease', () => {
  it('claimIsStale only after the lease expires', () => {
    const now = Date.parse('2026-10-20T12:00:00.000Z')
    assert.equal(claimIsStale('2026-10-20T11:59:00.000Z', now, 120_000), false)
    assert.equal(claimIsStale('2026-10-20T11:57:00.000Z', now, 120_000), true)
    assert.equal(claimIsStale(null, now, 120_000), false)
    assert.equal(claimIsStale('not-a-date', now, 120_000), false)
  })

  function fakeClaimSupabase(createdAt: string, insertErrors: Array<unknown>) {
    let inserts = 0
    let deletes = 0
    const supabase = {
      from(table: string) {
        assert.equal(table, 'signal_broker_dispatch_claims')
        return {
          insert: async () => ({ error: insertErrors[inserts++] ?? null }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { created_at: createdAt }, error: null }),
              }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  select: async () => {
                    deletes += 1
                    return { data: [{ id: 'claim-1' }], error: null }
                  },
                }),
              }),
            }),
          }),
        }
      },
    }
    return { supabase, deletes: () => deletes }
  }

  it('takes over a stale claim and retries the insert', async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString()
    const fake = fakeClaimSupabase(createdAt, [{ code: '23505', message: 'duplicate key' }, null])
    assert.equal(await claimSignalBrokerDispatch(fake.supabase as never, 's1', 'b1'), true)
    assert.equal(fake.deletes(), 1)
  })

  it('does not take over a fresh claim', async () => {
    const createdAt = new Date().toISOString()
    const fake = fakeClaimSupabase(createdAt, [{ code: '23505', message: 'duplicate key' }])
    assert.equal(await claimSignalBrokerDispatch(fake.supabase as never, 's1', 'b1'), false)
    assert.equal(fake.deletes(), 0)
  })
})

describe('stale claim delete guard', () => {
  it('does not report a takeover when the guarded delete removed no row', async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString()
    let inserts = 0
    const supabase = {
      from() {
        return {
          insert: async () => { inserts += 1; return { error: { code: '23505', message: 'duplicate key' } } },
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { created_at: createdAt }, error: null }),
              }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({ select: async () => ({ data: [], error: null }) }),
              }),
            }),
          }),
        }
      },
    }
    assert.equal(await claimSignalBrokerDispatch(supabase as never, 's1', 'b1'), false)
    assert.equal(inserts, 1)
  })
})
