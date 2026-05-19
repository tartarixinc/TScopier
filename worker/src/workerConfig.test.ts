import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shardForUserId, userBelongsToShard } from './workerConfig'

describe('shardForUserId', () => {
  it('assigns every user to exactly one bucket', () => {
    const users = ['a', 'b', 'c', 'user-111', 'user-222']
    const count = 4
    for (const id of users) {
      const bucket = shardForUserId(id, count)
      assert.ok(bucket >= 0 && bucket < count, `bucket in range for ${id}`)
      let hits = 0
      for (let shard = 0; shard < count; shard++) {
        if (shardForUserId(id, count) === shard) hits++
      }
      assert.equal(hits, 1)
    }
  })
})

describe('userBelongsToShard', () => {
  it('returns true for all users when shard count is 1', () => {
    assert.equal(userBelongsToShard('any-user-id'), true)
  })
})
