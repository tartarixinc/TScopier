import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createBrokerGateway } from './brokerGateway'

function recorder() {
  const waits: number[] = []
  return {
    waits,
    now: () => 1_000,
    sleep: async (ms: number) => { waits.push(ms) },
  }
}

test('order channel paces order starts on its own rate', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ orderRps: 2, backgroundRps: 0, perAccountRps: 0, now: r.now, sleep: r.sleep })
  await gw.acquire('a', 'order')
  await gw.acquire('a', 'order')
  await gw.acquire('a', 'order')
  assert.deepEqual(r.waits, [500, 1_000])
})

test('background channel paces per account', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ perAccountRps: 2, backgroundRps: 0, now: r.now, sleep: r.sleep })
  await gw.acquire('a')
  await gw.acquire('a')
  await gw.acquire('a')
  assert.deepEqual(r.waits, [500, 1_000])
})

test('different accounts do not block each other on the background channel', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ perAccountRps: 2, backgroundRps: 0, now: r.now, sleep: r.sleep })
  await gw.acquire('a')
  await gw.acquire('b')
  assert.deepEqual(r.waits, [])
})

test('background channel paces the aggregate', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ perAccountRps: 0, backgroundRps: 10, now: r.now, sleep: r.sleep })
  await gw.acquire('a')
  await gw.acquire('b')
  await gw.acquire('c')
  assert.deepEqual(r.waits, [100, 200])
})

test('an order does not wait behind a background burst', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ orderRps: 1_000, backgroundRps: 1, perAccountRps: 0, now: r.now, sleep: r.sleep })
  assert.equal(await gw.acquire('a'), 0)          // background, no wait, reserves the background channel ~1s out
  assert.equal(await gw.acquire('a'), 1_000)      // background, waits ~1000ms
  assert.equal(await gw.acquire('a', 'order'), 0) // order, independent channel -> no extra wait
  assert.deepEqual(r.waits, [1_000])
})

test('entry-critical reads on the order lane skip background backlog', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ orderRps: 1_000, backgroundRps: 1, perAccountRps: 0, now: r.now, sleep: r.sleep })
  await gw.acquire('monitor')
  await gw.acquire('monitor')
  // Quote/OpenedOrders during entry use the order lane (via ALS), so they must
  // not inherit the ~1s background wait above.
  assert.equal(await gw.acquire('entry', 'order'), 0)
  assert.deepEqual(r.waits, [1_000])
})

test('rates of 0 disable pacing', async () => {
  const r = recorder()
  const gw = createBrokerGateway({ orderRps: 0, backgroundRps: 0, perAccountRps: 0, now: r.now, sleep: r.sleep })
  await gw.acquire('a', 'order')
  await gw.acquire('a')
  assert.deepEqual(r.waits, [])
})
