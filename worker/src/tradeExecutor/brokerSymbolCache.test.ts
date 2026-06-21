import test from 'node:test'
import assert from 'node:assert/strict'
import type { TradeExecutorContext } from './context'
import type { BrokerRow } from './types'
import { SESSION_PING_MIN_INTERVAL_MS, SYMBOL_CACHE_TTL_MS, SYMBOL_LIST_TTL_MS } from './types'

process.env.FXSOCKET_API_KEY = process.env.FXSOCKET_API_KEY ?? 'test-fxsocket-key'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const brokerSymbolCache = require('./brokerSymbolCache') as typeof import('./brokerSymbolCache')

const FX_UUID = 'b970faaf-1c0a-4d0a-a999-9bad9c1f0a65'

function makeBroker(overrides: Partial<BrokerRow> = {}): BrokerRow {
  return {
    id: 'broker-1',
    user_id: 'user-1',
    is_active: true,
    fxsocket_account_id: FX_UUID,
    metaapi_account_id: '',
    manual_settings: { symbol_to_trade: 'XAUUSD,EURUSD' },
    ...overrides,
  } as BrokerRow
}

function makeCtx(opts?: {
  keepAlive?: (uuid: string) => Promise<boolean>
  markDown?: () => Promise<void>
}): TradeExecutorContext {
  const broker = makeBroker()
  const keepAlive = opts?.keepAlive ?? (async () => true)
  return {
    brokersById: new Map([[broker.id, broker]]),
    sessionPingAt: new Map(),
    sessionOrderBlocked: new Set(),
    sessionCheckInflight: new Map(),
    symbolListCache: new Map(),
    symbolCache: new Map(),
    prewarmSymbolsEnabled: () => true,
    apiFor: () => ({
      keepSessionAlive: keepAlive,
    }),
    getSymbolList: async () => ({
      set: new Set(['XAUUSD']),
      list: ['XAUUSD'],
      loadedAt: Date.now(),
    }),
    getSymbolParams: async () => ({
      digits: 5,
      point: 0.00001,
      minLot: 0.01,
      maxLot: 100,
      lotStep: 0.01,
      contractSize: null,
      stopsLevel: 0,
      freezeLevel: 0,
      loadedAt: Date.now(),
    }),
    markBrokerSessionDown: opts?.markDown ?? (async () => {}),
    supabase: {} as TradeExecutorContext['supabase'],
  } as unknown as TradeExecutorContext
}

test('collectPrewarmSymbolsForBroker includes mapped variants', () => {
  const symbols = brokerSymbolCache.collectPrewarmSymbolsForBroker(makeBroker())
  assert.ok(symbols.includes('XAUUSD'))
  assert.ok(symbols.includes('EURUSD'))
})

test('sessionHeartbeatTick updates sessionPingAt on successful keepSessionAlive', async () => {
  const ctx = makeCtx()
  await brokerSymbolCache.sessionHeartbeatTick(ctx)
  assert.equal(ctx.sessionPingAt.has(FX_UUID), true)
})

test('sessionHeartbeatTick skips ping when sessionPingAt is fresh', async () => {
  let calls = 0
  const ctx = makeCtx({
    keepAlive: async () => {
      calls += 1
      return true
    },
  })
  ctx.sessionPingAt.set(FX_UUID, Date.now())
  await brokerSymbolCache.sessionHeartbeatTick(ctx)
  assert.equal(calls, 0)
})

test('pingBrokerSession forces ping even when sessionPingAt is fresh', async () => {
  let calls = 0
  const ctx = makeCtx({
    keepAlive: async () => {
      calls += 1
      return true
    },
  })
  ctx.sessionPingAt.set(FX_UUID, Date.now())
  await brokerSymbolCache.pingBrokerSession(ctx, makeBroker())
  assert.equal(calls, 1)
})

test('sessionHeartbeatTick treats throttle as soft success without marking broker down', async () => {
  let downCalls = 0
  const ctx = makeCtx({
    keepAlive: async () => {
      throw new Error('Request was throttled. Expected available in 4 seconds.')
    },
    markDown: async () => {
      downCalls += 1
    },
  })
  ctx.sessionPingAt.delete(FX_UUID)
  await brokerSymbolCache.sessionHeartbeatTick(ctx)
  assert.equal(downCalls, 0)
  assert.equal(ctx.sessionPingAt.has(FX_UUID), true)
})

test('sessionHeartbeatTick marks broker down after repeated failures', async () => {
  let downCalls = 0
  const ctx = makeCtx({
    keepAlive: async () => false,
    markDown: async () => {
      downCalls += 1
    },
  })
  const failuresBeforeDown = Math.max(
    2,
    Number(process.env.BROKER_HEARTBEAT_FAILURES_BEFORE_DOWN ?? 4) || 4,
  )
  for (let i = 0; i < failuresBeforeDown; i += 1) {
    ctx.sessionPingAt.delete(FX_UUID)
    await brokerSymbolCache.sessionHeartbeatTick(ctx)
  }
  assert.equal(downCalls, 1)
})

test('brokersWarmForLiveEntry returns false when sessionPingAt is stale', () => {
  const ctx = makeCtx()
  const broker = makeBroker()
  const now = Date.now()
  ctx.sessionPingAt.set(FX_UUID, now - SESSION_PING_MIN_INTERVAL_MS - 1)
  ctx.symbolListCache.set(FX_UUID, {
    set: new Set(['XAUUSD']),
    list: ['XAUUSD'],
    loadedAt: now,
  })
  ctx.symbolCache.set(`${FX_UUID}:XAUUSD`, {
    digits: 5,
    point: 0.00001,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    contractSize: null,
    stopsLevel: 0,
    freezeLevel: 0,
    loadedAt: now,
  })
  assert.equal(
    brokerSymbolCache.brokersWarmForLiveEntry(ctx, [broker], 'XAUUSD'),
    false,
  )
})

test('brokersWarmForLiveEntry returns true when session and symbol caches are fresh', () => {
  const ctx = makeCtx()
  const broker = makeBroker()
  const now = Date.now()
  ctx.sessionPingAt.set(FX_UUID, now)
  ctx.symbolListCache.set(FX_UUID, {
    set: new Set(['XAUUSD']),
    list: ['XAUUSD'],
    loadedAt: now,
  })
  ctx.symbolCache.set(`${FX_UUID}:XAUUSD`, {
    digits: 5,
    point: 0.00001,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    contractSize: null,
    stopsLevel: 0,
    freezeLevel: 0,
    loadedAt: now,
  })
  assert.equal(
    brokerSymbolCache.brokersWarmForLiveEntry(ctx, [broker], 'XAUUSD'),
    true,
  )
})

test('brokersWarmForLiveEntry returns false when symbol caches are expired', () => {
  const ctx = makeCtx()
  const broker = makeBroker()
  const now = Date.now()
  ctx.sessionPingAt.set(FX_UUID, now)
  ctx.symbolListCache.set(FX_UUID, {
    set: new Set(['XAUUSD']),
    list: ['XAUUSD'],
    loadedAt: now - SYMBOL_LIST_TTL_MS - 1,
  })
  ctx.symbolCache.set(`${FX_UUID}:XAUUSD`, {
    digits: 5,
    point: 0.00001,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    contractSize: null,
    stopsLevel: 0,
    freezeLevel: 0,
    loadedAt: now - SYMBOL_CACHE_TTL_MS - 1,
  })
  assert.equal(
    brokerSymbolCache.brokersWarmForLiveEntry(ctx, [broker], 'XAUUSD'),
    false,
  )
})
