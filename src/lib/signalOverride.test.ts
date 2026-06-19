import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildOpenSignalIdSet,
  effectiveParsedData,
  isEditableEntrySignal,
  mergeSignalUserOverride,
  parseUserOverride,
  resolveSignalOpenStatus,
  validateOverrideLevels,
} from './signalOverride'

test('parseUserOverride normalizes sl/tp', () => {
  assert.deepEqual(parseUserOverride({ sl: 4159, tp: [4150, 0, 4148] }), {
    sl: 4159,
    tp: [4150, 4148],
    updated_at: undefined,
  })
})

test('mergeSignalUserOverride overlay replaces channel parse', () => {
  const parsed = { action: 'sell', symbol: 'XAUUSD', sl: 4165, tp: [4155, 4150] }
  const merged = mergeSignalUserOverride(parsed, { sl: 4159, tp: [4150, 4148, 4146] }, { overlay: true })
  assert.equal(merged.sl, 4159)
  assert.deepEqual(merged.tp, [4150, 4148, 4146])
  assert.equal(parsed.sl, 4165)
})

test('effectiveParsedData merges user_override over parsed_data', () => {
  const effective = effectiveParsedData({
    parsed_data: { action: 'buy', sl: 100, tp: [110] },
    user_override: { sl: 99, tp: [111, 112], updated_at: '2026-06-17T12:00:00.000Z' },
  })
  assert.equal(effective.sl, 99)
  assert.deepEqual(effective.tp, [111, 112])
})

test('isEditableEntrySignal accepts buy/sell with channel', () => {
  assert.equal(isEditableEntrySignal({ channel_id: 'ch1', parsed_data: { action: 'buy' } }), true)
  assert.equal(isEditableEntrySignal({ channel_id: 'ch1', parsed_data: { action: 'modify' } }), false)
  assert.equal(isEditableEntrySignal({ channel_id: null, parsed_data: { action: 'buy' } }), false)
})

test('resolveSignalOpenStatus uses open trade anchor set', () => {
  const openIds = buildOpenSignalIdSet([{ signal_id: 'sig-a' }, { signal_id: 'sig-b' }])
  assert.equal(resolveSignalOpenStatus({ id: 'sig-a', channel_id: 'ch1', created_at: '2026-06-19T18:00:00.000Z', parsed_data: { action: 'sell' }, parent_signal_id: null, raw_message: '' }, openIds), 'open')
  assert.equal(resolveSignalOpenStatus({ id: 'sig-c', channel_id: 'ch1', created_at: '2026-06-19T18:00:00.000Z', parsed_data: { action: 'sell' }, parent_signal_id: null, raw_message: '' }, openIds), 'closed')
})

test('resolveSignalOpenStatus: modify follows open entry on same channel', () => {
  const openIds = buildOpenSignalIdSet([{ signal_id: 'entry-sell' }])
  const batch = [
    {
      id: 'entry-sell',
      channel_id: 'ch1',
      created_at: '2026-06-19T18:27:00.000Z',
      parsed_data: { action: 'sell', symbol: 'BTCUSD' },
      parent_signal_id: null,
      raw_message: '',
    },
    {
      id: 'modify-1',
      channel_id: 'ch1',
      created_at: '2026-06-19T18:29:00.000Z',
      parsed_data: { action: 'modify', symbol: 'BTCUSD' },
      parent_signal_id: null,
      raw_message: '',
    },
  ] as const
  assert.equal(
    resolveSignalOpenStatus(batch[1], openIds, { batchSignals: [...batch] }),
    'open',
  )
})

test('resolveSignalOpenStatus: modify via parent_signal_id chain', () => {
  const openIds = buildOpenSignalIdSet([{ signal_id: 'entry-sell' }])
  assert.equal(
    resolveSignalOpenStatus(
      {
        id: 'modify-1',
        channel_id: 'ch1',
        created_at: '2026-06-19T18:29:00.000Z',
        parsed_data: { action: 'modify' },
        parent_signal_id: 'entry-sell',
        raw_message: '',
      },
      openIds,
      { batchSignals: [{ id: 'modify-1', channel_id: 'ch1', created_at: '2026-06-19T18:29:00.000Z', parsed_data: { action: 'modify' }, parent_signal_id: 'entry-sell', raw_message: '' }] },
    ),
    'open',
  )
})

test('validateOverrideLevels requires positive sl or tp', () => {
  assert.equal(validateOverrideLevels({ sl: 4159, tpLevels: [] }), true)
  assert.equal(validateOverrideLevels({ sl: null, tpLevels: [4150] }), true)
  assert.equal(validateOverrideLevels({ sl: null, tpLevels: [] }), false)
  assert.equal(validateOverrideLevels({ sl: -1, tpLevels: [] }), false)
})
