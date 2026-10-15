import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureSignalRow } from '../ensureSignalRow'
import { DEFAULT_CHANNEL_KEYWORDS, parseChannelMessageSync } from '../parseSignal'
import { normalizeManualSettingsForExecution } from '../manualPlanning/normalizeManualSettings'
import { planManualOrders } from '../manualPlanner'
import {
  isUnlinkedCompleteEntryMerge,
  tryMergeSignalIntoExistingOpenTrade,
  tryParameterFollowUpMergeModifyOnly,
} from './basketMerge/mergeRouting'
import type { BasketMergeLinkContext } from '../signalMergeLink'
import type { BrokerRow, ParsedSignal, SignalRow } from './types'

const signal3Text = `GOLD BUY SETUP
Gold Buy Zone 4438 - 4433
SL : 4528
TP1 : 4443
TP2 : 4448
TP3 : 4453
TP4 : Hold`

const signal4Text = `GOLD BUY SETUP
Gold Buy Zone 4441 - 4436
SL : 4531
TP1 : 4446
TP2 : 4451
TP3 : 4456
TP4 : Hold`

const created3 = '2026-09-01T10:00:00.000Z'
const created4 = '2026-09-01T10:08:00.000Z'

const liveSignalAText = `GOLD BUY SETUP
Gold Buy Zone 4315 - 4313
SL : 4306
TP1 : 4319
TP2 : 4323
TP3 : 4327
TP4 : Hold`

const liveSignalBText = `GOLD BUY SETUP
Gold Buy Zone 4317 - 4314
SL : 4308
TP1 : 4321
TP2 : 4325
TP3 : 4329
TP4 : Hold`

type SignalStoreRow = SignalRow & {
  raw_message?: string
}

type TradeStoreRow = {
  id: string
  signal_id: string
  metaapi_order_id: number
  opened_at: string
  lot_size: number
  sl: number
  tp: number
  entry_price: number
  direction: 'buy' | 'sell'
  symbol: string
  broker_account_id: string
  user_id: string
  status: string
}

class QueryMock {
  private filters = new Map<string, unknown>()
  private inFilters = new Map<string, unknown[]>()
  private orderBy: { column: string; ascending: boolean } | null = null
  private rowLimit: number | null = null

  constructor(
    private readonly table: string,
    private readonly state: {
      signals: Map<string, SignalStoreRow>
      trades: TradeStoreRow[]
      upserts: Record<string, unknown>[]
    },
  ) {}

  select(): this {
    return this
  }

  eq(column: string, value: unknown): this {
    this.filters.set(column, value)
    return this
  }

  in(column: string, value: unknown[]): this {
    this.inFilters.set(column, value)
    return this
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { column, ascending: opts?.ascending !== false }
    return this
  }

  limit(value: number): this {
    this.rowLimit = value
    return this
  }

  async upsert(payload: Record<string, unknown>): Promise<{ error: null }> {
    this.state.upserts.push({ table: this.table, ...payload })
    if (this.table === 'signals') {
      const id = String(payload.id)
      this.state.signals.set(id, {
        id,
        user_id: String(payload.user_id),
        channel_id: payload.channel_id == null ? null : String(payload.channel_id),
        status: String(payload.status ?? 'parsed'),
        parsed_data: (payload.parsed_data as ParsedSignal | null) ?? null,
        parent_signal_id: payload.parent_signal_id == null ? null : String(payload.parent_signal_id),
        is_modification: payload.is_modification === true,
        telegram_message_id: payload.telegram_message_id == null ? null : String(payload.telegram_message_id),
        reply_to_message_id: payload.reply_to_message_id == null ? null : String(payload.reply_to_message_id),
        created_at: String(payload.created_at ?? new Date().toISOString()),
        raw_message: payload.raw_message == null ? '' : String(payload.raw_message),
      })
    }
    return { error: null }
  }

  async insert(payload: Record<string, unknown>): Promise<{ error: null }> {
    this.state.upserts.push({ table: this.table, ...payload })
    return { error: null }
  }

  async maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
    const rows = this.rows()
    return { data: (rows[0] as Record<string, unknown> | undefined) ?? null, error: null }
  }

  then<TResult1 = { data: unknown[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[]; error: null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows(), error: null, count: this.rows().length }).then(onfulfilled, onrejected)
  }

  private rows(): unknown[] {
    let rows: unknown[] = []
    if (this.table === 'signals') rows = [...this.state.signals.values()]
    if (this.table === 'trades') rows = [...this.state.trades]

    rows = rows.filter(row => {
      const rec = row as Record<string, unknown>
      for (const [column, value] of this.filters) {
        if (rec[column] !== value) return false
      }
      for (const [column, values] of this.inFilters) {
        if (!values.includes(rec[column])) return false
      }
      return true
    })

    if (this.orderBy) {
      const { column, ascending } = this.orderBy
      rows = [...rows].sort((a, b) => {
        const av = (a as Record<string, unknown>)[column]
        const bv = (b as Record<string, unknown>)[column]
        const at = typeof av === 'string' ? Date.parse(av) : Number(av)
        const bt = typeof bv === 'string' ? Date.parse(bv) : Number(bv)
        const delta = (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0)
        return ascending ? delta : -delta
      })
    }
    return this.rowLimit == null ? rows : rows.slice(0, this.rowLimit)
  }
}

function makeSupabase() {
  const state = {
    signals: new Map<string, SignalStoreRow>(),
    trades: [] as TradeStoreRow[],
    upserts: [] as Record<string, unknown>[],
  }
  return {
    state,
    client: {
      from(table: string) {
        return new QueryMock(table, state)
      },
    },
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key]
  else process.env[key] = value
}

function mustParse(text: string): ParsedSignal {
  const result = parseChannelMessageSync(text, DEFAULT_CHANNEL_KEYWORDS, null)
  assert.equal(result.status, 'parsed')
  return result.parsed as ParsedSignal
}

function makeSignal(id: string, telegramMessageId: string, raw: string, parsed: ParsedSignal, createdAt: string): SignalRow {
  return {
    id,
    user_id: 'user-stefan',
    channel_id: 'channel-gold',
    parsed_data: parsed,
    status: 'parsed',
    parent_signal_id: null,
    is_modification: false,
    telegram_message_id: telegramMessageId,
    reply_to_message_id: null,
    created_at: createdAt,
    raw_message: raw,
  } as SignalRow
}

const broker: BrokerRow = {
  id: 'broker-stefan',
  user_id: 'user-stefan',
  is_active: true,
  platform: 'MT5',
  connection_status: 'connected',
  fxsocket_account_id: 'fx-stefan',
  metaapi_account_id: 'fx-stefan',
  account_login: null,
  broker_server: null,
  copier_mode: 'manual',
  signal_channel_ids: ['channel-gold'],
  enforce_signal_channel_filter: true,
  ai_settings: {},
  manual_settings: normalizeManualSettingsForExecution({
    trade_style: 'single',
    fixed_lot: 0.01,
    add_new_trades_to_existing: true,
    close_on_opposite_signal: false,
    range_trading: false,
    use_signal_entry_price: false,
  }) as unknown as Record<string, unknown>,
  default_lot_size: 0.01,
  last_balance: 10_000,
  last_equity: 10_000,
  last_currency: 'USD',
  channel_message_filters: null,
  channel_trading_configs: null,
}

test('Stefan local behavior: second complete GOLD BUY keeps separate signal identity and routes to new entry intent', async () => {
  const oldFxKey = process.env.FXSOCKET_API_KEY
  process.env.FXSOCKET_API_KEY = process.env.FXSOCKET_API_KEY || 'test-only'

  try {
    const parsed3 = mustParse(signal3Text)
    const parsed4 = mustParse(signal4Text)
    const signal3 = makeSignal('signal-3', 'tg-signal-3', signal3Text, parsed3, created3)
    const signal4 = makeSignal('signal-4', 'tg-signal-4', signal4Text, parsed4, created4)
    const supabase = makeSupabase()

    await ensureSignalRow(supabase.client as never, signal3 as never)
    await ensureSignalRow(supabase.client as never, signal4 as never)
    assert.equal(supabase.state.signals.get('signal-3')?.telegram_message_id, 'tg-signal-3')
    assert.equal(supabase.state.signals.get('signal-4')?.telegram_message_id, 'tg-signal-4')

    supabase.state.trades.push({
      id: 'trade-signal-3',
      signal_id: 'signal-3',
      metaapi_order_id: 3003,
      opened_at: '2026-09-01T10:01:00.000Z',
      lot_size: 0.01,
      sl: 4528,
      tp: 4443,
      entry_price: 4438,
      direction: 'buy',
      symbol: 'XAUUSD',
      broker_account_id: broker.id,
      user_id: 'user-stefan',
      status: 'open',
    })

    const api = {
      openedOrders: async () => [{ ticket: 3003 }],
      quote: async () => ({ bid: 4437, ask: 4437.2 }),
    }
    const ctx = {
      supabase: supabase.client,
      apiFor: () => api,
      parentSignalIdChainContainsAnchor: async () => false,
    }

    const mergeOutcome = await tryMergeSignalIntoExistingOpenTrade(ctx as never, {
      signal: signal4,
      parsed: parsed4,
      op: 'Buy',
      broker,
      channelKeywords: DEFAULT_CHANNEL_KEYWORDS,
      baseLot: 0.01,
      params: {
        point: 0.01,
        digits: 2,
        minLot: 0.01,
        maxLot: 100,
        lotStep: 0.01,
        contractSize: 100,
        stopsLevel: 0,
        freezeLevel: 0,
        loadedAt: Date.now(),
      },
      symbol: 'XAUUSD',
      uuid: 'fx-stefan',
      strictEntryPrefetch: null,
      commentPrefix: 'TScopier:stefan-s4',
    })

    assert.deepEqual(mergeOutcome, { handled: false })

    const plan = planManualOrders({
      parsed: parsed4,
      resolvedSymbol: 'XAUUSD',
      baseOperation: 'Buy',
      manual: broker.manual_settings as never,
      channelKeywords: DEFAULT_CHANNEL_KEYWORDS,
      manualLot: 0.01,
      ctx: {
        point: 0.01,
        digits: 2,
        minLot: 0.01,
        lotStep: 0.01,
        contractSize: 100,
        stopsLevel: 0,
        freezeLevel: 0,
        defaultLot: 0.01,
        lastBalance: 10_000,
        liveBid: 4437,
        liveAsk: 4437.2,
      },
      commentPrefix: 'TScopier:stefan-s4',
      expertId: 909090,
      slippage: 20,
    })

    assert.equal(plan.skip_reason, undefined)
    assert.equal(plan.orders.length, 1)
    assert.equal(plan.orders[0]?.symbol, 'XAUUSD')
    assert.equal(plan.orders[0]?.operation, 'Buy')
    assert.equal(supabase.state.trades.filter(t => t.signal_id === 'signal-3').length, 1)
    assert.equal(supabase.state.trades.filter(t => t.signal_id === 'signal-4').length, 0)
  } finally {
    restoreEnv('FXSOCKET_API_KEY', oldFxKey)
  }
})

test('Stefan live shape: second complete GOLD BUY does not enter modify-only SL/TP refresh', async () => {
  const oldFxKey = process.env.FXSOCKET_API_KEY
  process.env.FXSOCKET_API_KEY = process.env.FXSOCKET_API_KEY || 'test-only'

  try {
    const parsedA = mustParse(liveSignalAText)
    const parsedBDeterministic = mustParse(liveSignalBText)
    assert.equal(parsedBDeterministic.entry_zone_low, 4314)
    assert.equal(parsedBDeterministic.entry_zone_high, 4317)
    const parsedB = {
      ...parsedBDeterministic,
      entry_price: null,
      entry_zone_low: null,
      entry_zone_high: null,
      raw_instruction: '',
      _intent: {
        kind: 'entry',
        side: 'BUY',
        symbol: 'XAUUSD',
        entry: [4314, 4317],
        sl: 4308,
        tp: [4321, 4325, 4329],
        sl_unit: 'price',
        tp_unit: 'price',
        flags: { market_now: false },
        confidence: 0.86,
      },
    } as ParsedSignal
    const signalA = makeSignal('live-signal-a', 'tg-live-a', liveSignalAText, parsedA, '2026-09-02T02:17:00.000Z')
    const signalB = makeSignal('live-signal-b', 'tg-live-b', liveSignalBText, parsedB, '2026-09-02T02:18:00.000Z')
    const supabase = makeSupabase()

    await ensureSignalRow(supabase.client as never, signalA as never)
    await ensureSignalRow(supabase.client as never, signalB as never)
    supabase.state.trades.push({
      id: 'trade-live-a',
      signal_id: 'live-signal-a',
      metaapi_order_id: 431593,
      opened_at: '2026-09-02T02:17:30.000Z',
      lot_size: 0.01,
      sl: 4306,
      tp: 4319,
      entry_price: 4325.93,
      direction: 'buy',
      symbol: 'XAUUSD',
      broker_account_id: broker.id,
      user_id: 'user-stefan',
      status: 'open',
    })

    const api = {
      openedOrders: async () => [{ ticket: 431593 }],
      quote: async () => ({ bid: 4325.8, ask: 4325.93 }),
      orderModify: async () => {
        throw new Error('modify-only path must not be reached for a complete unlinked entry')
      },
    }
    const ctx = {
      supabase: supabase.client,
      apiFor: () => api,
      parentSignalIdChainContainsAnchor: async () => false,
    }

    const paramOutcome = await tryParameterFollowUpMergeModifyOnly(ctx as never, {
      signal: signalB,
      parsed: parsedB,
      broker,
      channelKeywords: DEFAULT_CHANNEL_KEYWORDS,
      baseLot: 0.01,
      params: {
        point: 0.01,
        digits: 2,
        minLot: 0.01,
        maxLot: 100,
        lotStep: 0.01,
        contractSize: 100,
        stopsLevel: 0,
        freezeLevel: 0,
        loadedAt: Date.now(),
      },
      symbol: 'XAUUSD',
      uuid: 'fx-stefan',
      strictEntryPrefetch: null,
      commentPrefix: 'TScopier:live-signal-b',
    })

    assert.deepEqual(paramOutcome, { handled: false })

    const plan = planManualOrders({
      parsed: parsedB,
      resolvedSymbol: 'XAUUSD',
      baseOperation: 'Buy',
      manual: broker.manual_settings as never,
      channelKeywords: DEFAULT_CHANNEL_KEYWORDS,
      manualLot: 0.01,
      ctx: {
        point: 0.01,
        digits: 2,
        minLot: 0.01,
        lotStep: 0.01,
        contractSize: 100,
        stopsLevel: 0,
        freezeLevel: 0,
        defaultLot: 0.01,
        lastBalance: 10_000,
        liveBid: 4325.8,
        liveAsk: 4325.93,
      },
      commentPrefix: 'TScopier:live-signal-b',
      expertId: 909090,
      slippage: 20,
    })

    assert.equal(plan.skip_reason, undefined)
    assert.equal(plan.orders.length, 1)
    assert.equal(plan.orders[0]?.operation, 'Buy')
    assert.equal(supabase.state.trades.find(t => t.signal_id === 'live-signal-a')?.sl, 4306)
    assert.equal(supabase.state.trades.find(t => t.signal_id === 'live-signal-a')?.tp, 4319)
    assert.equal(supabase.state.trades.some(t => t.signal_id === 'live-signal-b'), false)
  } finally {
    restoreEnv('FXSOCKET_API_KEY', oldFxKey)
  }
})

test('Stefan local behavior: genuine management text remains management-classified', () => {
  const breakeven = mustParse('Move SL to breakeven')
  assert.equal(breakeven.action, 'breakeven')

  const partial = mustParse('TP1 hit, close half and move SL to entry')
  assert.equal(partial.action, 'partial_breakeven')
  assert.equal(partial.partial_close_fraction, 0.5)

  const close = mustParse('Close trade now')
  assert.equal(close.action, 'close')
})

test('explicit provider New Order never merges into an older same-side basket', async () => {
  const raw = `Dewa Scalper Order

Type : New Order
ID : 719910669
Date/Time : 01-10-2026 07:50
Pair : XAUUSD.vx
Order Type : Instant
Order : Buy
Lot Size : 2.00
Stop Loss : 0.00
Take Profit : 0.00`
  const parsed = mustParse(raw)
  assert.equal(parsed.provider_order_type, 'new')
  const result = await tryMergeSignalIntoExistingOpenTrade({
    apiFor: () => ({}),
    supabase: {
      from: () => {
        throw new Error('explicit New Order must return before merge lookup')
      },
    },
  } as never, {
    signal: makeSignal('dewa-719910669', 'tg-dewa-2', raw, parsed, '2026-10-01T07:50:00.000Z'),
    parsed,
    op: 'Buy',
    broker,
    channelKeywords: DEFAULT_CHANNEL_KEYWORDS,
    baseLot: 2,
    params: null,
    symbol: 'XAUUSD',
    uuid: 'fx-stefan',
    strictEntryPrefetch: null,
    commentPrefix: 'TScopier:dewa',
  })
  assert.deepEqual(result, { handled: false })
})

test('Stefan local behavior: explicit reply-linked full entries remain merge eligible', () => {
  const parsed4 = mustParse(signal4Text)
  const linked: BasketMergeLinkContext = {
    replyOk: true,
    withinWindow: true,
    threadLinksAnchor: false,
    implicitBundleWithinTightWindow: true,
    implicitSameChannelBundle: true,
    parameterRefreshSameChannel: true,
    sameSignalRefresh: false,
    sameChannel: true,
    isLinked: true,
    dtMs: 60_000,
    parentLinksAnchor: false,
  }
  assert.equal(isUnlinkedCompleteEntryMerge(parsed4, linked), false)
})
