import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  explicitMgmtSymbol,
  filterTradesByPlausibleMgmtLevels,
  filterTradesBySymbolFilter,
  isReplyScopedManagement,
  resolveChannelCweTargets,
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

describe('resolveChannelCweTargets', () => {
  it('scopes symbol-less channel CWE to newest open symbol', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy', opened_at: '2026-01-01T10:00:00Z' }),
      row({ id: 'b1', symbol: 'BTCUSD', direction: 'sell', opened_at: '2026-01-01T12:00:00Z' }),
      row({ id: 'b2', symbol: 'BTCUSD', direction: 'sell', opened_at: '2026-01-01T12:01:00Z' }),
    ]
    const out = resolveChannelCweTargets(trades, null)
    assert.equal(out.length, 2)
    assert.ok(out.every(t => t.symbol === 'BTCUSD'))
  })

  it('keeps explicit symbol filter', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy' }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy' }),
    ]
    const out = resolveChannelCweTargets(trades, 'XAUUSD')
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'g')
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
  it('scopes symbol-less modify to newest symbol then plausibility', () => {
    const trades = [
      row({ id: 'g', symbol: 'XAUUSD', direction: 'buy', entry_price: 4500, opened_at: '2026-01-01T10:00:00Z' }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy', entry_price: 1.1, opened_at: '2026-01-01T12:00:00Z' }),
    ]
    const out = resolveChannelModifyTargets(trades, { action: 'modify', sl: 1.05, tp: [] })
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'e')
  })

  it('applies plausible SL within newest symbol basket', () => {
    const trades = [
      row({ id: 'g1', symbol: 'XAUUSD', direction: 'buy', entry_price: 4500, opened_at: '2026-01-01T12:00:00Z' }),
      row({ id: 'g2', symbol: 'XAUUSD', direction: 'buy', entry_price: 4510, opened_at: '2026-01-01T12:01:00Z' }),
      row({ id: 'e', symbol: 'EURUSD', direction: 'buy', entry_price: 1.1, opened_at: '2026-01-01T10:00:00Z' }),
    ]
    const out = resolveChannelModifyTargets(trades, { action: 'modify', sl: 4470, tp: [] })
    assert.equal(out.length, 2)
    assert.ok(out.some(t => t.id === 'g1'))
    assert.ok(out.some(t => t.id === 'g2'))
    assert.equal(out.some(t => t.id === 'e'), false)
  })
})

describe('explicitMgmtSymbol', () => {
  it('sanitizes parsed symbol', () => {
    assert.equal(explicitMgmtSymbol({ symbol: 'eurusd' }), 'EURUSD')
    assert.equal(explicitMgmtSymbol({ symbol: 'CHANGE' }), null)
  })
})
