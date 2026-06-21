import { isChannelCopyLimitPaused, resolveCopyLimitTimezone } from './copyLimitEvaluate'
import { normalizeCopyLimitState, normalizeCopyLimits } from './copyLimitTypes'
import type { BrokerRow } from './tradeExecutor/types'
import {
  healChannelTradingConfigsMap,
  resolveChannelConfigEntry,
  resolveChannelTradingConfig,
} from './channelTradingConfig'
import { normalizeChannelUuid } from './channelTradingConfig'

export type CopyLimitPauseCheck = {
  paused: boolean
  reason?: 'channel_profit_target_hit' | 'channel_max_risk_hit'
  pauseKey?: string
}

export function evaluateChannelCopyLimitPauseForBroker(
  broker: BrokerRow,
  channelId: string | null | undefined,
  profileTimezone?: string | null,
  stateOverride?: ReturnType<typeof normalizeCopyLimitState>,
): CopyLimitPauseCheck {
  if (!channelId) return { paused: false }

  const configs = healChannelTradingConfigsMap(broker)
  const channelKey = normalizeChannelUuid(channelId)
  const channelEntry = channelKey ? resolveChannelConfigEntry(configs, channelKey) : undefined
  const resolved = resolveChannelTradingConfig(broker, channelId)
  const manualFromChannel = channelEntry?.manual_settings as Record<string, unknown> | undefined
  const manualFromResolved = resolved.manual_settings ?? {}
  const copyLimits = normalizeCopyLimits(
    manualFromChannel?.copy_limits ?? (manualFromResolved as Record<string, unknown>).copy_limits,
  )
  const state = stateOverride ?? normalizeCopyLimitState(channelEntry?.copy_limit_state)

  const timeZone = resolveCopyLimitTimezone(copyLimits, profileTimezone)
  const breach = isChannelCopyLimitPaused({
    config: copyLimits,
    state,
    timeZone,
  })

  if (!breach) return { paused: false }
  return {
    paused: true,
    reason: breach.reason,
    pauseKey: breach.pauseKey,
  }
}
