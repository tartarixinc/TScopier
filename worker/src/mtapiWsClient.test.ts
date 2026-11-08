import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMtapiOnOrderUpdateUrl,
  MTAPI_COPY_RELEVANT_UPDATE_TYPES,
  mtapiHttpBaseUrl,
  mtapiWsAuthHeaders,
  mtapiWsBaseUrl,
  normalizeMtapiOrderUpdate,
} from './mtapiWsClient'

test('builds wss OnOrderUpdate URL from https base and session id', () => {
  assert.equal(
    buildMtapiOnOrderUpdateUrl('sess-1', 'MT5', 'https://mtapi.example:9443'),
    'wss://mtapi.example:9443/OnOrderUpdate?id=sess-1',
  )
  assert.equal(mtapiWsBaseUrl('http://localhost:5000'), 'ws://localhost:5000')
  assert.equal(mtapiHttpBaseUrl('MT5', 'https://bridge/'), 'https://bridge')
})

test('mtapiWsAuthHeaders mirrors REST nginx auth', () => {
  const headers = mtapiWsAuthHeaders({ apiKey: 'k', internalToken: 't' })
  assert.equal(headers.Authorization, 'Bearer k')
  assert.equal(headers['X-Internal-Token'], 't')
})

test('normalizeMtapiOrderUpdate detects copy-relevant update types', () => {
  const open = normalizeMtapiOrderUpdate({
    type: 'OrderUpdate',
    data: { update: { type: 'MarketOpen' }, openedOrders: [{ ticket: 1 }] },
  })
  assert.equal(open.copyRelevant, true)
  assert.equal(open.updateType, 'marketopen')

  const modify = normalizeMtapiOrderUpdate({ Update: { Type: 'MarketModify' } })
  assert.equal(modify.copyRelevant, true)

  const close = normalizeMtapiOrderUpdate({ result: { update: { type: 4 } } })
  assert.equal(close.copyRelevant, true)
  assert.equal(close.updateType, '4')

  const balance = normalizeMtapiOrderUpdate({ update: { type: 'Balance' } })
  assert.equal(balance.copyRelevant, false)

  const snapshot = normalizeMtapiOrderUpdate({ openedOrders: [{ ticket: 9 }] })
  assert.equal(snapshot.copyRelevant, true)

  assert.ok(MTAPI_COPY_RELEVANT_UPDATE_TYPES.has('onstoploss'))
  assert.ok(MTAPI_COPY_RELEVANT_UPDATE_TYPES.has('partialclose'))
})
