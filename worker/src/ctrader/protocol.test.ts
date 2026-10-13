import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  ctraderAuthorizeUrl,
  ctraderExecutionType,
  ctraderMarketFillReady,
  ctraderPayloadType,
  ctraderSocketUrl,
  ctraderSpotPrice,
  ctraderVolumeToLots,
  lotsToCtraderVolume,
  mapCtraderOrder,
  priceToRelative,
  readCtraderTokenResponse,
  relativeToPrice,
} from './protocol'

test('cTrader volume converts lots through the symbol lot size', () => {
  assert.equal(lotsToCtraderVolume(1, 10_000_000), 10_000_000)
  assert.equal(lotsToCtraderVolume(0.1, 10_000_000), 1_000_000)
  assert.equal(lotsToCtraderVolume(0.01, 10_000_000), 100_000)
  assert.equal(ctraderVolumeToLots(1_000_000, 10_000_000), 0.1)
  assert.throws(() => lotsToCtraderVolume(0, 10_000_000), /greater than zero/)
})

test('cTrader market fill ignores an accepted event that has no position', () => {
  assert.equal(ctraderMarketFillReady({ executionType: 2, order: { orderId: 555 } }), false)
  assert.equal(ctraderMarketFillReady({ executionType: 'ORDER_ACCEPTED', order: { orderId: 555 } }), false)
  assert.equal(ctraderMarketFillReady({
    executionType: 3,
    position: { positionId: 44753770, price: 4170.48, tradeData: { volume: 1000 } },
  }), true)
  assert.equal(ctraderMarketFillReady({
    executionType: 'ORDER_FILLED',
    deal: { positionId: 44753770, executionPrice: 4170.48, filledVolume: 1000 },
  }), true)
  assert.equal(ctraderMarketFillReady({ executionType: 7 }), true)
  assert.equal(ctraderMarketFillReady({ executionType: 'ORDER_REJECTED' }), true)
  assert.equal(ctraderPayloadType('ProtoOAExecutionEvent'), 2126)
  assert.equal(ctraderExecutionType('OrderFilled'), 3)
})

test('cTrader spot quotes use a fixed 1/100000 scale', () => {
  assert.equal(ctraderSpotPrice(265012000), 2650.12)
  assert.equal(ctraderSpotPrice(123456), 1.23456)
})

test('cTrader prices are scaled by symbol digits', () => {
  assert.equal(priceToRelative(1.23456, 5), 123456)
  assert.equal(relativeToPrice(123456, 5), 1.23456)
})

test('cTrader order sides map onto Open API enums', () => {
  assert.deepEqual(mapCtraderOrder('Buy'), { orderType: 1, tradeSide: 1 })
  assert.deepEqual(mapCtraderOrder('Sell'), { orderType: 1, tradeSide: 2 })
  assert.deepEqual(mapCtraderOrder('BuyLimit'), { orderType: 2, tradeSide: 1 })
  assert.deepEqual(mapCtraderOrder('SellStop'), { orderType: 3, tradeSide: 2 })
  assert.deepEqual(mapCtraderOrder('BuyStopLimit'), { orderType: 6, tradeSide: 1 })
  assert.throws(() => mapCtraderOrder('Hold'), /Unsupported/)
})

test('cTrader hosts and token fields accept both casings', () => {
  assert.equal(ctraderSocketUrl('demo'), 'wss://demo.ctraderapi.com:5036')
  assert.equal(ctraderSocketUrl('live'), 'wss://live.ctraderapi.com:5036')
  const url = new URL(ctraderAuthorizeUrl({
    clientId: 'app',
    redirectUri: 'https://app.tscopier.ai/brokers/ctrader/callback',
    state: 'signed',
  }))
  assert.equal(url.searchParams.get('scope'), 'trading')
  assert.equal(url.searchParams.get('client_id'), 'app')
  assert.deepEqual(
    readCtraderTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
    { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 },
  )
  assert.deepEqual(
    readCtraderTokenResponse({ accessToken: 'a', refreshToken: 'r', expiresIn: '1800' }),
    { accessToken: 'a', refreshToken: 'r', expiresIn: 1800 },
  )
})
