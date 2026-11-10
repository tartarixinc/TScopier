import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTradingViewAlert, stripTradingViewSymbol } from '../../supabase/functions/_shared/tradingViewAlert'

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
