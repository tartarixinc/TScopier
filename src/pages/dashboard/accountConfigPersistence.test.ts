import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import {
  choosePersistedSelectedChannelId,
  hasBlockedMultiTradeSplit,
  hasRequestedMultiTradeStyle,
  isMultiTradeSplitBlocked,
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

test('isMultiTradeSplitBlocked when total lot is below broker min preview', () => {
  assert.equal(
    isMultiTradeSplitBlocked({
      trade_style: 'multi',
      risk_mode: 'fixed_lot',
      fixed_lot: 0.005,
      multi_trade_leg_percent: 5,
    }),
    true,
  )
  assert.equal(
    isMultiTradeSplitBlocked({
      trade_style: 'multi',
      risk_mode: 'fixed_lot',
      fixed_lot: 1,
      multi_trade_leg_percent: 5,
    }),
    false,
  )
  assert.equal(
    isMultiTradeSplitBlocked({
      trade_style: 'single',
      risk_mode: 'fixed_lot',
      fixed_lot: 0.005,
      multi_trade_leg_percent: 5,
    }),
    false,
  )
})

test('hasBlockedMultiTradeSplit scans all linked channels', () => {
  const channelIds = ['a', 'b']
  const channelConfigs = {
    a: { manualSettings: { trade_style: 'multi', fixed_lot: 1, multi_trade_leg_percent: 5 } },
    b: { manualSettings: { trade_style: 'multi', fixed_lot: 0.005, multi_trade_leg_percent: 5 } },
  }
  assert.equal(hasBlockedMultiTradeSplit(channelIds, channelConfigs), true)
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
