import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  countFreshListenerLeasesForUsers,
  isLeaseRowLive,
} from './sessionLease'

describe('sessionLease health helpers', () => {
  it('isLeaseRowLive accepts listener and all roles with future expiry', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    assert.equal(isLeaseRowLive({ expires_at: future, role: 'listener' }), true)
    assert.equal(isLeaseRowLive({ expires_at: future, role: 'all' }), true)
  })

  it('isLeaseRowLive rejects expired or wrong role', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    assert.equal(isLeaseRowLive({ expires_at: past, role: 'listener' }), false)
    assert.equal(isLeaseRowLive({ expires_at: past, role: 'trade' }), false)
    assert.equal(isLeaseRowLive(null), false)
  })

  it('countFreshListenerLeasesForUsers reports missing users', async () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    const supabase = {
      from: () => ({
        select: () => ({
          in: async () => ({
            data: [{ user_id: 'user-a', expires_at: future, role: 'listener' }],
          }),
        }),
      }),
    }

    const result = await countFreshListenerLeasesForUsers(
      supabase as never,
      ['user-a', 'user-b'],
    )
    assert.equal(result.fresh, 1)
    assert.deepEqual(result.missingUserIds, ['user-b'])
  })
})
