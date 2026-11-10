import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  currentEntryReadPriority,
  entryBrokerTimingExtras,
  recordBrokerCallTiming,
  runWithEntryBrokerReads,
  runWithPriorityBrokerReads,
  stashEntryBrokerTimings,
  takeEntryBrokerTimings,
} from './brokerEntryContext'

test('runWithEntryBrokerReads forces order-lane reads and accumulates timings', async () => {
  await runWithEntryBrokerReads(async () => {
    assert.equal(currentEntryReadPriority(), 'order')
    recordBrokerCallTiming({ endpoint: 'GetQuote', gatewayWaitMs: 120, httpMs: 80 })
    recordBrokerCallTiming({ endpoint: 'OpenedOrders', gatewayWaitMs: 40, httpMs: 900 })
    recordBrokerCallTiming({ endpoint: 'OrderSendSafe', gatewayWaitMs: 0, httpMs: 1100 })
    const extras = entryBrokerTimingExtras()
    assert.ok(extras)
    assert.equal(extras!.quote_count, 1)
    assert.equal(extras!.quote_gateway_wait_ms, 120)
    assert.equal(extras!.quote_http_ms, 80)
    assert.equal(extras!.opened_orders_count, 1)
    assert.equal(extras!.opened_orders_gateway_wait_ms, 40)
    assert.equal(extras!.opened_orders_http_ms, 900)
    assert.equal(extras!.order_send_count, 1)
    assert.equal(extras!.order_send_http_ms, 1100)
    stashEntryBrokerTimings('sig-1')
  })
  assert.equal(currentEntryReadPriority(), undefined)
  const stashed = takeEntryBrokerTimings('sig-1')
  assert.ok(stashed)
  assert.equal(stashed!.quote_gateway_wait_ms, 120)
  assert.equal(takeEntryBrokerTimings('sig-1'), null)
})

test('runWithPriorityBrokerReads can force background again when nested', async () => {
  await runWithEntryBrokerReads(async () => {
    assert.equal(currentEntryReadPriority(), 'order')
    await runWithPriorityBrokerReads('background', async () => {
      assert.equal(currentEntryReadPriority(), 'background')
    })
    assert.equal(currentEntryReadPriority(), 'order')
  })
})
