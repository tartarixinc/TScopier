import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  BinanceSizingError,
  copierClientOrderId,
  floorToStep,
  formatPrice,
  formatQuantity,
  parseExchangeInfo,
  resolveBinanceSymbol,
  sizeBinancePosition,
} from './symbols'
import { binanceErrorMessage, buildQuery, signQuery } from './futuresClient'

const exchangeInfo = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      status: 'TRADING',
      pricePrecision: 2,
      quantityPrecision: 3,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
        { filterType: 'MIN_NOTIONAL', notional: '100' },
      ],
    },
    {
      symbol: 'XAUUSDT',
      status: 'TRADING',
      pricePrecision: 2,
      quantityPrecision: 3,
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
        { filterType: 'MIN_NOTIONAL', notional: '5' },
      ],
    },
    { symbol: 'OLDUSDT', status: 'BREAK', filters: [] },
  ],
}

test('signQuery matches the HMAC example from the Binance docs', () => {
  const query = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559'
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j'
  assert.equal(signQuery(query, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71')
})

test('buildQuery drops empty values and encodes the rest', () => {
  assert.equal(buildQuery({ a: 1, b: undefined, c: null, d: '', e: 'x y' }), 'a=1&e=x%20y')
})

test('binanceErrorMessage prefers the Binance msg', () => {
  assert.equal(binanceErrorMessage({ code: -2019, msg: 'Margin is insufficient.' }, 400), 'Margin is insufficient.')
  assert.equal(binanceErrorMessage(null, 502), 'Binance HTTP 502')
})

test('parseExchangeInfo reads filters and uses the tighter market max quantity', () => {
  const rules = parseExchangeInfo(exchangeInfo)
  const btc = rules.get('BTCUSDT')!
  assert.equal(btc.tickSize, 0.1)
  assert.equal(btc.stepSize, 0.001)
  assert.equal(btc.minNotional, 100)
  assert.equal(btc.maxQty, 120)
})

test('resolveBinanceSymbol maps USD pairs to USDT perpetuals and skips non-trading symbols', () => {
  const rules = parseExchangeInfo(exchangeInfo)
  assert.equal(resolveBinanceSymbol('XAUUSD', rules)?.symbol, 'XAUUSDT')
  assert.equal(resolveBinanceSymbol('btc/usdt', rules)?.symbol, 'BTCUSDT')
  assert.equal(resolveBinanceSymbol('BTCUSDT.P', rules)?.symbol, 'BTCUSDT')
  assert.equal(resolveBinanceSymbol('BTC', rules)?.symbol, 'BTCUSDT')
  assert.equal(resolveBinanceSymbol('OLD', rules), null)
  assert.equal(resolveBinanceSymbol('NOPE', rules), null)
})

test('floorToStep rounds down without float drift', () => {
  assert.equal(floorToStep(0.0019999, 0.001), 0.001)
  assert.equal(floorToStep(0.3, 0.1), 0.3)
  assert.equal(floorToStep(1.2999, 0.01), 1.29)
  assert.equal(floorToStep(5, 1), 5)
  assert.equal(floorToStep(0.0004, 0.001), 0)
})

test('formatQuantity and formatPrice follow the symbol precision', () => {
  const rules = parseExchangeInfo(exchangeInfo).get('BTCUSDT')!
  assert.equal(formatQuantity(0.05, rules), '0.050')
  assert.equal(formatPrice(65000.04, rules), '65000.0')
  assert.equal(formatPrice(65000.06, rules), '65000.1')
})

test('sizeBinancePosition uses margin x leverage / price, floored to the step', () => {
  const rules = parseExchangeInfo(exchangeInfo).get('BTCUSDT')!
  // 100 USDT x 10 = 1000 notional at 65000 = 0.01538..., floored to 0.015.
  assert.equal(sizeBinancePosition({ marginUsdt: 100, leverage: 10, price: 65000, rules }), 0.015)
})

test('sizeBinancePosition caps at the maximum market quantity', () => {
  const rules = parseExchangeInfo(exchangeInfo).get('BTCUSDT')!
  assert.equal(sizeBinancePosition({ marginUsdt: 10_000_000, leverage: 100, price: 100, rules }), 120)
})

test('sizeBinancePosition rejects orders below the minimum notional', () => {
  const rules = parseExchangeInfo(exchangeInfo).get('BTCUSDT')!
  assert.throws(
    () => sizeBinancePosition({ marginUsdt: 5, leverage: 2, price: 65000, rules }),
    (error: unknown) => error instanceof BinanceSizingError && /minimum order/.test(error.message),
  )
})

test('sizeBinancePosition rejects missing margin, leverage or price', () => {
  const rules = parseExchangeInfo(exchangeInfo).get('XAUUSDT')!
  assert.throws(() => sizeBinancePosition({ marginUsdt: 0, leverage: 10, price: 100, rules }), BinanceSizingError)
  assert.throws(() => sizeBinancePosition({ marginUsdt: 10, leverage: 0, price: 100, rules }), BinanceSizingError)
  assert.throws(() => sizeBinancePosition({ marginUsdt: 10, leverage: 10, price: 0, rules }), BinanceSizingError)
})

test('copierClientOrderId stays within 36 characters and keeps the TScopier prefix', () => {
  const id = copierClientOrderId('TScopier:my-very-long-channel-name-here:abcdef12:tp2:r3', 'k9x2')
  assert.ok(id.length <= 36, id)
  assert.ok(id.startsWith('TScopier'))
  assert.ok(id.endsWith(':k9x2'))
  assert.match(id, /^[A-Za-z0-9:._-]+$/)
  assert.equal(copierClientOrderId(undefined, 'k9x2'), 'TScopier:k9x2')
})
