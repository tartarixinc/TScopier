import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { periodKeyFor, pruneExpiredPauseKeys } from './copyLimitPeriods'
import { pauseKey } from './copyLimitTypes'

describe('copyLimitPeriods', () => {
  it('builds daily period key in timezone', () => {
    const at = new Date('2026-06-08T15:00:00.000Z')
    assert.equal(periodKeyFor('daily', 'America/New_York', at), '2026-06-08')
  })

  it('prunes expired daily pause keys on new day', () => {
    const at = new Date('2026-06-09T12:00:00.000Z')
    const keys = [
      pauseKey('profit', 'daily', '2026-06-08', 't1'),
      pauseKey('risk', 'weekly', '2026-W23'),
      pauseKey('profit', 'overall', 'all', 't2'),
    ]
    const kept = pruneExpiredPauseKeys(keys, 'UTC', at)
    assert.equal(kept.includes(pauseKey('profit', 'overall', 'all', 't2')), true)
    assert.equal(kept.some(k => k.includes('2026-06-08')), false)
  })
})
