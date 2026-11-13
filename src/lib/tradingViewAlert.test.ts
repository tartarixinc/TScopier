import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseTradingViewAlert,
  stripTradingViewSymbol,
  TRADINGVIEW_ALERT_TEMPLATE_BUY,
  TRADINGVIEW_ALERT_TEMPLATE_SELL,
} from '../../supabase/functions/_shared/tradingViewAlert'

test('stripTradingViewSymbol removes the exchange prefix', () => {
  assert.equal(stripTradingViewSymbol('OANDA:XAUUSD'), 'XAUUSD')
  assert.equal(stripTradingViewSymbol('FX:EURUSD'), 'EURUSD')
  assert.equal(stripTradingViewSymbol('BINANCE:BTCUSDT'), 'BTCUSDT')
  assert.equal(stripTradingViewSymbol('eurusd'), 'EURUSD')
})

test('parseTradingViewAlert accepts a market buy', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    action: 'buy',
    symbol: 'OANDA:XAUUSD',
    price: 2650.2,
    sl: 2640,
    tp: [2660, 2670],
    id: 'alert-1',
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.alert.action, 'buy')
  assert.equal(result.alert.symbol, 'XAUUSD')
  assert.equal(result.alert.parsed.entry_order_type, 'market')
  assert.equal(result.alert.parsed.entry_price, null)
  assert.deepEqual(result.alert.parsed.tp, [2660, 2670])
  assert.equal(result.alert.idempotencyId, 'alert-1')
})

test('parseTradingViewAlert rejects unknown actions and missing symbols', () => {
  assert.equal(parseTradingViewAlert('{"action":"modify","symbol":"EURUSD"}').ok, false)
  assert.equal(parseTradingViewAlert('{"action":"sell"}').ok, false)
  assert.equal(parseTradingViewAlert('not json').ok, false)
  const unresolved = parseTradingViewAlert('{"action":"buy","symbol":"{{ticker}}"}')
  assert.equal(unresolved.ok, false)
  if (!unresolved.ok) assert.equal(unresolved.reason, 'unresolved_symbol_placeholder')
})

test('parseTradingViewAlert recovers unquoted TradingView placeholders and long/short actions', () => {
  const broken = parseTradingViewAlert(`{
  "action": "long",
  "symbol": "OANDA:XAUUSD",
  "price": {{close}},
  "id": "abc"
}`)
  assert.equal(broken.ok, true)
  if (!broken.ok) return
  assert.equal(broken.alert.action, 'buy')
  assert.equal(broken.alert.symbol, 'XAUUSD')

  const short = parseTradingViewAlert('{"action":"short","symbol":"EURUSD"}')
  assert.equal(short.ok, true)
  if (short.ok) assert.equal(short.alert.action, 'sell')

  const unresolvedAction = parseTradingViewAlert('{"action":"{{strategy.order.action}}","symbol":"EURUSD","price":1}')
  assert.equal(unresolvedAction.ok, false)
  if (!unresolvedAction.ok) assert.equal(unresolvedAction.reason, 'unresolved_action_placeholder')
})

test('indicator Buy and Sell templates parse to market buy/sell', () => {
  const buy = parseTradingViewAlert(
    TRADINGVIEW_ALERT_TEMPLATE_BUY.replace('"{{timenow}}"', '"alert-buy"'),
  )
  assert.equal(buy.ok, true)
  if (buy.ok) {
    assert.equal(buy.alert.action, 'buy')
    assert.equal(buy.alert.symbol, 'XAUUSD')
    assert.equal(buy.alert.idempotencyId, 'alert-buy')
  }

  const sell = parseTradingViewAlert(
    TRADINGVIEW_ALERT_TEMPLATE_SELL
      .replace('"XAUUSD"', '"FX:EURUSD"')
      .replace('"{{timenow}}"', '"alert-sell"'),
  )
  assert.equal(sell.ok, true)
  if (sell.ok) {
    assert.equal(sell.alert.action, 'sell')
    assert.equal(sell.alert.symbol, 'EURUSD')
  }
})

test('parseTradingViewAlert ignores unresolved id placeholders', () => {
  const result = parseTradingViewAlert('{"action":"sell","symbol":"XAUUSD","id":"{{timenow}}"}')
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.alert.idempotencyId, null)
})

test('parseTradingViewAlert accepts side+event entry and tp1–tp3', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    event: 'entry',
    side: 'BUY',
    order: 'MARKET',
    symbol: 'XAUUSD',
    entry: 2650,
    sl: 2640,
    tp1: 2660,
    tp2: 2670,
    tp3: 2680,
    price: 2650.2,
    id: 'plot-1',
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.alert.action, 'buy')
  assert.equal(result.alert.symbol, 'XAUUSD')
  assert.equal(result.alert.sl, 2640)
  assert.deepEqual(result.alert.tp, [2660, 2670, 2680])
  assert.equal(result.alert.parsed.entry_order_type, 'market')
  assert.equal(result.alert.parsed.entry_price, null)
  assert.equal(result.alert.idempotencyId, 'plot-1')
})

test('parseTradingViewAlert accepts SELL side and LIMIT entry', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    event: 'entry',
    side: 'SELL',
    order: 'LIMIT',
    symbol: 'EURUSD',
    entry: 1.085,
    sl: 1.09,
    tp1: 1.08,
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.alert.action, 'sell')
  assert.equal(result.alert.parsed.entry_order_type, 'limit')
  assert.equal(result.alert.parsed.entry_price, 1.085)
  assert.deepEqual(result.alert.tp, [1.08])
})

test('parseTradingViewAlert maps event close to close action', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    event: 'close',
    side: 'BUY',
    symbol: 'XAUUSD',
  }))
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.alert.action, 'close')
})

test('parseTradingViewAlert prefers tp array over split tpN when both present', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    action: 'buy',
    symbol: 'XAUUSD',
    tp: [10, 20],
    tp1: 99,
    tp2: 98,
  }))
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.alert.tp, [10, 20])
})

test('parseTradingViewAlert coerces unquoted plot placeholders', () => {
  const result = parseTradingViewAlert(`{
  "event": "entry",
  "side": "BUY",
  "symbol": "XAUUSD",
  "sl": {{plot("SL")}},
  "tp1": {{plot("TP1")}},
  "price": {{close}}
}`)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.alert.action, 'buy')
  assert.equal(result.alert.sl, null)
  assert.equal(result.alert.tp, null)
})

test('parseTradingViewAlert rejects missing direction', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    symbol: 'XAUUSD',
    price: 1,
  }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'unknown_action')
})
