import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isIncomingRevisionStale,
  isOpenAiRateLimitMessage,
  revisionCompletesSettleableEntry,
  revisionHasDeterministicActionableParse,
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

  it('detects teaser completion revisions deterministically', () => {
    assert.equal(
      revisionCompletesSettleableEntry(
        {
          action: 'buy',
          sl: null,
          tp: [],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
        },
        {
          action: 'buy',
          sl: 2650,
          tp: [2670, 2680],
          entry_price: null,
          entry_zone_low: 2660,
          entry_zone_high: 2655,
        },
      ),
      true,
    )
    assert.equal(
      revisionCompletesSettleableEntry(
        {
          action: 'buy',
          sl: null,
          tp: [],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
        },
        {
          action: 'buy',
          sl: null,
          tp: [],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
        },
      ),
      false,
    )
  })

  it('detects SL/TP ladder edits on already-complete entries without AI', () => {
    assert.equal(
      revisionHasDeterministicActionableParse(
        {
          action: 'sell',
          sl: 4055,
          tp: [4046, 4043, 4042],
        },
        {
          action: 'sell',
          sl: 4052,
          tp: [4046, 4043, 4040],
        },
      ),
      true,
    )
    assert.equal(
      revisionHasDeterministicActionableParse(
        {
          action: 'sell',
          sl: 4055,
          tp: [4046, 4043, 4042],
        },
        {
          action: 'sell',
          sl: null,
          tp: [],
        },
      ),
      false,
    )
  })

  it('detects OpenAI quota and rate limit errors', () => {
    assert.equal(isOpenAiRateLimitMessage('OpenAI HTTP 429: quota exceeded'), true)
    assert.equal(isOpenAiRateLimitMessage('insufficient_quota'), true)
    assert.equal(isOpenAiRateLimitMessage('plain timeout'), false)
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

  it('updateSignalAfterRevision preserves executed status on cosmetic edits', async () => {
    let patch: Record<string, unknown> | null = null
    const supabase = {
      from: () => ({
        update: (p: Record<string, unknown>) => {
          patch = p
          return {
            eq: () => ({
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
      existingStatus: 'executed',
    })
    assert.equal(ok, true)
    const appliedPatch = patch as Record<string, unknown> | null
    assert.equal(appliedPatch?.status, undefined)
    assert.equal(appliedPatch?.skip_reason, undefined)
    assert.equal(appliedPatch?.raw_message, 'Gold buy SL 2650')
  })

  it('updateSignalAfterRevision upgrades skipped to parsed when revision finds a trade', async () => {
    let patch: Record<string, unknown> | null = null
    const supabase = {
      from: () => ({
        update: (p: Record<string, unknown>) => {
          patch = p
          return {
            eq: () => ({
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
      rawMessage: 'SELL XAUUSD 4115-4125\nSL 4130\nTP1 4112',
      parseResult: {
        ...parsedPatch,
        parsed: {
          ...parsedPatch.parsed,
          action: 'sell',
          raw_instruction: 'SELL XAUUSD 4115-4125\nSL 4130\nTP1 4112',
        },
      },
      existingStatus: 'skipped',
    })
    assert.equal(ok, true)
    const appliedPatch = patch as Record<string, unknown> | null
    assert.equal(appliedPatch?.status, 'parsed')
    assert.equal(appliedPatch?.skip_reason, null)
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

  it('rejects buy/sell revisions that label an entry the parser missed (forces AI)', () => {
    const INCIDENT_RAW = 'BUY: XAU/USD\nENTRY ZONE: 4358\nSL: 4348\nTP1: 4368'
    // Message labels "ENTRY ZONE" but the parse has no anchor → must go to the AI
    assert.equal(
      revisionHasDeterministicActionableParse(
        { action: 'buy', sl: null, tp: [] },
        {
          action: 'buy',
          sl: 4348,
          tp: [4368, 4378, 4388],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
          raw_instruction: INCIDENT_RAW,
        },
      ),
      false,
    )
    // Same message but the parser DID read the anchor → accepted deterministically
    assert.equal(
      revisionHasDeterministicActionableParse(
        { action: 'buy', sl: null, tp: [] },
        {
          action: 'buy',
          sl: 4348,
          tp: [4368, 4378, 4388],
          entry_price: 4358,
          entry_zone_low: null,
          entry_zone_high: null,
          raw_instruction: INCIDENT_RAW,
        },
      ),
      true,
    )
    // Market entry with no entry label → accepted deterministically (SIGNALS PRO flow)
    assert.equal(
      revisionHasDeterministicActionableParse(
        { action: 'buy', sl: null, tp: [] },
        {
          action: 'buy',
          sl: 4190,
          tp: [4210, 4220],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
          raw_instruction: 'Gold buy now\nSL: 4190\nTP: 4210',
        },
      ),
      true,
    )
    // Completes-settleable path is also blocked when the entry label was missed
    assert.equal(
      revisionCompletesSettleableEntry(
        { action: 'buy', sl: null, tp: [], entry_price: null },
        {
          action: 'buy',
          sl: 4348,
          tp: [4368],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
          raw_instruction: INCIDENT_RAW,
        },
      ),
      false,
    )
    // A modify revision is blocked too when the entry label was missed
    assert.equal(
      revisionHasDeterministicActionableParse(
        { action: 'buy', sl: 2650, tp: [2670] },
        {
          action: 'modify',
          sl: 4348,
          tp: [4368],
          entry_price: null,
          entry_zone_low: null,
          entry_zone_high: null,
          raw_instruction: INCIDENT_RAW,
        },
      ),
      false,
    )
  })
})
