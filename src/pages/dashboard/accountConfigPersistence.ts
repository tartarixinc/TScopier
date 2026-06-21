import { DEFAULT_MANUAL_SETTINGS } from '../../lib/defaultManualSettings'
import { estimateMultiTradeOrderCount } from '../../lib/estimateMultiTradeOrders'
import { resolvePreviewManualLot } from '../../lib/manualLotSizing'
import type { SubscriptionPlan } from '../../lib/planLimits'
import type { ManualSettings } from '../../types/database'

type TradeStyleCarrier = {
  manualSettings?: Pick<
    ManualSettings,
    | 'trade_style'
    | 'risk_mode'
    | 'fixed_lot'
    | 'dynamic_balance_percent'
    | 'multi_trade_leg_percent'
    | 'range_trading'
    | 'range_percent'
    | 'range_step_pips'
    | 'range_distance_pips'
  > | null
}

export function hasRequestedMultiTradeStyle(
  channelIds: string[],
  channelConfigs: Record<string, TradeStyleCarrier | undefined>,
): boolean {
  return channelIds.some(
    id => (channelConfigs[id]?.manualSettings?.trade_style ?? 'single') === 'multi',
  )
}

export function shouldBlockMultiTradeSave(args: {
  requestedMulti: boolean
  effectivePlan: SubscriptionPlan | null
}): boolean {
  return args.requestedMulti && args.effectivePlan !== 'advanced'
}

export function isMultiTradeSplitBlocked(
  manualSettings: TradeStyleCarrier['manualSettings'],
  accountBalance?: number | null,
): boolean {
  if (!manualSettings || manualSettings.trade_style !== 'multi') return false
  const manualLot = resolvePreviewManualLot({
    manualSettings,
    accountBalance,
  })
  const legPct = Number(manualSettings.multi_trade_leg_percent ?? 5) || 5
  const range = manualSettings.range_trading
    ? {
        enabled: true,
        percent: Number(manualSettings.range_percent ?? 50) || 0,
        stepPips: Number(manualSettings.range_step_pips ?? DEFAULT_MANUAL_SETTINGS.range_step_pips) || 0,
        distancePips: Number(manualSettings.range_distance_pips ?? DEFAULT_MANUAL_SETTINGS.range_distance_pips) || 0,
      }
    : undefined
  return estimateMultiTradeOrderCount({ manualLot, legPercent: legPct, range }).fallsBackSingle
}

export function hasBlockedMultiTradeSplit(
  channelIds: string[],
  channelConfigs: Record<string, TradeStyleCarrier | undefined>,
  accountBalance?: number | null,
): boolean {
  return channelIds.some(id => isMultiTradeSplitBlocked(channelConfigs[id]?.manualSettings, accountBalance))
}

export function choosePersistedSelectedChannelId(args: {
  preferredSelectedId: string | null
  persistedChannelIds: string[]
  fallbackSelectedId: string | null
}): string | null {
  if (args.preferredSelectedId && args.persistedChannelIds.includes(args.preferredSelectedId)) {
    return args.preferredSelectedId
  }
  return args.fallbackSelectedId
}
