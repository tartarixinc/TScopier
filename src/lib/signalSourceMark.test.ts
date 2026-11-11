import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resolveSignalSourceKind } from './signalSourceMark'

test('resolveSignalSourceKind prefers denormalized source_kind after channel delete', () => {
  assert.equal(
    resolveSignalSourceKind({
      channel_id: null,
      source_kind: 'tradingview',
      parsed_data: null,
    }),
    'tradingview',
  )
  assert.equal(
    resolveSignalSourceKind({
      channel_id: null,
      source_kind: 'discord',
      parsed_data: null,
    }),
    'discord',
  )
})

test('resolveSignalSourceKind falls back to live channel map then parsed_data then telegram', () => {
  assert.equal(
    resolveSignalSourceKind(
      { channel_id: 'ch-1', source_kind: null, parsed_data: null },
      { 'ch-1': 'whatsapp' },
    ),
    'whatsapp',
  )
  assert.equal(
    resolveSignalSourceKind({
      channel_id: null,
      source_kind: null,
      parsed_data: { signal_source: 'tradingview' },
    }),
    'tradingview',
  )
  assert.equal(
    resolveSignalSourceKind({
      channel_id: null,
      source_kind: null,
      parsed_data: { action: 'sell' },
    }),
    'telegram',
  )
})
