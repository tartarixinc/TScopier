import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBrokerChannelTradingConfigRow,
  channelTradingConfigsMapFromRows,
} from './brokerChannelTradingConfigs'

test('applyBrokerChannelTradingConfigRow: table row overrides stale jsonb channel config', () => {
  const channelId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
  const broker = {
    id: 'broker-1',
    channel_trading_configs: {
      [channelId]: {
        copier_mode: 'manual',
        manual_settings: {
          fixed_lot: 5,
          trade_style: 'multi',
          range_trading: false,
          multi_trade_leg_percent: 7,
        },
      },
    },
  }

  const merged = applyBrokerChannelTradingConfigRow(broker, {
    broker_account_id: 'broker-1',
    channel_id: channelId,
    copier_mode: 'manual',
    manual_settings: {
      fixed_lot: 5,
      trade_style: 'multi',
      range_trading: true,
      range_percent: 50,
      range_step_pips: 3,
      range_distance_pips: 30,
      multi_trade_leg_percent: 7,
      multi_trade_max_orders: 15,
    },
    ai_settings: {},
  })

  const cfg = channelTradingConfigsMapFromRows([
    {
      broker_account_id: 'broker-1',
      channel_id: channelId,
      copier_mode: 'manual',
      manual_settings: (merged.channel_trading_configs as Record<string, { manual_settings: Record<string, unknown> }>)[channelId.toLowerCase()]!.manual_settings,
      ai_settings: {},
    },
  ])[channelId.toLowerCase()]!

  assert.equal(cfg.manual_settings?.range_trading, true)
  assert.equal(cfg.manual_settings?.multi_trade_max_orders, 15)
})
