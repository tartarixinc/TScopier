import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CHANNEL_KEYWORDS, parseChannelMessageSync } from './parseSignal'
import { planManualOrders } from './manualPlanner'
import type { ManualSettings, ParsedSignal, PlannerContext } from './manualPlanner'
import { resolveOpExecAndStrict, brokerLimitLevelPassed } from './manualPlanning/executionShape'
import { operationFor } from './tradeExecutor/helpers'

const parse = (message: string) => parseChannelMessageSync(message, DEFAULT_CHANNEL_KEYWORDS, null).parsed

test('explicit pending parser contract preserves BUY/SELL STOP/LIMIT and ordinary sides', () => {
  const cases: Array<[string, string, string | null]> = [
    ['XAUUSD BUY STOP at 4300\nSL 4280\nTP 4304', 'buy', 'stop'],
    ['XAUUSD BUY STOP\nEntry Price: 4300\nSL 4280\nTP 4304', 'buy', 'stop'],
    ['XAUUSD SELL STOP 4300\nSL 4320\nTP 4280', 'sell', 'stop'],
    ['XAUUSD BUY LIMIT 4300\nSL 4280\nTP 4304', 'buy', 'limit'],
    ['XAUUSD SELL LIMIT 4300\nSL 4320\nTP 4280', 'sell', 'limit'],
    ['BUY XAUUSD NOW\nSL 4280\nTP 4304', 'buy', null],
    ['SELL XAUUSD NOW\nSL 4320\nTP 4280', 'sell', null],
  ]
  for (const [message, action, entryOrderType] of cases) {
    const parsed = parse(message)
    assert.equal(parsed.action, action, message)
    assert.equal(parsed.entry_order_type, entryOrderType, message)
  }
})

test('explicit pending operations map directly and are never market-coerced', () => {
  const entries: Array<[ParsedSignal, string]> = [
    [{ action: 'buy', symbol: 'XAUUSD', entry_price: 4300, entry_zone_low: null, entry_zone_high: null, entry_order_type: 'stop', sl: 4280, tp: [4304], lot_size: null }, 'BuyStop'],
    [{ action: 'sell', symbol: 'XAUUSD', entry_price: 4300, entry_zone_low: null, entry_zone_high: null, entry_order_type: 'stop', sl: 4320, tp: [4280], lot_size: null }, 'SellStop'],
    [{ action: 'buy', symbol: 'XAUUSD', entry_price: 4300, entry_zone_low: null, entry_zone_high: null, entry_order_type: 'limit', sl: 4280, tp: [4304], lot_size: null }, 'BuyLimit'],
    [{ action: 'sell', symbol: 'XAUUSD', entry_price: 4300, entry_zone_low: null, entry_zone_high: null, entry_order_type: 'limit', sl: 4320, tp: [4280], lot_size: null }, 'SellLimit'],
  ]
  for (const [parsed, expected] of entries) {
    const op = operationFor(parsed.action, parsed)
    assert.equal(op, expected)
    const resolved = resolveOpExecAndStrict({
      opSplit: op!, isBuy: parsed.action === 'buy', entryAnchor: 4300,
      manualStrict: true, hasExplicitEntry: true, explicitEntryOrderType: parsed.entry_order_type,
      roundPrice: value => Number(value ?? 0), resolvedSymbol: 'XAUUSD', commentPrefix: 'test',
      now: new Date('2026-09-17T00:00:00Z'), pendingExpiryRaw: 1,
    })
    assert.equal(resolved.opExec, expected)
    assert.equal(resolved.orderPrice, 4300)
    assert.equal(resolved.strictEntry, undefined)
    assert.equal(resolved.expirationFields.expirationType, 'Specified')
  }
})

const ctx: PlannerContext = {
  point: 0.01, digits: 2, minLot: 0.01, lotStep: 0.01, stopsLevel: 0,
  freezeLevel: 0, defaultLot: 0.01, lastBalance: null, now: new Date('2026-09-17T00:00:00Z'),
}
const multiManual: ManualSettings = {
  risk_mode: 'fixed_lot', fixed_lot: 0.04, trade_style: 'multi', multi_trade_leg_percent: 25,
  multi_trade_max_orders: 4, pending_expiry_hours: 1,
  tp_lots: [
    { label: 'TP1', lot: 0, percent: 25, enabled: true },
    { label: 'TP2', lot: 0, percent: 25, enabled: true },
    { label: 'TP3', lot: 0, percent: 25, enabled: true },
    { label: 'TP4', lot: 0, percent: 25, enabled: true },
  ],
}

test('multi-TP explicit BUY/SELL STOP retain pending operation, entry, expiry, and per-leg TP', () => {
  for (const [action, op, sl, tps] of [
    ['buy', 'BuyStop', 4280, [4304, 4306, 4309, 4320]],
    ['sell', 'SellStop', 4320, [4296, 4294, 4291, 4280]],
  ] as const) {
    const parsed: ParsedSignal = {
      action, symbol: 'XAUUSD', entry_price: 4300, entry_zone_low: null, entry_zone_high: null,
      entry_order_type: 'stop', sl, tp: [...tps], lot_size: null,
    }
    const plan = planManualOrders({
      parsed, resolvedSymbol: 'XAUUSD', baseOperation: op, manual: multiManual,
      channelKeywords: null, manualLot: 0.04, ctx, commentPrefix: 'test',
    })
    assert.equal(plan.orders.length, 4)
    assert.deepEqual(plan.orders.map(order => order.operation), [op, op, op, op])
    assert.deepEqual(plan.orders.map(order => order.price), [4300, 4300, 4300, 4300])
    assert.deepEqual(plan.orders.map(order => order.takeprofit), [...tps])
    assert.ok(plan.orders.every(order => order.expirationType === 'Specified' && order.expiration))
  }
})

const PENDING_LIMIT_MESSAGE = [
  '⚡ [Gold Volatility Alert — Impulse Detected, Monitoring Entry]',
  'Direction bias: SELL · Price 4279.59',
  'BOS DOWN · Displacement ✗ · OB ✓ · FVG ✓',
  'Score 82% · RR 1.81',
  'ℹ️ Pending LIMIT (informational only) @ 4272.35 · SL 4274.84 · RR 3.11',
].join('\n')

test('pending LIMIT phrasing becomes a broker limit at the level, not the bias price', () => {
  const parsed = parse(PENDING_LIMIT_MESSAGE)
  assert.equal(parsed.action, 'sell')
  assert.equal(parsed.entry_order_type, 'limit')
  assert.equal(parsed.entry_price, 4272.35)
  assert.equal(parsed.sl, 4274.84)

  const noLevel = parse('XAUUSD SELL\nPending LIMIT (informational only)\nSL 4274.84\nTP 4260')
  assert.equal(noLevel.entry_order_type, null)

  const sideMatch = parse('XAUUSD BUY\npending buy limit order @ 1.1340\nSL 1.1310\nTP 1.1370')
  assert.equal(sideMatch.entry_order_type, 'limit')
  assert.equal(sideMatch.entry_price, 1.134)
})

test('pending limit parse plans a broker SellLimit at the level with the right-side stop', () => {
  const parsed = parse(PENDING_LIMIT_MESSAGE) as ParsedSignal
  const op = operationFor(String(parsed.action), parsed)
  assert.equal(op, 'SellLimit')
  const plan = planManualOrders({
    parsed, resolvedSymbol: 'XAUUSD', baseOperation: op!,
    manual: { risk_mode: 'fixed_lot', fixed_lot: 0.01, trade_style: 'single', pending_expiry_hours: 1 },
    channelKeywords: null, manualLot: 0.01, ctx, commentPrefix: 'test',
  })
  assert.equal(plan.skip_reason, undefined)
  assert.equal(plan.orders.length, 1)
  const order = plan.orders[0]!
  assert.equal(order.operation, 'SellLimit')
  assert.equal(order.price, 4272.35)
  assert.equal(order.stoploss, 4274.84)
  assert.equal(order.expirationType, 'Specified')
  assert.ok(order.expiration)
})

test('brokerLimitLevelPassed flags already-passed quotes only for limit operations', () => {
  assert.equal(brokerLimitLevelPassed({ operation: 'SellLimit', level: 4272.35, bid: 4278, ask: 4278.4 }), true)
  assert.equal(brokerLimitLevelPassed({ operation: 'SellLimit', level: 4272.35, bid: 4270, ask: 4270.4 }), false)
  assert.equal(brokerLimitLevelPassed({ operation: 'BuyLimit', level: 1.134, bid: 1.1335, ask: 1.1338 }), true)
  assert.equal(brokerLimitLevelPassed({ operation: 'BuyLimit', level: 1.134, bid: 1.135, ask: 1.1352 }), false)
  assert.equal(brokerLimitLevelPassed({ operation: 'Sell', level: 4272.35, bid: 4278, ask: 4278.4 }), false)
  assert.equal(brokerLimitLevelPassed({ operation: 'SellLimit', level: 0, bid: 4278, ask: 4278.4 }), false)
})