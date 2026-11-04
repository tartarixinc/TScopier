import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apiForBrokerRow, SkipWarnLedger } from './closedTradeFillMonitor'
import { COPY_BROKER_COLUMNS, LEGACY_COPY_BROKER_COLUMNS } from './copyShared/copyHelpers'
import { brokerSessionId } from './mtApiByAccount'
import {
  resetProviderResolverForTests,
  setFxsocketProviderForTests,
  setMtapiProviderForResolverTests,
} from './providerResolver'

type Seeded = { sessionId: string; platform: string }

function mockProvider() {
  const seeded: Seeded[] = []
  return {
    seeded,
    provider: {
      seedPlatformCache: (sessionId: string, platform: string) => {
        seeded.push({ sessionId, platform })
      },
    } as never,
  }
}

afterEach(() => resetProviderResolverForTests())

describe('apiForBrokerRow', () => {
  it('resolves an MTAPI client from the broker row alone', () => {
    const { provider, seeded } = mockProvider()
    setMtapiProviderForResolverTests(provider)
    setFxsocketProviderForTests(null)

    const api = apiForBrokerRow(
      {
        id: 'b1',
        provider: 'mtapi',
        mtapi_session_id: '6f0a1604-47ec-4ace-847e-f3cb2d48d5a9',
        platform: 'MT5',
        writer_epoch: 1,
        provider_transition_state: 'stable',
      },
      '6f0a1604-47ec-4ace-847e-f3cb2d48d5a9',
    )

    assert.equal(api, provider, 'row provider must win — no session map involved')
    assert.deepEqual(seeded, [
      { sessionId: '6f0a1604-47ec-4ace-847e-f3cb2d48d5a9', platform: 'MT5' },
    ])
  })

  it('never silently falls back to FXSocket when the row is MTAPI', () => {
    // The old path read metadata?.provider from a session-keyed map; a miss
    // defaulted to 'fxsocket', which is not configured in production, so the
    // monitor skipped the broker with no log line at all.
    const mtapi = mockProvider().provider
    const fxsocket = mockProvider().provider
    setMtapiProviderForResolverTests(mtapi)
    setFxsocketProviderForTests(fxsocket)

    const api = apiForBrokerRow(
      { id: 'b1', provider: 'mtapi', mtapi_session_id: 'sess-1', platform: 'MT5' },
      'sess-1',
    )
    assert.equal(api, mtapi)
    assert.notEqual(api, fxsocket)
  })

  it('fails closed for an unknown provider instead of guessing', () => {
    setFxsocketProviderForTests(mockProvider().provider)
    setMtapiProviderForResolverTests(mockProvider().provider)

    const api = apiForBrokerRow(
      { id: 'b1', provider: 'carrier-pigeon', mtapi_session_id: 'sess-1' },
      'sess-1',
    )
    assert.equal(api, null)
  })

  it('returns null for an empty or multi-session id', () => {
    setMtapiProviderForResolverTests(mockProvider().provider)
    assert.equal(apiForBrokerRow({ id: 'b1', provider: 'mtapi' }, ''), null)
    assert.equal(
      apiForBrokerRow({ id: 'b1', provider: 'mtapi' }, 'a|b'),
      null,
      'a pipe-joined session list must never be used as one session',
    )
  })

  it('defaults a blank platform to MT5 when seeding', () => {
    const { provider, seeded } = mockProvider()
    setMtapiProviderForResolverTests(provider)

    apiForBrokerRow({ id: 'b1', provider: 'mtapi', platform: null }, 'sess-1')
    assert.deepEqual(seeded, [{ sessionId: 'sess-1', platform: 'MT5' }])
  })
})

describe('SkipWarnLedger', () => {
  it('warns once for a standing skip and stays quiet on every repeat', () => {
    const ledger = new SkipWarnLedger()
    assert.equal(ledger.shouldWarn('b1', 'skip broker=b1: no session'), true)
    assert.equal(ledger.shouldWarn('b1', 'skip broker=b1: no session'), false)
    assert.equal(ledger.shouldWarn('b1', 'skip broker=b1: no session'), false)
    assert.equal(ledger.size, 1)
  })

  it('warns again once the broker recovers and then fails anew', () => {
    const ledger = new SkipWarnLedger()
    assert.equal(ledger.shouldWarn('b1', 'skip broker=b1: no session'), true)
    ledger.clear('b1') // successful resolution on a later tick
    assert.equal(ledger.shouldWarn('b1', 'skip broker=b1: no session'), true)
  })

  it('warns immediately when the reason changes', () => {
    const ledger = new SkipWarnLedger()
    assert.equal(ledger.shouldWarn('b1', 'no session'), true)
    assert.equal(ledger.shouldWarn('b1', 'no broker client'), true)
    assert.equal(ledger.shouldWarn('b1', 'no broker client'), false)
    assert.equal(ledger.shouldWarn('b1', 'no session'), false, 'older reasons stay silenced')
  })

  it('keeps brokers independent and bounded', () => {
    const ledger = new SkipWarnLedger()
    assert.equal(ledger.shouldWarn('b1', 'reason'), true)
    assert.equal(ledger.shouldWarn('b2', 'reason'), true, 'other brokers still warn')
    ledger.clear('b1')
    assert.equal(ledger.size, 1, 'only the cleared key is dropped')
    ledger.clear('nope')
    assert.equal(ledger.size, 1, 'clearing an unknown key is harmless')
  })
})

describe('SkipWarnLedger bound', () => {
  it('cannot grow without limit when a key keeps producing new reasons', () => {
    const ledger = new SkipWarnLedger()
    for (let i = 0; i < 16; i += 1) {
      assert.equal(ledger.shouldWarn('b1', `reason-${i}`), true)
    }
    // A rotating session id would otherwise add a new message every tick.
    assert.equal(ledger.shouldWarn('b1', 'reason-16'), true, 'the 17th new reason still warns')
    assert.equal(ledger.size, 1, 'the ledger tracks one set per key, never one entry per message')
    assert.equal(
      ledger.shouldWarn('b1', 'reason-0'),
      true,
      'after the wrap the oldest reason may warn again — bounded, not leaky',
    )
  })
})

// Regression (incident 2026-11-03): the monitor's private broker select
// omitted `ctrader_account_id`, so brokerSessionId() resolved an empty
// session for every cTrader broker, the whole account was skipped each tick,
// and closed cTrader rows could never be backfilled (profit stayed null while
// MetaTrader rows from the same signal filled within minutes). The select now
// uses the shared COPY_BROKER_COLUMNS — the same list the mirror and social
// monitors load — so the reader and the select cannot drift apart again.
describe('broker select column coverage', () => {
  const SESSION_ID_COLUMNS = [
    'mtapi_session_id',
    'fxsocket_account_id',
    'metaapi_account_id',
    'ctrader_account_id',
    'binance_account_id',
    'bybit_account_id',
    'kucoin_account_id',
    'dxtrade_account_id',
    'tradelocker_account_id',
    'matchtrader_account_id',
  ]

  it('COPY_BROKER_COLUMNS carries every column brokerSessionId consults', () => {
    const columns = new Set(COPY_BROKER_COLUMNS.split(','))
    for (const column of SESSION_ID_COLUMNS) {
      assert.ok(columns.has(column), `shared select is missing ${column}`)
    }
    assert.ok(columns.has('platform'), 'shared select is missing platform')
    assert.ok(columns.has('writer_epoch'), 'shared select is missing writer_epoch')
    assert.ok(columns.has('provider_transition_state'), 'shared select is missing provider_transition_state')
  })

  it('LEGACY_COPY_BROKER_COLUMNS carries the pre-fan-out providers too', () => {
    const columns = new Set(LEGACY_COPY_BROKER_COLUMNS.split(','))
    for (const column of ['mtapi_session_id', 'fxsocket_account_id', 'metaapi_account_id', 'ctrader_account_id']) {
      assert.ok(columns.has(column), `legacy select is missing ${column}`)
    }
  })

  it('a row holding only its provider column resolves the session id that the select must deliver', () => {
    assert.equal(brokerSessionId({ provider: 'ctrader', ctrader_account_id: '49341285' }), '49341285')
    assert.equal(brokerSessionId({ provider: 'mtapi', mtapi_session_id: 'aaaa-bbbb' }), 'aaaa-bbbb')
    assert.equal(
      brokerSessionId({ provider: 'ctrader', mtapi_session_id: 'set', fxsocket_account_id: 'set' }),
      '',
      'without the ctrader column the row resolves to an empty session — the incident',
    )
  })

  it('the monitor loads brokers through the shared list, with the legacy fallback', () => {
    const source = readFileSync('src/closedTradeFillMonitor.ts', 'utf8')
    assert.ok(
      source.includes('readBrokers(COPY_BROKER_COLUMNS)'),
      'broker load must use the shared COPY_BROKER_COLUMNS',
    )
    assert.ok(
      source.includes('missingProviderIdColumn'),
      'a database without the provider columns must fall back to the legacy list',
    )
    assert.ok(
      !source.includes(".select('id,provider,mtapi_session_id"),
      'a private column list must not come back',
    )
  })
})
