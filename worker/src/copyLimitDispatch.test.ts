import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateChannelCopyLimitPauseForBroker } from './copyLimitDispatch'
import { pauseKey } from './copyLimitTypes'
import { periodKeyFor } from './copyLimitPeriods'
import type { BrokerRow } from './tradeExecutor/types'

describe('copyLimitDispatch', () => {
  it('pauses entries when copy limit state is active', () => {
    const at = new Date()
    const channelId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const pk = periodKeyFor('daily', 'UTC', at)
    const broker = {
      id: 'broker-1',
      user_id: 'user-1',
      is_active: true,
      metaapi_account_id: 'uuid-1',
      platform: 'mt5',
      signal_channel_ids: [channelId],
      enforce_signal_channel_filter: true,
      channel_trading_configs: {
        [channelId]: {
          copier_mode: 'manual',
          manual_settings: {
            fixed_lot: 0.01,
            trade_style: 'single',
            copy_limits: {
              profit_targets_enabled: true,
              profit_targets: [{
                id: 't1',
                enabled: true,
                period: 'daily',
                value_type: 'amount',
                value: 100,
              }],
              max_risk_enabled: false,
              timezone_mode: 'profile',
            },
          },
          copy_limit_state: {
            paused_period_keys: [pauseKey('profit', 'daily', pk, 't1')],
            periods: {},
          },
        },
      },
    } as unknown as BrokerRow

    const result = evaluateChannelCopyLimitPauseForBroker(broker, channelId, 'UTC')
    assert.equal(result.paused, true)
    assert.equal(result.reason, 'channel_profit_target_hit')
  })
})
