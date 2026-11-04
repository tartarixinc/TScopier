import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchPlanFallbackReason,
  isTpSplitSkippedReason,
  staleEntryNotice,
  STALE_ENTRY_RATIO,
} from './tradeExecutionNotes'

describe('staleEntryNotice', () => {
  it('flags a fill that ran well past the signal entry (the 4115 -> 4137.85 case)', () => {
    const notice = staleEntryNotice(4115, 4137.85)
    expect(notice).not.toBeNull()
    expect(notice!.signalEntry).toBe(4115)
    expect(notice!.fillPrice).toBe(4137.85)
    expect(notice!.deltaPct).toBeGreaterThan(STALE_ENTRY_RATIO)
  })

  it('ignores ordinary slippage below the threshold', () => {
    expect(staleEntryNotice(4115, 4116)).toBeNull()
    expect(staleEntryNotice(1.1, 1.101)).toBeNull()
  })

  it('flags moves in either direction', () => {
    expect(staleEntryNotice(4137, 4115)).not.toBeNull()
  })

  it('returns null for missing, zero, or non-numeric inputs', () => {
    expect(staleEntryNotice(null, 4137)).toBeNull()
    expect(staleEntryNotice(4115, null)).toBeNull()
    expect(staleEntryNotice(undefined, undefined)).toBeNull()
    expect(staleEntryNotice(0, 4137)).toBeNull()
    expect(staleEntryNotice('4115', '4137.85')).not.toBeNull()
    expect(staleEntryNotice('abc', 4137)).toBeNull()
  })
})

describe('isTpSplitSkippedReason', () => {
  it('matches only the below-min-lot partial skip reason', () => {
    expect(isTpSplitSkippedReason('partial_tp_below_min_lot')).toBe(true)
    expect(isTpSplitSkippedReason('partial_tp_capped_remainder')).toBe(false)
    expect(isTpSplitSkippedReason('multi_trade_fallback_empty_tps')).toBe(false)
    expect(isTpSplitSkippedReason(null)).toBe(false)
    expect(isTpSplitSkippedReason(undefined)).toBe(false)
  })
})

function fakeSupabase(options: {
  children?: unknown[]
  logRows?: Array<{ request_payload: unknown }>
  logError?: boolean
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'signals') {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      limit: async () => ({ data: options.children ?? [], error: null }),
                    }
                  },
                }
              },
            }
          },
        }
      }
      // trade_execution_logs
      return {
        select() {
          return {
            in() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        eq() {
                          return {
                            order() {
                              return {
                                limit: async () =>
                                  options.logError
                                    ? { data: null, error: { message: 'boom' } }
                                    : { data: options.logRows ?? [], error: null },
                              }
                            },
                          }
                        },
                      }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

describe('fetchPlanFallbackReason', () => {
  it('returns the reason from the latest plan_fallback row', async () => {
    const client = fakeSupabase({
      children: [{ id: 'child-1' }],
      logRows: [{ request_payload: { reason: 'partial_tp_below_min_lot' } }],
    })
    expect(await fetchPlanFallbackReason(client, { userId: 'u', signalId: 's', brokerAccountId: 'b' })).toBe(
      'partial_tp_below_min_lot',
    )
  })

  it('returns null when there is no row, the payload is malformed, or the query errors', async () => {
    expect(await fetchPlanFallbackReason(fakeSupabase({ logRows: [] }), { userId: 'u', signalId: 's', brokerAccountId: 'b' })).toBeNull()
    expect(
      await fetchPlanFallbackReason(fakeSupabase({ logRows: [{ request_payload: 'not-an-object' }] }), {
        userId: 'u',
        signalId: 's',
        brokerAccountId: 'b',
      }),
    ).toBeNull()
    expect(
      await fetchPlanFallbackReason(fakeSupabase({ logError: true }), { userId: 'u', signalId: 's', brokerAccountId: 'b' }),
    ).toBeNull()
  })
})
