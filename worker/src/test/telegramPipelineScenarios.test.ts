import assert from 'node:assert/strict'
import test from 'node:test'
import { FxsocketWsClient } from '../fxsocketWsClient'
import {
  createConnectionEventCollector,
  sawExpectedWsHandshake,
  sleep,
} from './fxsocketWsTestHelpers'
import { startFxsocketMockWsServer } from './fxsocketWsMockServer'
import { mixedProfileCoversRequiredScenarios } from './pipelineScenarioAssertions'
import { TELEGRAM_PIPELINE_SCENARIO_CASES } from './telegramPipelineScenarioCases'
import { assertPipelineScenarioCases } from './telegramPipelineScenarioTestHelpers'

test('non-happy telegram pipeline', async (t) => {
  await assertPipelineScenarioCases(t, TELEGRAM_PIPELINE_SCENARIO_CASES)
})

test('mixed profile includes all non-happy scenario types', () => {
  assert.equal(mixedProfileCoversRequiredScenarios(200), true)
})

test('FxsocketWsClient connects subscribes and heartbeats against mock server', async () => {
  const mock = await startFxsocketMockWsServer()
  const messages: string[] = []
  const client = new FxsocketWsClient({
    accountId: 'acct-heartbeat-1',
    apiKey: 'test-key',
    baseUrl: mock.httpBaseUrl,
    platform: 'MT5',
    heartbeatIntervalMs: 200,
    heartbeatTimeoutMs: 800,
    reconnect: false,
  })

  const unsub = client.onMessage((msg) => {
    messages.push(msg.type)
  })

  client.subscribe({ topic: 'account' })
  await client.whenOpen()
  await sleep(500)

  assert.equal(client.connected, true)
  assert.ok(client.heartbeatStats.pingsSent >= 1)
  assert.ok(client.heartbeatStats.pongsReceived >= 1)
  assert.equal(sawExpectedWsHandshake(messages), true)

  unsub()
  client.close()
  await mock.close()
})

test('FxsocketWsClient heartbeat ping triggers reconnect when server drops connection', async () => {
  const mock = await startFxsocketMockWsServer({ closeOnPing: true })
  const connection = createConnectionEventCollector()
  const client = new FxsocketWsClient({
    accountId: 'acct-timeout-1',
    apiKey: 'test-key',
    baseUrl: mock.httpBaseUrl,
    heartbeatIntervalMs: 150,
    heartbeatTimeoutMs: 500,
    reconnect: true,
    reconnectDelayMs: 100,
    onConnectionChange: connection.onConnectionChange,
  })

  client.subscribe({ topic: 'positions' })
  await client.whenOpen()
  await sleep(800)

  assert.ok(client.heartbeatStats.pingsSent >= 1)
  assert.equal(connection.sawDisconnect(), true)

  client.close()
  await mock.close()
})
