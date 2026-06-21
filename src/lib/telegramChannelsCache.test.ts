import { afterEach, describe, expect, it } from 'vitest'
import {
  getCachedTgChannels,
  invalidateTgChannelsCache,
  setCachedTgChannels,
  type TgChannelListItem,
} from './telegramChannelsCache'

const USER = 'user-1'
const CHANNELS: TgChannelListItem[] = [
  { id: '100', title: 'Signals', username: 'signals', members_count: 1200 },
]

describe('telegramChannelsCache', () => {
  afterEach(() => {
    invalidateTgChannelsCache()
    sessionStorage.clear()
  })

  it('reads channels from sessionStorage when memory is cold', () => {
    sessionStorage.setItem(
      `tscopier:tg-channels:${USER}`,
      JSON.stringify({ channels: CHANNELS, fetchedAt: Date.now() }),
    )

    expect(getCachedTgChannels(USER)).toEqual(CHANNELS)
  })

  it('invalidates sessionStorage for a user', () => {
    setCachedTgChannels(USER, CHANNELS)
    invalidateTgChannelsCache(USER)
    expect(getCachedTgChannels(USER)).toBeNull()
  })
})
