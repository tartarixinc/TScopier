import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  explicitMgmtSymbol,
  filterTradesByPlausibleMgmtLevels,
  filterTradesBySymbolFilter,
  findRecentEntrySignalByProviderNumber,
  isReplyScopedManagement,
  loadOpenTradesForManagement,
  loadOpenTradesForSignalAcrossBrokers,
  resolveEntrySignalIdByProviderNumber,
  resolveChannelCweTargets,
  resolveChannelModifyTargets,
  resolveNewestOpenSymbolTrades,
  type MgmtTradeRow,
} from './managementScope'
import type { SupabaseClient } from '@supabase/supabase-js'

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

  it('applies plausible SL across all gold baskets when a newer other-symbol leg exists', () => {
    const trades = [
      row({
        id: 'g1',
        broker_account_id: 'broker-a',
        signal_id: 'entry-old',
        symbol: 'XAUUSD',
        direction: 'buy',
        entry_price: 4220,
        opened_at: '2026-01-01T10:00:00Z',
      }),
      row({
        id: 'g2',
        broker_account_id: 'broker-b',
        signal_id: 'entry-old',
        symbol: 'XAUUSD',
        direction: 'buy',
        entry_price: 4218,
        opened_at: '2026-01-01T10:05:00Z',
      }),
      row({
        id: 'g3',
        broker_account_id: 'broker-c',
        signal_id: 'entry-new',
        symbol: 'XAUUSD',
        direction: 'buy',
        entry_price: 4215,
        opened_at: '2026-01-01T12:30:00Z',
      }),
      row({
        id: 'e',
        symbol: 'EURUSD',
        direction: 'buy',
        entry_price: 1.1,
        opened_at: '2026-01-01T12:00:00Z',
      }),
    ]
    const out = resolveChannelModifyTargets(trades, { action: 'modify', sl: 4199, tp: [] })
    assert.equal(out.length, 3)
    assert.ok(out.some(t => t.id === 'g1'))
    assert.ok(out.some(t => t.id === 'g2'))
    assert.ok(out.some(t => t.id === 'g3'))
    assert.equal(out.some(t => t.id === 'e'), false)
  })

  it('applies plausible SL within newest symbol basket when only that bucket matches', () => {
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

type FakeTrade = MgmtTradeRow & { telegram_channel_id?: string }

/**
 * Minimal Supabase stub that honours `.limit()` (so we can prove the per-broker
 * scope avoids the shared row-cap truncation) and filters trades by the
 * `broker_account_id` IN list and `signal_id` eq.
 */
function makeSupabase(opts: {
  channelSignalIds?: string[]
  tradesByBroker: Record<string, FakeTrade[]>
  attributions?: Array<{ trade_id: string; broker_account_id: string }>
}) {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {}
      const ins: Record<string, unknown[]> = {}
      let limitN = Infinity
      const resolve = () => {
        let data: unknown[] = []
        if (table === 'signals') {
          data = (opts.channelSignalIds ?? []).map(id => ({ id }))
        } else if (table === 'trade_channel_attributions') {
          data = opts.attributions ?? []
        } else if (table === 'trades') {
          const brokerIds = (ins.broker_account_id as string[] | undefined)
            ?? Object.keys(opts.tradesByBroker)
          let rows = brokerIds.flatMap(id => opts.tradesByBroker[id] ?? [])
          const sigId = eqs.signal_id as string | undefined
          if (sigId) rows = rows.filter(r => r.signal_id === sigId)
          rows = rows.slice(0, limitN)
          data = rows
        }
        return Promise.resolve({ data, error: null, count: data.length })
      }
      const chain: Record<string, unknown> = {
        select() { return chain },
        eq(col: string, val: unknown) { eqs[col] = val; return chain },
        in(col: string, vals: unknown[]) { ins[col] = vals; return chain },
        not() { return chain },
        order() { return chain },
        limit(n: number) { limitN = n; return resolve() },
        maybeSingle() { return resolve() },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          return resolve().then(onF, onR)
        },
      }
      return chain
    },
  }
}

function leg(brokerId: string, signalId: string, n: number): FakeTrade {
  return {
    id: `${brokerId}-${signalId}-${n}`,
    signal_id: signalId,
    broker_account_id: brokerId,
    metaapi_order_id: String(1000 + n),
    symbol: 'XAUUSD',
    direction: 'buy',
    lot_size: 0.1,
    status: 'open',
    sl: null,
    tp: null,
    entry_price: 2650,
    opened_at: `2026-01-01T10:${String(n).padStart(2, '0')}:00.000Z`,
    telegram_channel_id: 'ch-1',
  }
}

describe('loadOpenTradesForSignalAcrossBrokers', () => {
  it('returns all 12 brokers for one signal and flags the missing broker', async () => {
    const brokers = Array.from({ length: 12 }, (_, i) => `b${i + 1}`)
    const tradesByBroker: Record<string, FakeTrade[]> = {}
    for (const b of brokers) tradesByBroker[b] = [leg(b, 'sig-1', 1)]
    const supabase = makeSupabase({ tradesByBroker })

    const out = await loadOpenTradesForSignalAcrossBrokers(supabase as never, {
      userId: 'u1',
      signalId: 'sig-1',
      brokerAccountIds: [...brokers, 'b13'],
    })
    assert.equal(out.rows.length, 12)
    assert.equal(out.brokersFound.length, 12)
    assert.deepEqual(out.brokersMissing, ['b13'])
  })

  it('returns all missing when signalId is empty', async () => {
    const out = await loadOpenTradesForSignalAcrossBrokers({} as never, {
      userId: 'u1',
      signalId: '',
      brokerAccountIds: ['b1', 'b2'],
    })
    assert.equal(out.rows.length, 0)
    assert.deepEqual(out.brokersMissing, ['b1', 'b2'])
  })
})

describe('loadOpenTradesForManagement multi-broker scope', () => {
  it('does not truncate 12 brokers × 50 legs against a shared 500 row cap', async () => {
    const brokers = Array.from({ length: 12 }, (_, i) => `b${i + 1}`)
    const tradesByBroker: Record<string, FakeTrade[]> = {}
    for (const b of brokers) {
      tradesByBroker[b] = Array.from({ length: 50 }, (_, n) => leg(b, `sig-${b}`, n))
    }
    const supabase = makeSupabase({ tradesByBroker })

    const rows = await loadOpenTradesForManagement(supabase as never, {
      userId: 'u1',
      channelId: 'ch-1',
      brokerAccountIds: brokers,
    })
    assert.equal(rows.length, 600)
    const distinctBrokers = new Set(rows.map(r => r.broker_account_id))
    assert.equal(distinctBrokers.size, 12)
  })
})

describe('findRecentEntrySignalByProviderNumber', () => {
  function makeDedupSupabase(rows: Array<Record<string, unknown>>) {
    return {
      from() {
        return {
          select() {
            const chain = {
              eq() { return chain },
              gte() { return chain },
              order() { return chain },
              limit() { return Promise.resolve({ data: rows }) },
            }
            return chain
          },
        }
      },
    } as unknown as SupabaseClient
  }

  it('returns a prior entry for the same provider signal number and symbol', async () => {
    const supabase = makeDedupSupabase([
      {
        id: 'prior-sig',
        telegram_message_id: '2920',
        parsed_data: { action: 'buy', symbol: 'XPTUSD', provider_signal_number: 900 },
        raw_message: 'New Signal #900',
        status: 'executed',
        created_at: new Date().toISOString(),
      },
    ])

    const dup = await findRecentEntrySignalByProviderNumber(supabase, {
      userId: 'u1',
      channelId: 'ch1',
      providerSignalNumber: 900,
      symbol: 'XPTUSD',
      excludeTelegramMessageId: '2925',
    })
    assert.equal(dup?.id, 'prior-sig')
    assert.equal(dup?.telegram_message_id, '2920')
  })

  it('returns null when only the excluded telegram message matches', async () => {
    const supabase = makeDedupSupabase([
      {
        id: 'same-msg',
        telegram_message_id: '2925',
        parsed_data: { action: 'buy', symbol: 'XPTUSD', provider_signal_number: 900 },
        raw_message: 'New Signal #900',
        status: 'executed',
        created_at: new Date().toISOString(),
      },
    ])

    const dup = await findRecentEntrySignalByProviderNumber(supabase, {
      userId: 'u1',
      channelId: 'ch1',
      providerSignalNumber: 900,
      symbol: 'XPTUSD',
      excludeTelegramMessageId: '2925',
    })
    assert.equal(dup, null)
  })
})

describe('resolveEntrySignalIdByProviderNumber', () => {
  function supabaseFor(rows: Array<Record<string, unknown>>) {
    return {
      from() {
        return {
          select() {
            const chain = {
              eq() { return chain },
              order() { return chain },
              limit() { return Promise.resolve({ data: rows }) },
            }
            return chain
          },
        }
      },
    } as unknown as SupabaseClient
  }

  it('resolves a Dewa provider ID from parsed metadata', async () => {
    const id = await resolveEntrySignalIdByProviderNumber(supabaseFor([{
      id: 'entry-719910668',
      parsed_data: { action: 'buy', provider_signal_number: 719910668 },
      raw_message: 'Type : New Order\nID : 719910668',
    }]), {
      userId: 'u1',
      channelId: 'ch1',
      providerSignalNumber: 719910668,
    })
    assert.equal(id, 'entry-719910668')
  })

  it('fails closed when a provider ID correlates to multiple entry signals', async () => {
    const id = await resolveEntrySignalIdByProviderNumber(supabaseFor([
      { id: 'entry-a', parsed_data: { action: 'buy', provider_signal_number: 719910668 } },
      { id: 'entry-b', parsed_data: { action: 'buy', provider_signal_number: 719910668 } },
    ]), {
      userId: 'u1',
      channelId: 'ch1',
      providerSignalNumber: 719910668,
    })
    assert.equal(id, null)
  })

  it('does not correlate a different provider ID', async () => {
    const id = await resolveEntrySignalIdByProviderNumber(supabaseFor([{
      id: 'entry-other',
      parsed_data: { action: 'buy', provider_signal_number: 719910669 },
    }]), {
      userId: 'u1',
      channelId: 'ch1',
      providerSignalNumber: 719910668,
    })
    assert.equal(id, null)
  })
})
