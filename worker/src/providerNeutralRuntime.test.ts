import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function source(path: string): string {
  return readFileSync(path, 'utf8')
}

const brokerResolvedMonitors = [
  'src/openTradeReconcileMonitor.ts',
  'src/trailingStopMonitor.ts',
  'src/autoManagementMonitor.ts',
  'src/cweCloseMonitor.ts',
  'src/newsTradingMonitor.ts',
]

const durableArtifactMonitors = [
  'src/partialTpMonitor.ts',
  'src/signalEntryPendingMonitor.ts',
  'src/signalRangeEntryMonitor.ts',
  'src/rangeBrokerPendingMonitor.ts',
  'src/virtualPendingMonitor.ts',
]

test('production management monitors do not require global FXSocket configuration', () => {
  const files = [
    ...brokerResolvedMonitors,
    ...durableArtifactMonitors,
    'src/basketSlTpReconcileMonitor.ts',
    'src/copyLimitMonitor.ts',
  ]
  for (const file of files) {
    assert.equal(source(file).includes('hasFxsocketConfigured('), false, file)
  }
})

test('open-trade, trailing, automatic-management, CWE, and news resolve current broker authority', () => {
  for (const file of brokerResolvedMonitors) {
    const text = source(file)
    assert.match(text, /loadBrokerApiByAccountId/, file)
    assert.match(text, /brokerRuntimeForAccount/, file)
  }
})

test('durable partial and pending artifacts resolve current session by broker_account_id', () => {
  for (const file of durableArtifactMonitors) {
    const text = source(file)
    assert.match(text, /broker_account_id/, file)
    assert.match(text, /resolveDurableBrokerArtifacts|loadBrokerApiByAccountId/, file)
  }
  assert.match(source('src/copyLimitFlatten.ts'), /metaapi_account_id: args\.metaapiAccountId/)
  assert.match(source('src/rangeBrokerPendingHelpers.ts'), /resolveDurableBrokerArtifacts/)
})

test('provider-neutral execution and force-close have no global FXSocket gate', () => {
  const files = [
    'src/forceCloseSignalTrades.ts',
    'src/applySignalOverride.ts',
    'src/channelStopApply.ts',
    'src/tradeExecutor/dispatch.ts',
    'src/tradeExecutor/entryPrepare.ts',
    'src/tradeExecutor/managementExecutor.ts',
    'src/tradeExecutor/brokerSymbolCache.ts',
  ]
  for (const file of files) {
    assert.equal(source(file).includes('hasFxsocketConfigured('), false, file)
  }
})

test('FXSocket streaming and v2 reconcile remain explicitly isolated', () => {
  assert.match(source('src/fxsocketStreamManager.ts'), /FXSOCKET_API_KEY required/)
  assert.match(source('src/engine/v2ReconcileMonitor.ts'), /hasFxsocketConfigured/)
})
