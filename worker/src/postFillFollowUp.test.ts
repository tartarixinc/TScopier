import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { applyPostFillFollowUp, type PostFillExecutorHooks } from './postFillFollowUp'
import type { ManualSettings, ParsedSignal } from './manualPlanning/types'
import type { SignalRow } from './tradeExecutor/types'

process.env.EXECUTOR_NEWS_BLACKOUT_PRE_FILL = 'true'

const parsed: ParsedSignal = {
  action: 'buy',
  symbol: 'XAUUSD',
  entry_price: 2000,
  entry_zone_low: null,
  entry_zone_high: null,
  sl: 1990,
  tp: [2010, 2020],
  lot_size: null,
}

const hooks: PostFillExecutorHooks = {
  async closeOppositeDirectionTrades() {},
  async tryParameterFollowUpMergeModifyOnly() { return { handled: false } },
  async tryMergeSignalIntoExistingOpenTrade() { return { handled: false } },
}

function makeSignal(): SignalRow {
  return {
    id: 'sig-1',
    user_id: 'user-1',
    channel_id: null,
    parsed_data: parsed,
    status: 'parsed',
    parent_signal_id: null,
    is_modification: false,
  }
}
function makeSupabase(
  tradeUpdates: Record<string, unknown>[],
  inserts: Record<string, unknown>[] = [],
) {
  return {
    from(_table: string) {
      return {
        update(payload: Record<string, unknown>) {
          tradeUpdates.push(payload)
          return {
            eq() {
              return Promise.resolve({ error: null })
            },
          }
        },
        insert(payload: Record<string, unknown>) {
          inserts.push(payload)
          return Promise.resolve({ error: null })
        },
      }
    },
  }
}

test('applyPostFillFollowUp: multi override SL 80 restamps from fill and leaves TP', async () => {
  const modifies: Array<{ ticket: number; stoploss?: number | null; takeprofit?: number | null }> = []
  const tradeUpdates: Record<string, unknown>[] = []
  const manual: ManualSettings = {
    trade_style: 'multi',
    use_predefined_sl_pips: true,
    predefined_sl_pips: 80,
    use_predefined_tp_pips: false,
  }
  await applyPostFillFollowUp({
    supabase: makeSupabase(tradeUpdates) as never,
    api: {
      async orderModify(_uuid: string, args: { ticket: number; stoploss?: number | null; takeprofit?: number | null }) {
        modifies.push(args)
        return { ticket: args.ticket }
      },
    } as never,
    uuid: 'acct-1',
    signal: makeSignal(),
    parsed,
    op: 'Buy',
    broker: { id: 'broker-1', manual_settings: manual, default_lot_size: 0.01, last_balance: null },
    channelKeywords: null,
    symbol: 'XAUUSD',
    baseLot: 0.01,
    params: {
      point: 0.01,
      digits: 2,
      minLot: 0.01,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      defaultLot: 0.01,
      lastBalance: null,
    },
    filledLegs: [{
      tradeRowId: 'trade-1',
      ticket: 42,
      symbol: 'XAUUSD',
      direction: 'buy',
      entryPrice: 2000,
      openSl: 0,
      openTp: 2010,
    }],
    hooks,
  })

  assert.equal(modifies.length, 1)
  assert.equal(modifies[0]?.ticket, 42)
  assert.equal(modifies[0]?.stoploss, 1992)
  assert.equal(modifies[0]?.takeprofit, undefined)
  assert.equal(tradeUpdates.length, 1)
  assert.equal(tradeUpdates[0]?.sl, 1992)
  assert.equal('tp' in (tradeUpdates[0] ?? {}), false)
})

test('applyPostFillFollowUp: multi without override SL does not flatten TPs or modify', async () => {
  const modifies: unknown[] = []
  await applyPostFillFollowUp({
    supabase: makeSupabase([]) as never,
    api: {
      async orderModify() {
        modifies.push('modify')
        return { ticket: 1 }
      },
    } as never,
    uuid: 'acct-1',
    signal: makeSignal(),
    parsed,
    op: 'Buy',
    broker: {
      id: 'broker-1',
      manual_settings: { trade_style: 'multi' },
      default_lot_size: 0.01,
      last_balance: null,
    },
    channelKeywords: null,
    symbol: 'XAUUSD',
    baseLot: 0.01,
    params: {
      point: 0.01,
      digits: 2,
      minLot: 0.01,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      defaultLot: 0.01,
      lastBalance: null,
    },
    filledLegs: [{
      tradeRowId: 'trade-1',
      ticket: 42,
      symbol: 'XAUUSD',
      direction: 'buy',
      entryPrice: 2000,
      openSl: 0,
      openTp: 2010,
    }],
    hooks,
  })
  assert.equal(modifies.length, 0)
})

test('applyPostFillFollowUp: multi override TP 30 restamps from fill and keeps bucket', async () => {
  const modifies: Array<{ ticket: number; stoploss?: number | null; takeprofit?: number | null }> = []
  const tradeUpdates: Record<string, unknown>[] = []
  const manual: ManualSettings = {
    trade_style: 'multi',
    use_predefined_sl_pips: false,
    use_predefined_tp_pips: true,
    predefined_tp_pips: [30],
  }
  await applyPostFillFollowUp({
    supabase: makeSupabase(tradeUpdates) as never,
    api: {
      async orderModify(_uuid: string, args: { ticket: number; stoploss?: number | null; takeprofit?: number | null }) {
        modifies.push(args)
        return { ticket: args.ticket }
      },
    } as never,
    uuid: 'acct-1',
    signal: makeSignal(),
    parsed,
    op: 'Buy',
    broker: { id: 'broker-1', manual_settings: manual, default_lot_size: 0.01, last_balance: null },
    channelKeywords: null,
    symbol: 'XAUUSD',
    baseLot: 0.01,
    params: {
      point: 0.01,
      digits: 2,
      minLot: 0.01,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      defaultLot: 0.01,
      lastBalance: null,
    },
    filledLegs: [{
      tradeRowId: 'trade-1',
      ticket: 42,
      symbol: 'XAUUSD',
      direction: 'buy',
      entryPrice: 1990,
      openSl: 1982,
      openTp: 2003,
    }],
    hooks,
  })

  assert.equal(modifies.length, 1)
  assert.equal(modifies[0]?.ticket, 42)
  assert.equal(modifies[0]?.takeprofit, 1993)
  assert.equal(modifies[0]?.stoploss, undefined)
  assert.equal(tradeUpdates.length, 1)
  assert.equal(tradeUpdates[0]?.tp, 1993)
  assert.equal('sl' in (tradeUpdates[0] ?? {}), false)
})

test('applyPostFillFollowUp: multi override TPs keep TP1 vs TP2 buckets', async () => {
  const modifies: Array<{ ticket: number; stoploss?: number | null; takeprofit?: number | null }> = []
  const manual: ManualSettings = {
    trade_style: 'multi',
    use_predefined_tp_pips: true,
    predefined_tp_pips: [30, 50],
  }
  await applyPostFillFollowUp({
    supabase: makeSupabase([]) as never,
    api: {
      async orderModify(_uuid: string, args: { ticket: number; stoploss?: number | null; takeprofit?: number | null }) {
        modifies.push(args)
        return { ticket: args.ticket }
      },
    } as never,
    uuid: 'acct-1',
    signal: makeSignal(),
    parsed,
    op: 'Buy',
    broker: { id: 'broker-1', manual_settings: manual, default_lot_size: 0.01, last_balance: null },
    channelKeywords: null,
    symbol: 'XAUUSD',
    baseLot: 0.01,
    params: {
      point: 0.01,
      digits: 2,
      minLot: 0.01,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      defaultLot: 0.01,
      lastBalance: null,
    },
    filledLegs: [
      {
        tradeRowId: 'trade-1',
        ticket: 41,
        symbol: 'XAUUSD',
        direction: 'buy',
        entryPrice: 2000.2,
        openSl: 0,
        openTp: 2003,
      },
      {
        tradeRowId: 'trade-2',
        ticket: 42,
        symbol: 'XAUUSD',
        direction: 'buy',
        entryPrice: 2000.2,
        openSl: 0,
        openTp: 2005,
      },
    ],
    hooks,
  })

  assert.equal(modifies.length, 2)
  assert.equal(modifies[0]?.takeprofit, 2003.2)
  assert.equal(modifies[1]?.takeprofit, 2005.2)
})

test('applyPostFillFollowUp: reverse fill uses ticket side not parsed buy for predefined stops', async () => {
  const modifies: Array<{ ticket: number; stoploss?: number | null; takeprofit?: number | null }> = []
  const tradeUpdates: Record<string, unknown>[] = []
  const manual: ManualSettings = {
    trade_style: 'single',
    reverse_signal: true,
    use_predefined_sl_pips: true,
    predefined_sl_pips: 80,
    use_predefined_tp_pips: true,
    predefined_tp_pips: [30],
  }
  await applyPostFillFollowUp({
    supabase: makeSupabase(tradeUpdates) as never,
    api: {
      async orderModify(_uuid: string, args: { ticket: number; stoploss?: number | null; takeprofit?: number | null }) {
        modifies.push(args)
        return { ticket: args.ticket }
      },
    } as never,
    uuid: 'acct-1',
    signal: makeSignal(),
    parsed,
    op: 'Sell',
    broker: { id: 'broker-1', manual_settings: manual, default_lot_size: 0.01, last_balance: null },
    channelKeywords: null,
    symbol: 'XAUUSD',
    baseLot: 0.01,
    params: {
      point: 0.01,
      digits: 2,
      minLot: 0.01,
      lotStep: 0.01,
      contractSize: 100,
      stopsLevel: 0,
      freezeLevel: 0,
      defaultLot: 0.01,
      lastBalance: null,
    },
    filledLegs: [{
      tradeRowId: 'trade-1',
      ticket: 42,
      symbol: 'XAUUSD',
      direction: 'sell',
      entryPrice: 1990,
      openSl: 0,
      openTp: 0,
    }],
    hooks,
  })

  assert.equal(modifies.length, 1)
  assert.equal(modifies[0]?.ticket, 42)
  assert.equal(modifies[0]?.stoploss, 1998)
  assert.equal(modifies[0]?.takeprofit, 1987)
  assert.equal(tradeUpdates[0]?.sl, 1998)
  assert.equal(tradeUpdates[0]?.tp, 1987)
})
function singlePredefinedArgs(overrides: {
  manual: ManualSettings
  openTp: number
  tradeUpdates?: Record<string, unknown>[]
  inserts?: Record<string, unknown>[]
}) {
  const modifies: Array<{ ticket: number; stoploss?: number | null; takeprofit?: number | null }> = []
  const tradeUpdates = overrides.tradeUpdates ?? []
  const inserts = overrides.inserts ?? []
  return {
    modifies,
    tradeUpdates,
    inserts,
    run: () => applyPostFillFollowUp({
      supabase: makeSupabase(tradeUpdates, inserts) as never,
      api: {
        async orderModify(_uuid: string, args: { ticket: number; stoploss?: number | null; takeprofit?: number | null }) {
          modifies.push(args)
          return { ticket: args.ticket }
        },
      } as never,
      uuid: 'acct-1',
      signal: makeSignal(),
      parsed,
      op: 'Buy',
      broker: {
        id: 'broker-1',
        manual_settings: overrides.manual,
        default_lot_size: 0.01,
        last_balance: null,
      },
      channelKeywords: null,
      symbol: 'XAUUSD',
      baseLot: 0.01,
      params: {
        point: 0.01,
        digits: 2,
        minLot: 0.01,
        lotStep: 0.01,
        contractSize: 100,
        stopsLevel: 0,
        freezeLevel: 0,
        defaultLot: 0.01,
        lastBalance: null,
      },
      filledLegs: [{
        tradeRowId: 'trade-1',
        ticket: 42,
        symbol: 'XAUUSD',
        direction: 'buy',
        entryPrice: 2000,
        openSl: 0,
        openTp: overrides.openTp,
      }],
      hooks,
    }),
  }
}
test('applyPostFillFollowUp: keeps the chosen single target instead of the deepest ladder rung', async () => {
  const scenario = singlePredefinedArgs({
    manual: {
      trade_style: 'single',
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
      use_predefined_tp_pips: false,
    },
    openTp: 2015,
  })
  await scenario.run()
  assert.equal(scenario.modifies.length, 1)
  assert.equal(scenario.modifies[0]?.stoploss, 1992)
  assert.equal(scenario.modifies[0]?.takeprofit, undefined, 'chosen target must not be replaced')
  assert.equal(scenario.tradeUpdates[0]?.sl, 1992)
  assert.equal('tp' in (scenario.tradeUpdates[0] ?? {}), false)
})
test('applyPostFillFollowUp: still replaces the target when an explicit TP pip override is set', async () => {
  const scenario = singlePredefinedArgs({
    manual: {
      trade_style: 'single',
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
      use_predefined_tp_pips: true,
      predefined_tp_pips: [80],
    },
    openTp: 2015,
  })
  await scenario.run()
  assert.equal(scenario.modifies.length, 1)
  assert.equal(scenario.modifies[0]?.stoploss, 1992)
  assert.equal(scenario.modifies[0]?.takeprofit, 2008)
  assert.equal(scenario.tradeUpdates[0]?.tp, 2008)
})
test('applyPostFillFollowUp: writes an audit row for every post-fill stop change', async () => {
  const scenario = singlePredefinedArgs({
    manual: {
      trade_style: 'single',
      use_predefined_sl_pips: true,
      predefined_sl_pips: 80,
      use_predefined_tp_pips: false,
    },
    openTp: 2015,
  })
  await scenario.run()
  const audit = scenario.inserts.filter(row => row.action === 'post_fill_stops_modify')
  assert.equal(audit.length, 1, `expected one audit row: ${JSON.stringify(scenario.inserts)}`)
  assert.equal(audit[0]?.status, 'success')
  assert.equal(audit[0]?.signal_id, 'sig-1')
  assert.equal(audit[0]?.broker_account_id, 'broker-1')
  const payload = audit[0]?.request_payload as Record<string, unknown>
  assert.equal(payload.stop_source, 'predefined_stops_from_fill')
  assert.equal(payload.sl_changed, true)
  assert.equal(payload.tp_changed, false)
  assert.equal(payload.from_tp, 2015)
  assert.equal(payload.to_tp, 2015)
})
