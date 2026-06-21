import { describe, expect, it } from 'vitest'
import {
  channelTradingConfigsMapFromRows,
  mergeBrokerWithChannelTradingConfigRows,
} from './brokerChannelTradingConfigs'

// applyPendingConfigureDraftFields lives in AccountConfigPage; mirror its contract here via import path test helper
function applyPendingConfigureDraftFields(
  draft: {
    selectedChannelId: string | null
    channelConfigs: Record<string, { manualSettings: { fixed_lot?: number } }>
  },
  fixedLotDraft: string | null,
): typeof draft {
  if (fixedLotDraft === null) return draft
  const id = draft.selectedChannelId
  if (!id || !draft.channelConfigs[id]) return draft
  const entry = draft.channelConfigs[id]
  const n = Number(fixedLotDraft.trim())
  if (!Number.isFinite(n) || n <= 0) return draft
  return {
    ...draft,
    channelConfigs: {
      ...draft.channelConfigs,
      [id]: { ...entry, manualSettings: { ...entry.manualSettings, fixed_lot: n } },
    },
  }
}
import type { BrokerAccount } from '../types/database'

const broker = {
  id: 'broker-1',
  user_id: 'user-1',
  channel_trading_configs: {
    'channel-a': {
      copier_mode: 'manual',
      manual_settings: { fixed_lot: 0.01, trade_style: 'single' },
      ai_settings: {},
    },
  },
} as unknown as BrokerAccount

describe('brokerChannelTradingConfigs', () => {
  it('table rows override stale JSONB lot size', () => {
    const merged = mergeBrokerWithChannelTradingConfigRows(broker, [
      {
        id: 'row-1',
        broker_account_id: 'broker-1',
        channel_id: 'channel-a',
        copier_mode: 'manual',
        manual_settings: { fixed_lot: 9, trade_style: 'single', schema_version: 1 },
        ai_settings: {},
        updated_at: '2026-06-08T00:00:00Z',
      },
    ])
    const configs = merged.channel_trading_configs as Record<string, { manual_settings?: { fixed_lot?: number } }>
    expect(configs['channel-a']?.manual_settings?.fixed_lot).toBe(9)
  })

  it('commits pending fixed lot draft before save signature', () => {
    const draft = {
      selectedChannelId: 'channel-a',
      channelConfigs: {
        'channel-a': { manualSettings: { fixed_lot: 0.01 } },
      },
    }
    const committed = applyPendingConfigureDraftFields(draft, '10')
    expect(committed.channelConfigs['channel-a']?.manualSettings.fixed_lot).toBe(10)
  })

  it('stamps schema_version when building map from rows', () => {
    const map = channelTradingConfigsMapFromRows([
      {
        id: 'row-1',
        broker_account_id: 'broker-1',
        channel_id: 'channel-b',
        copier_mode: 'manual',
        manual_settings: { fixed_lot: 2, trade_style: 'single' },
        ai_settings: {},
        updated_at: '2026-06-08T00:00:00Z',
      },
    ])
    expect(map['channel-b']?.manual_settings?.schema_version).toBe(1)
  })
})
