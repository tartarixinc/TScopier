import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import { MtapiProvider } from './mtapiProvider'
import {
  brokerRuntimeForAccount,
  loadBrokerApiByAccountId,
  resolveDurableBrokerArtifacts,
} from './mtApiByAccount'
import {
  resetProviderResolverForTests,
  setFxsocketProviderForTests,
  setMtapiProviderForResolverTests,
} from './providerResolver'

function fakeSupabase(rows: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      assert.equal(table, 'broker_accounts')
      const query = {
        select() { return query },
        async in() { return { data: rows, error: null } },
      }
      return query
    },
  }
}

afterEach(() => resetProviderResolverForTests())

test('durable artifact resolves current MTAPI provider/session by broker_account_id', async () => {
  const broker = {
    id: 'broker-1',
    provider: 'mtapi',
    mtapi_session_id: 'mtapi-current',
    fxsocket_account_id: 'fxsocket-historical',
    metaapi_account_id: 'legacy-historical',
    platform: 'MT5',
    writer_epoch: 9,
    provider_transition_state: 'stable',
    manual_settings: { half_close_percent: 40 },
  }
  const captured = [{
    id: 'artifact-1',
    broker_account_id: 'broker-1',
    metaapi_account_id: 'fxsocket-historical',
    symbol: 'XAUUSD',
  }]
  const resolved = await resolveDurableBrokerArtifacts(
    fakeSupabase([broker]) as never,
    captured,
  )
  assert.equal(resolved.rows.length, 1)
  assert.equal(resolved.rows[0]!.metaapi_account_id, 'mtapi-current')
  assert.equal(captured[0]!.metaapi_account_id, 'fxsocket-historical')
  assert.equal(resolved.platformBySession.has('fxsocket-historical'), false)
  assert.equal(resolved.platformBySession.get('mtapi-current')?.provider, 'mtapi')
  assert.equal(resolved.platformBySession.get('mtapi-current')?.authority?.writerEpoch, 9)
})

test('MTAPI runtime resolves with FXSocket configuration absent', async () => {
  const priorKey = process.env.FXSOCKET_API_KEY
  const priorUrl = process.env.FXSOCKET_URL
  delete process.env.FXSOCKET_API_KEY
  delete process.env.FXSOCKET_URL
  try {
    setFxsocketProviderForTests(null)
    const mtapi = new MtapiProvider({ fetchImpl: async () => new Response('OK') })
    setMtapiProviderForResolverTests(mtapi)
    const byBroker = await loadBrokerApiByAccountId(fakeSupabase([{
      id: 'broker-mtapi',
      provider: 'mtapi',
      mtapi_session_id: 'mtapi-only-session',
      fxsocket_account_id: null,
      metaapi_account_id: null,
      platform: 'MT4',
      writer_epoch: 3,
      provider_transition_state: 'stable',
      manual_settings: null,
    }]) as never, ['broker-mtapi'])
    const runtime = brokerRuntimeForAccount(byBroker, 'broker-mtapi')
    assert.ok(runtime)
    assert.equal(runtime.sessionId, 'mtapi-only-session')
    assert.equal(runtime.provider, 'mtapi')
    assert.equal(runtime.api, mtapi)
  } finally {
    if (priorKey == null) delete process.env.FXSOCKET_API_KEY
    else process.env.FXSOCKET_API_KEY = priorKey
    if (priorUrl == null) delete process.env.FXSOCKET_URL
    else process.env.FXSOCKET_URL = priorUrl
  }
})

test('transition state prevents durable artifacts and monitors from resolving a writer', async () => {
  const broker = {
    id: 'broker-transition',
    provider: 'mtapi',
    mtapi_session_id: 'mtapi-transition',
    fxsocket_account_id: 'fx-preserved',
    metaapi_account_id: null,
    platform: 'MT5',
    writer_epoch: 10,
    provider_transition_state: 'transition',
    manual_settings: null,
  }
  const supabase = fakeSupabase([broker]) as never
  const byBroker = await loadBrokerApiByAccountId(supabase, ['broker-transition'])
  assert.equal(brokerRuntimeForAccount(byBroker, 'broker-transition'), null)
  const resolved = await resolveDurableBrokerArtifacts(supabase, [{
    id: 'artifact-transition',
    broker_account_id: 'broker-transition',
    metaapi_account_id: 'fx-preserved',
  }])
  assert.deepEqual(resolved.rows, [])
  assert.equal(resolved.platformBySession.size, 0)
})

test('migration-window FXSocket runtime still resolves from the same broker row', async () => {
  const byBroker = await loadBrokerApiByAccountId(fakeSupabase([{
    id: 'broker-fx',
    provider: 'fxsocket',
    mtapi_session_id: 'prepared-mtapi',
    fxsocket_account_id: 'fxsocket-current',
    metaapi_account_id: null,
    platform: 'MT5',
    writer_epoch: 2,
    provider_transition_state: 'stable',
    manual_settings: null,
  }]) as never, ['broker-fx'])
  assert.equal(byBroker.get('broker-fx')?.sessionId, 'fxsocket-current')
  assert.equal(byBroker.get('broker-fx')?.provider, 'fxsocket')
})
