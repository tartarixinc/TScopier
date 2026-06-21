import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  choosePersistedSelectedChannelId,
  hasRequestedMultiTradeStyle,
  shouldBlockMultiTradeSave,
} from './accountConfigPersistence'

test('hasRequestedMultiTradeStyle detects any selected multi style', () => {
  const channelIds = ['a', 'b']
  const channelConfigs = {
    a: { manualSettings: { trade_style: 'single' } },
    b: { manualSettings: { trade_style: 'multi' } },
  }
  assert.equal(hasRequestedMultiTradeStyle(channelIds, channelConfigs), true)
})

test('shouldBlockMultiTradeSave blocks unresolved plan for multi', () => {
  assert.equal(
    shouldBlockMultiTradeSave({ requestedMulti: true, effectivePlan: null }),
    true,
  )
  assert.equal(
    shouldBlockMultiTradeSave({ requestedMulti: true, effectivePlan: 'basic' }),
    true,
  )
  assert.equal(
    shouldBlockMultiTradeSave({ requestedMulti: true, effectivePlan: 'advanced' }),
    false,
  )
})

test('choosePersistedSelectedChannelId keeps selected channel when still linked', () => {
  assert.equal(
    choosePersistedSelectedChannelId({
      preferredSelectedId: 'ch-2',
      persistedChannelIds: ['ch-1', 'ch-2'],
      fallbackSelectedId: 'ch-1',
    }),
    'ch-2',
  )
})

test('choosePersistedSelectedChannelId falls back when selected channel was removed', () => {
  assert.equal(
    choosePersistedSelectedChannelId({
      preferredSelectedId: 'ch-9',
      persistedChannelIds: ['ch-1', 'ch-2'],
      fallbackSelectedId: 'ch-1',
    }),
    'ch-1',
  )
})
