import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isKnownRole,
  parseRole,
  shardForUserId,
  shardForSignalChannelId,
  userBelongsToShard,
  workerRoleFlags,
} from './workerConfig'

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

describe('shardForSignalChannelId', () => {
  it('assigns signal channels to buckets', () => {
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const bucket = shardForSignalChannelId(id, 4)
    assert.ok(bucket >= 0 && bucket < 4)
  })
})

describe('userBelongsToShard', () => {
  it('returns true for all users when shard count is 1', () => {
    assert.equal(userBelongsToShard('any-user-id'), true)
  })
})

describe('parseRole', () => {
  it('accepts discord_listener', () => {
    assert.equal(parseRole('discord_listener'), 'discord_listener')
  })

  it('normalises case and whitespace', () => {
    assert.equal(parseRole('  Discord_Listener '), 'discord_listener')
    assert.equal(parseRole('LISTENER'), 'listener')
  })

  it('falls back to the monolith for empty or unknown roles', () => {
    assert.equal(parseRole(undefined), 'all')
    assert.equal(parseRole(''), 'all')
    assert.equal(parseRole('discord'), 'all')
  })
})

describe('isKnownRole', () => {
  it('accepts every supported role, case and whitespace insensitive', () => {
    for (const role of [
      'all',
      'listener',
      'channel_listener',
      'trade',
      'trade_entry',
      'trade_mgmt',
      'backtest',
      'discord_listener',
    ]) {
      assert.equal(isKnownRole(role), true, role)
      assert.equal(isKnownRole(` ${role.toUpperCase()} `), true, role)
    }
  })

  it('treats an empty role as the default', () => {
    assert.equal(isKnownRole(undefined), true)
    assert.equal(isKnownRole(''), true)
    assert.equal(isKnownRole('   '), true)
  })

  it('rejects near-miss typos instead of silently running the monolith', () => {
    assert.equal(isKnownRole('discord'), false)
    assert.equal(isKnownRole('discord-listener'), false)
    assert.equal(isKnownRole('listner'), false)
  })
})

describe('workerRoleFlags', () => {
  it('starts only the Discord gateway for discord_listener', () => {
    assert.deepEqual(workerRoleFlags('discord_listener'), {
      runsListener: false,
      runsChannelListener: false,
      runsTrade: false,
      runsExecutionMonitors: false,
      runsManagementMonitors: false,
      runsBacktestHttp: false,
      runsDiscordListener: true,
    })
  })

  it('keeps discord_listener out of every Telegram and trade path', () => {
    const flags = workerRoleFlags('discord_listener')
    for (const key of [
      'runsListener',
      'runsChannelListener',
      'runsTrade',
      'runsExecutionMonitors',
      'runsManagementMonitors',
      'runsBacktestHttp',
    ] as const) {
      assert.equal(flags[key], false, `${key} must stay off`)
    }
  })

  it('leaves existing roles unchanged', () => {
    assert.deepEqual(workerRoleFlags('listener'), {
      runsListener: true,
      runsChannelListener: false,
      runsTrade: false,
      runsExecutionMonitors: false,
      runsManagementMonitors: false,
      runsBacktestHttp: false,
      runsDiscordListener: false,
    })
    assert.deepEqual(workerRoleFlags('all'), {
      runsListener: true,
      runsChannelListener: true,
      runsTrade: true,
      runsExecutionMonitors: true,
      runsManagementMonitors: true,
      runsBacktestHttp: true,
      runsDiscordListener: false,
    })
  })
})
