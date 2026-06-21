import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pickSignalByIdPrefix } from './tradeSignalLink'
import type { Signal } from '../types/database'

function sig(id: string, createdAt = '2026-06-08T12:00:00Z'): Signal {
  return {
    id,
    user_id: 'user-1',
    channel_id: 'ch-1',
    raw_message: 'test',
    parsed_data: {},
    status: 'executed',
    created_at: createdAt,
  } as Signal
}

describe('pickSignalByIdPrefix', () => {
  it('returns null for invalid prefix', () => {
    assert.equal(pickSignalByIdPrefix([sig('abc12345-0000-4000-8000-000000000001')], 'abc'), null)
  })

  it('matches single candidate', () => {
    const hit = pickSignalByIdPrefix(
      [sig('abc12345-0000-4000-8000-000000000001')],
      'abc12345',
    )
    assert.equal(hit?.id, 'abc12345-0000-4000-8000-000000000001')
  })

  it('prefers trade-referenced signal when ambiguous', () => {
    const a = sig('abc12345-1111-4000-8000-000000000001', '2026-06-08T10:00:00Z')
    const b = sig('abc12345-2222-4000-8000-000000000002', '2026-06-08T12:00:00Z')
    const hit = pickSignalByIdPrefix([a, b], 'abc12345', b.id)
    assert.equal(hit?.id, b.id)
  })

  it('falls back to newest-first ordering when no trade ref', () => {
    const a = sig('abc12345-1111-4000-8000-000000000001', '2026-06-08T12:00:00Z')
    const b = sig('abc12345-2222-4000-8000-000000000002', '2026-06-08T10:00:00Z')
    const hit = pickSignalByIdPrefix([a, b], 'abc12345')
    assert.equal(hit?.id, a.id)
  })
})
