import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mergeSignalsWithOpenFallbacks } from './signalListMerge'

test('mergeSignalsWithOpenFallbacks: appends missing fallbacks after the loaded page', () => {
  const loaded = [{ id: 'new-1' }, { id: 'new-2' }]
  const fallbacks = [{ id: 'open-old' }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, fallbacks)
  assert.deepEqual(merged.map(r => r.id), ['new-1', 'new-2', 'open-old'])
})

test('mergeSignalsWithOpenFallbacks: duplicate ids keep the loaded row', () => {
  const loaded = [{ id: 'sig', v: 1 }]
  const fallbacks = [{ id: 'sig', v: 2 }, { id: 'open-old', v: 3 }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, fallbacks)
  assert.deepEqual(merged, [{ id: 'sig', v: 1 }, { id: 'open-old', v: 3 }])
})

test('mergeSignalsWithOpenFallbacks: empty fallbacks returns loaded rows unchanged', () => {
  const loaded = [{ id: 'a' }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, [])
  assert.deepEqual(merged, [{ id: 'a' }])
  assert.notEqual(merged, loaded)
})

test('mergeSignalsWithOpenFallbacks: all duplicates returns a copy of loaded rows', () => {
  const loaded = [{ id: 'a' }, { id: 'b' }]
  const merged = mergeSignalsWithOpenFallbacks(loaded, [{ id: 'b' }])
  assert.deepEqual(merged, [{ id: 'a' }, { id: 'b' }])
})
