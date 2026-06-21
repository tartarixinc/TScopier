import { describe, expect, it } from 'vitest'
import {
  filterChannelIdsToActiveOptions,
  restrictChannelTradingConfigsMap,
} from './channelTradingConfig'

describe('filterChannelIdsToActiveOptions', () => {
  it('matches channel ids case-insensitively', () => {
    const filtered = filterChannelIdsToActiveOptions(
      ['CHANNEL-A'],
      [{ id: 'channel-a' }],
    )
    expect(filtered).toEqual(['channel-a'])
  })
})

describe('restrictChannelTradingConfigsMap', () => {
  it('drops stale JSONB keys not in linked channel ids', () => {
    const restricted = restrictChannelTradingConfigsMap(
      {
        'channel-a': { copier_mode: 'manual', manual_settings: { fixed_lot: 1, trade_style: 'single' } },
        'deleted-channel': { copier_mode: 'manual', manual_settings: { fixed_lot: 2, trade_style: 'single' } },
      },
      ['channel-a'],
    )
    expect(Object.keys(restricted)).toEqual(['channel-a'])
    expect(restricted['channel-a']?.manual_settings?.fixed_lot).toBe(1)
  })

  it('normalizes channel id casing when filtering', () => {
    const restricted = restrictChannelTradingConfigsMap(
      {
        'CHANNEL-A': { copier_mode: 'manual', manual_settings: { fixed_lot: 1, trade_style: 'single' } },
      },
      ['channel-a'],
    )
    expect(Object.keys(restricted)).toEqual(['channel-a'])
  })
})
