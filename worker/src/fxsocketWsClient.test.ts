import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFxsocketWsUrl } from './fxsocketWsClient'

test('buildFxsocketWsUrl uses mt4/mt5 segment and api_key query', () => {
  const url = buildFxsocketWsUrl('acc-123', 'key-abc', 'https://api.fxsocket.com', 'MT4')
  assert.match(url, /^wss:\/\/api\.fxsocket\.com\/mt4\/acc-123\/ws\?api_key=key-abc$/)
})
