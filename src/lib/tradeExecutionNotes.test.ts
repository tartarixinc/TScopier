import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchPartialCloseTooSmall,
  fetchPlanFallbackReason,
  isTpSplitSkippedReason,
  staleEntryNotice,
  strippedTpNotice,
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
  logRows?: Array<{ request_payload: unknown; status?: string; created_at?: string }>
  logError?: boolean
  /** Filters seen on the trade_execution_logs query (scoping assertions). */
  logFilters?: Array<{ col: string; val: unknown }>
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'signals') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          limit: async () => ({ data: options.children ?? [], error: null }),
        }
        return chain
      }
      // trade_execution_logs
      const logChain = {
        select: () => logChain,
        in: (col: string, val: unknown) => {
          options.logFilters?.push({ col, val })
          return logChain
        },
        eq: (col: string, val: unknown) => {
          options.logFilters?.push({ col, val })
          return logChain
        },
        order: (col: string, opts: unknown) => {
          options.logFilters?.push({ col: 'order', val: opts })
          return logChain
        },
        limit: async () =>
          options.logError
            ? { data: null, error: { message: 'boom' } }
            : { data: options.logRows ?? [], error: null },
      }
      return logChain
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

describe('fetchPartialCloseTooSmall', () => {
  const args = { userId: 'u', signalId: 'entry-1', brokerAccountId: 'br-1', ticket: 4242 }

  const refusal = {
    status: 'skipped',
    request_payload: {
      ticket: 4242,
      skip_reason: 'partial_close_unavailable_for_position_size',
    },
    created_at: '2026-11-08T10:04:00Z',
  }

  it('is true when THIS ticket was refused for size on THIS broker account', async () => {
    const logs: Array<{ col: string; val: unknown }> = []
    const client = fakeSupabase({
      children: [{ id: 'mgmt-1' }],
      logRows: [refusal],
      logFilters: logs,
    })
    expect(await fetchPartialCloseTooSmall(client, args)).toBe(true)
    // The scope must be pinned: signals, user, broker account and action.
    expect(logs).toContainEqual({ col: 'user_id', val: 'u' })
    expect(logs).toContainEqual({ col: 'broker_account_id', val: 'br-1' })
    expect(logs).toContainEqual({ col: 'action', val: 'mgmt_partial_profit' })
    expect(logs).toContainEqual({ col: 'signal_id', val: ['entry-1', 'mgmt-1'] })
    // Newest-first decides which row wins — without it a stale refusal could
    // shadow a later success (round-7 MEDIUM 2c).
    expect(logs).toContainEqual({ col: 'order', val: expect.objectContaining({ ascending: false }) })
  })

  it('is false when the newest row for this ticket succeeded (a later instruction cleared it)', async () => {
    const client = fakeSupabase({
      children: [{ id: 'mgmt-1' }],
      logRows: [
        {
          status: 'success',
          request_payload: { ticket: 4242 },
          created_at: '2026-11-08T11:00:00Z', // after the refusal
        },
        refusal,
      ],
    })
    expect(await fetchPartialCloseTooSmall(client, args)).toBe(false)
  })

  it('ignores rows for other tickets (a sibling leg of the same instruction)', async () => {
    const client = fakeSupabase({
      children: [{ id: 'mgmt-1' }],
      logRows: [
        { ...refusal, request_payload: { ...refusal.request_payload, ticket: 9999 } },
      ],
    })
    expect(await fetchPartialCloseTooSmall(client, args)).toBe(false)
  })

  it('is false when nothing was recorded or the logs query errors', async () => {
    expect(await fetchPartialCloseTooSmall(fakeSupabase({ logRows: [] }), args)).toBe(false)
    expect(await fetchPartialCloseTooSmall(fakeSupabase({ logError: true }), args)).toBe(false)
  })
})

describe('strippedTpNotice', () => {
  it('flags a buy whose every take-profit sits at or below the fill (4104.51 vs 4087/4095/4100)', () => {
    const notice = strippedTpNotice({
      tpLevels: [4087, 4095, 4100],
      fillPrice: 4104.51,
      brokerTp: null,
      direction: 'buy',
    })
    expect(notice).not.toBeNull()
    expect(notice!.levels).toEqual([4087, 4095, 4100])
    expect(notice!.fillPrice).toBe(4104.51)
  })

  it('flags a sell whose every take-profit sits at or above the fill', () => {
    const notice = strippedTpNotice({
      tpLevels: [4130, 4135],
      fillPrice: 4123.1,
      brokerTp: 0,
      direction: 'sell',
    })
    expect(notice).not.toBeNull()
  })

  it('stays silent when the trade already carries a broker take-profit', () => {
    expect(strippedTpNotice({
      tpLevels: [4130], fillPrice: 4123, brokerTp: 4130, direction: 'sell',
    })).toBeNull()
  })

  it('reports only the wrong-side subset when the ladder straddles the fill', () => {
    // tp[0]=4110 is at/below the buy fill and was stripped; 4130 was still
    // valid — the notice lists only what actually got stripped.
    const notice = strippedTpNotice({
      tpLevels: [4110, 4130], fillPrice: 4123, brokerTp: null, direction: 'buy',
    })
    expect(notice).not.toBeNull()
    expect(notice!.levels).toEqual([4110])
  })

  it('stays silent when no level is wrong-side of the fill', () => {
    expect(strippedTpNotice({
      tpLevels: [4130, 4140], fillPrice: 4123, brokerTp: null, direction: 'buy',
    })).toBeNull()
  })

  it('never treats pip-denominated levels as prices', () => {
    expect(strippedTpNotice({
      tpLevels: [15, 30], fillPrice: 4104, brokerTp: null, direction: 'buy', tpUnit: 'pips',
    })).toBeNull()
    // Magnitude guard: offset-shaped numbers against a price fill are not
    // prices even when tp_unit was not set (tp_in_pips channels).
    expect(strippedTpNotice({
      tpLevels: [15, 30], fillPrice: 4104, brokerTp: null, direction: 'buy',
    })).toBeNull()
    expect(strippedTpNotice({
      tpLevels: [0.0005, 0.001], fillPrice: 1.08, brokerTp: null, direction: 'buy',
    })).toBeNull()
  })

  it('returns null for missing levels, fill, or direction', () => {
    expect(strippedTpNotice({ tpLevels: [], fillPrice: 4100, brokerTp: null, direction: 'buy' })).toBeNull()
    expect(strippedTpNotice({ tpLevels: [4100], fillPrice: null, brokerTp: null, direction: 'buy' })).toBeNull()
    expect(strippedTpNotice({ tpLevels: [4100], fillPrice: 4101, brokerTp: null, direction: '' })).toBeNull()
    expect(strippedTpNotice({ tpLevels: 'nope', fillPrice: 4101, brokerTp: null, direction: 'buy' })).toBeNull()
  })
})
