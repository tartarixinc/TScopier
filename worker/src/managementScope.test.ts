import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  explicitMgmtSymbol,
  filterTradesByPlausibleMgmtLevels,
  filterTradesBySymbolFilter,
  isReplyScopedManagement,
  resolveChannelModifyTargets,
  resolveNewestOpenSymbolTrades,
  type MgmtTradeRow,
} from './managementScope'

function row(partial: Partial<MgmtTradeRow> & Pick<MgmtTradeRow, 'id' | 'symbol' | 'direction'>): MgmtTradeRow {
  return {
    signal_id: partial.signal_id ?? 'sig-1',
    broker_account_id: partial.broker_account_id ?? 'broker-1',
    metaapi_order_id: partial.metaapi_order_id ?? '1001',
    lot_size: partial.lot_size ?? 0.1,
    status: 'open',
    sl: partial.sl ?? null,
    tp: partial.tp ?? null,
    entry_price: partial.entry_price ?? 1.1,
    opened_at: partial.opened_at ?? '2026-01-01T12:00:00.000Z',
    ...partial,
  }
}

describe('isReplyScopedManagement', () => {
  it('true when reply_to_message_id is set', () => {
    assert.equal(isReplyScopedManagement({ reply_to_message_id: '42' }), true)
  })
  it('false for channel broadcast', () => {
    assert.equal(isReplyScopedManagement({ reply_to_message_id: null }), false)
    assert.equal(isReplyScopedManagement({}), false)
  })
})

describe('filterTradesBySymbolFilter', () => {
  const trades = [
    row({ id: '1', symbol: 'XAUUSD', direction: 'buy', entry_price: 2650 }),
    row({ id: '2', symbol: 'EURUSD', direction: 'buy', entry_price: 1.1 }),
  ]

  it('returns all when no filter', () => {
    assert.equal(filterTradesBySymbolFilter(trades, null).length, 2)
  })

  it('filters to compatible symbol', () => {
    const eur = filterTradesBySymbolFilter(trades, 'EURUSD')
    assert.equal(eur.length, 1)
    assert.equal(eur[0]!.id, '2')
  })
})

describe('filterTradesByPlausibleMgmtLevels', () => {
  it('accepts SL 4470 for XAUUSD buy, rejects for EURUSD buy', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy', entry_price: 4500, opened_at: '2026-01-01T10:00:00Z' }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy', entry_price: 1.1, opened_at: '2026-01-01T11:00:00Z' }),
    ]
    const parsed = { action: 'modify', sl: 4470, tp: [] as number[] }
    const matched = filterTradesByPlausibleMgmtLevels(trades, parsed)
    assert.ok(matched.some(t => t.id === 'g'))
    assert.equal(matched.some(t => t.id === 'e'), false)
  })
})

describe('resolveNewestOpenSymbolTrades', () => {
  it('picks symbol of newest opened leg', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy', opened_at: '2026-01-01T10:00:00Z' }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy', opened_at: '2026-01-01T12:00:00Z' }),
    ]
    const out = resolveNewestOpenSymbolTrades(trades)
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'e')
  })
})

describe('resolveChannelModifyTargets', () => {
  it('uses plausibility when possible', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy', entry_price: 4500 }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy', entry_price: 1.1 }),
    ]
    const out = resolveChannelModifyTargets(trades, { action: 'modify', sl: 4470, tp: [] })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'g')
  })

  it('falls back to newest symbol when no level matches', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy', entry_price: 4500, opened_at: '2026-01-01T12:00:00Z' }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy', entry_price: 1.1, opened_at: '2026-01-01T10:00:00Z' }),
    ]
    const out = resolveChannelModifyTargets(trades, { action: 'modify', sl: 1.05, tp: [] })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'g')
  })
})

describe('explicitMgmtSymbol', () => {
  it('sanitizes parsed symbol', () => {
    assert.equal(explicitMgmtSymbol({ symbol: 'eurusd' }), 'EURUSD')
    assert.equal(explicitMgmtSymbol({ symbol: 'CHANGE' }), null)
  })
})
