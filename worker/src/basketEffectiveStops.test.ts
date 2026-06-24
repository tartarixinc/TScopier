import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeWithProtectiveLegSl,
  mostProtectiveOpenLegSl,
  resolveEffectiveBasketStops,
  resolveEffectiveStoplossPriority,
  unanimousLegSl,
  isSlMoreProtective,
} from './basketEffectiveStops'
import type { BasketOpenLeg } from './basketSlTpReconcile'

function mockSupabase(dataByTable: Record<string, unknown[]>) {
  function builder(table: string) {
    const b: Record<string, unknown> = {}
    const self = () => b
    b.select = self
    b.eq = self
    b.in = self
    b.gte = self
    b.order = self
    b.limit = () => Promise.resolve({ data: dataByTable[table] ?? [], error: null })
    return b
  }
  return { from: (t: string) => builder(t) }
}

function leg(sl: number | null): BasketOpenLeg {
  return {
    id: 't1',
    signal_id: 'sig',
    metaapi_order_id: '1',
    opened_at: '2026-06-17T11:00:00Z',
    lot_size: 0.01,
    sl,
    tp: 4265,
    entry_price: 4255,
    direction: 'buy',
    symbol: 'XAUUSD',
  }
}

describe('resolveEffectiveStoplossPriority', () => {
  it('prefers mgmt signal SL over anchor and channel', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: 4242,
      channelSl: 4240,
      legConsensus: null,
    })
    assert.equal(r.stoploss, 4242)
    assert.equal(r.source, 'mgmt_signal')
  })

  it('uses channel memory when no mgmt signal', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: null,
      channelSl: 4242,
      legConsensus: null,
    })
    assert.equal(r.stoploss, 4242)
    assert.equal(r.source, 'channel_memory')
  })

  it('keeps anchor when channel is stale and no mgmt', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: null,
      channelSl: null,
      legConsensus: null,
    })
    assert.equal(r.stoploss, 4245)
    assert.equal(r.source, 'anchor')
  })

  it('uses leg consensus when channel write failed but legs agree on adjusted SL', () => {
    const r = resolveEffectiveStoplossPriority({
      anchorSl: 4245,
      mgmtSl: null,
      channelSl: null,
      legConsensus: 4242,
    })
    assert.equal(r.stoploss, 4242)
    assert.equal(r.source, 'leg_consensus')
  })
})

describe('unanimousLegSl', () => {
  it('returns shared SL when all legs match', () => {
    assert.equal(unanimousLegSl([leg(4242), leg(4242)]), 4242)
  })

  it('returns null when legs disagree', () => {
    assert.equal(unanimousLegSl([leg(4242), leg(4245)]), null)
  })
})

describe('mostProtectiveOpenLegSl', () => {
  it('returns highest SL for buy legs', () => {
    assert.equal(mostProtectiveOpenLegSl([leg(4242), leg(4248)], true), 4248)
  })

  it('returns lowest SL for sell legs', () => {
    const sellLeg = { ...leg(4248), direction: 'sell' as const }
    const sellLeg2 = { ...leg(4242), direction: 'sell' as const }
    assert.equal(mostProtectiveOpenLegSl([sellLeg, sellLeg2], false), 4242)
  })
})

describe('mergeWithProtectiveLegSl', () => {
  it('keeps tighter leg SL over anchor for buys', () => {
    assert.equal(mergeWithProtectiveLegSl(4245, 4248, true), 4248)
  })
})

describe('isSlMoreProtective', () => {
  it('detects buy leg SL above target', () => {
    assert.equal(isSlMoreProtective(4248, 4245, true), true)
    assert.equal(isSlMoreProtective(4245, 4248, true), false)
  })
})

describe('resolveEffectiveBasketStops explicit-adjustment wins', () => {
  it('a loosening mgmt adjust is NOT overridden by a tighter open-leg SL', async () => {
    const supabase = mockSupabase({
      signals: [
        { id: 'mod-1', parsed_data: { action: 'modify', sl: 4155, symbol: null }, created_at: '2026-06-17T12:00:00Z' },
      ],
      channel_active_trade_params: [],
    })
    const eff = await resolveEffectiveBasketStops({
      supabase: supabase as never,
      userId: 'u',
      channelId: 'c',
      anchorSignalId: 'sig',
      symbol: 'XAUUSD',
      basketCreatedAt: '2026-06-17T11:00:00Z',
      anchorParsed: { sl: 4100, tp: [4265] },
      familyTrades: [leg(4258), leg(4258)],
    })
    assert.equal(eff.source, 'mgmt_signal')
    assert.equal(eff.stoploss, 4155, 'explicit channel adjust wins, not the tighter 4258 leg SL')
  })

  it('non-mgmt source (channel memory) still merges the most-protective leg SL', async () => {
    const supabase = mockSupabase({
      signals: [],
      channel_active_trade_params: [
        { symbol: 'XAUUSD', stoploss: 4150, tp_levels: [4265], updated_at: '2026-06-17T12:00:00Z' },
      ],
    })
    const eff = await resolveEffectiveBasketStops({
      supabase: supabase as never,
      userId: 'u',
      channelId: 'c',
      anchorSignalId: 'sig',
      symbol: 'XAUUSD',
      basketCreatedAt: '2026-06-17T11:00:00Z',
      anchorParsed: { sl: 4100, tp: [4265] },
      familyTrades: [leg(4258), leg(4258)],
    })
    assert.equal(eff.source, 'channel_memory')
    assert.equal(eff.stoploss, 4258, 'protective merge still applies for non-explicit sources')
  })
})
