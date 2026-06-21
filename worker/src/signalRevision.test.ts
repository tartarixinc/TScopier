import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isIncomingRevisionStale,
  updateSignalAfterRevision,
} from './signalRevision'

import type { ParseChannelMessageResult } from './parseSignal'

const parsedPatch: ParseChannelMessageResult = {
  status: 'parsed',
  skip_reason: null,
  parsed: {
    action: 'buy',
    symbol: 'XAUUSD',
    sl: 2650,
    tp: [2670],
    entry_price: null,
    entry_zone_low: null,
    entry_zone_high: null,
    lot_size: null,
    confidence: 1,
    raw_instruction: 'Gold buy SL 2650',
  },
}

describe('signalRevision', () => {
  it('isIncomingRevisionStale rejects older incoming edit_date', () => {
    assert.equal(isIncomingRevisionStale(101, 100), true)
    assert.equal(isIncomingRevisionStale(100, 101), false)
    assert.equal(isIncomingRevisionStale(100, 100), false)
    assert.equal(isIncomingRevisionStale(null, 100), false)
    assert.equal(isIncomingRevisionStale(100, null), false)
  })

  it('updateSignalAfterRevision applies conditional edit_date filter', async () => {
    const filters: string[] = []
    const supabase = {
      from: () => ({
        update: (patch: Record<string, unknown>) => {
          void patch
          return {
            eq: () => ({
              or: (filter: string) => {
                filters.push(filter)
                return {
                  select: () => ({
                    maybeSingle: async () => ({ data: { id: 'signal-1' }, error: null }),
                  }),
                }
              },
              select: () => ({
                maybeSingle: async () => ({ data: { id: 'signal-1' }, error: null }),
              }),
            }),
          }
        },
      }),
    }

    const ok = await updateSignalAfterRevision(supabase as never, {
      signalId: 'signal-1',
      rawMessage: 'Gold buy SL 2650',
      parseResult: parsedPatch,
      telegramEditDateSeen: 101,
    })
    assert.equal(ok, true)
    assert.equal(filters.length, 1)
    assert.match(filters[0]!, /telegram_edit_date_seen\.lte\.101/)
  })

  it('updateSignalAfterRevision returns false when conditional update matches no row', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            or: () => ({
              select: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
    }

    const ok = await updateSignalAfterRevision(supabase as never, {
      signalId: 'signal-1',
      rawMessage: 'old text',
      parseResult: parsedPatch,
      telegramEditDateSeen: 100,
    })
    assert.equal(ok, false)
  })

  it('updateSignalAfterRevision skips edit_date filter when incoming edit_date absent', async () => {
    let usedOr = false
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            or: () => {
              usedOr = true
              return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }
            },
            select: () => ({
              maybeSingle: async () => ({ data: { id: 'signal-1' }, error: null }),
            }),
          }),
        }),
      }),
    }

    const ok = await updateSignalAfterRevision(supabase as never, {
      signalId: 'signal-1',
      rawMessage: 'Gold buy now',
      parseResult: parsedPatch,
    })
    assert.equal(ok, true)
    assert.equal(usedOr, false)
  })
})
