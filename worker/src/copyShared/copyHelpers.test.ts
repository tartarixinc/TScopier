import test from 'node:test'
import assert from 'node:assert/strict'
import { COPY_BROKER_COLUMNS, isDemo, LEGACY_COPY_BROKER_COLUMNS, missingProviderIdColumn, sessionId, type CopyBrokerSessionRow } from './copyHelpers'

/** One row carrying every provider column, so a provider only differs by which id it sets. */
function row(provider: string, idKey: string, id: string): CopyBrokerSessionRow {
  return {
    provider,
    mtapi_session_id: 'mtapi-id',
    fxsocket_account_id: 'fx-id',
    metaapi_account_id: 'legacy-id',
    ctrader_account_id: 'ct-id',
    binance_account_id: 'bn-id',
    bybit_account_id: 'bb-id',
    kucoin_account_id: 'kc-id',
    dxtrade_account_id: 'dx-id',
    tradelocker_account_id: 'tl-id',
    matchtrader_account_id: 'mt-id',
    linked_account_type: 'Demo',
    [idKey]: id,
  } as CopyBrokerSessionRow
}

const PROVIDER_ID_COLUMNS: Array<[string, string]> = [
  ['fxsocket', 'fxsocket_account_id'],
  ['mtapi', 'mtapi_session_id'],
  ['ctrader', 'ctrader_account_id'],
  ['binance', 'binance_account_id'],
  ['bybit', 'bybit_account_id'],
  ['kucoin', 'kucoin_account_id'],
  ['dxtrade', 'dxtrade_account_id'],
  ['tradelocker', 'tradelocker_account_id'],
  ['matchtrader', 'matchtrader_account_id'],
]

for (const [provider, column] of PROVIDER_ID_COLUMNS) {
  test(`sessionId resolves ${provider} from its own ${column}`, () => {
    assert.equal(sessionId(row(provider, column, `${provider}-session`)), `${provider}-session`)
  })
}

test('sessionId never falls back to an fxsocket id for another provider', () => {
  // The pre-fix behaviour: every provider except mtapi/ctrader read
  // fxsocket_account_id, so a binance row resolved to the fxsocket id (or "")
  // and the copy engine could not open a session at all.
  const binance = row('binance', 'binance_account_id', 'binance-session')
  binance.fxsocket_account_id = 'fx-id'
  assert.equal(sessionId(binance), 'binance-session')
  assert.notEqual(sessionId(binance), 'fx-id')
})

test('sessionId is empty when the provider column was not selected', () => {
  // Reproduces the BROKER_COLUMNS regression: the row has no binance column at all.
  const withoutColumn = { provider: 'binance', fxsocket_account_id: null, metaapi_account_id: null } as CopyBrokerSessionRow
  assert.equal(sessionId(withoutColumn), '')
})

test('sessionId is empty for an unknown provider and falls back for a legacy null provider', () => {
  assert.equal(sessionId({ provider: 'webull', fxsocket_account_id: 'fx-id' } as CopyBrokerSessionRow), '')
  assert.equal(sessionId({ provider: null, fxsocket_account_id: 'fx-id' } as CopyBrokerSessionRow), 'fx-id')
  assert.equal(sessionId({ provider: '', metaapi_account_id: 'legacy-id' } as CopyBrokerSessionRow), 'legacy-id')
})

test('sessionId rejects a composite multi-account id', () => {
  assert.equal(sessionId(row('mtapi', 'mtapi_session_id', 'a|b')), '')
  assert.equal(sessionId(row('ctrader', 'ctrader_account_id', 'a|b')), '')
})

test('COPY_BROKER_COLUMNS selects every provider id column', () => {
  for (const [, column] of PROVIDER_ID_COLUMNS) {
    assert.ok(COPY_BROKER_COLUMNS.includes(column), `${column} missing from COPY_BROKER_COLUMNS`)
  }
  for (const field of ['id', 'user_id', 'provider', 'platform', 'is_active', 'connection_status', 'writer_epoch', 'provider_transition_state']) {
    assert.ok(COPY_BROKER_COLUMNS.includes(field), `${field} missing from COPY_BROKER_COLUMNS`)
  }
})

test('isDemo reads linked_account_type only', () => {
  assert.equal(isDemo({ linked_account_type: 'Demo' }), true)
  assert.equal(isDemo({ linked_account_type: 'demo' }), true)
  assert.equal(isDemo({ linked_account_type: 'Live' }), false)
  assert.equal(isDemo({ linked_account_type: 'PropFirm' }), false)
  assert.equal(isDemo({}), false)
})

test('missingProviderIdColumn recognises a stale-schema select failure', () => {
  assert.equal(missingProviderIdColumn('column broker_accounts.matchtrader_account_id does not exist'), true)
  assert.equal(missingProviderIdColumn('column public.binance_account_id does not exist'), true)
  assert.equal(missingProviderIdColumn('column public.dxtrade_is_position_based does not exist'), true)
  assert.equal(missingProviderIdColumn('permission denied for table broker_accounts'), false)
  assert.equal(missingProviderIdColumn(null), false)
  assert.equal(missingProviderIdColumn(undefined), false)
})

test('LEGACY_COPY_BROKER_COLUMNS keeps the providers an older database does have', () => {
  for (const column of ['mtapi_session_id', 'fxsocket_account_id', 'metaapi_account_id', 'ctrader_account_id', 'writer_epoch', 'provider_transition_state', 'platform', 'is_active']) {
    assert.ok(LEGACY_COPY_BROKER_COLUMNS.includes(column), `${column} missing from the legacy column set`)
  }
  for (const column of ['binance_account_id', 'bybit_account_id', 'kucoin_account_id', 'dxtrade_account_id', 'tradelocker_account_id', 'matchtrader_account_id']) {
    assert.equal(LEGACY_COPY_BROKER_COLUMNS.includes(column), false, `${column} must not be in the legacy column set`)
  }
})
