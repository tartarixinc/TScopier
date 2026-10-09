/** Stable Copier Log reason codes for the copy risk engine. The pipeline is not wired yet. */

export const COPY_RISK_LOG_ACTIONS = ['skip', 'resize', 'pause', 'flatten'] as const

export type CopyRiskLogAction = (typeof COPY_RISK_LOG_ACTIONS)[number]

export const COPY_RISK_REASONS = [
  'copy_risk_ok',
  'copy_risk_no_stop',
  'copy_risk_volume_invalid',
  'copy_risk_missing_source_equity',
  'copy_risk_drawdown',
  'copy_risk_equity_loss',
  'copy_risk_min_equity',
  'copy_risk_daily_loss',
  'copy_risk_weekly_loss',
  'copy_risk_monthly_loss',
  'copy_risk_floating_loss',
  'copy_risk_profit_giveback',
  'copy_risk_profit_lock',
  'copy_risk_daily_profit',
  'copy_risk_consecutive_losses',
  'copy_risk_emergency_stop',
  'copy_risk_emergency_lock',
  'copy_risk_disconnect_timeout',
  'copy_risk_disconnected',
  'copy_risk_stale_data',
  'copy_paused',
  'copy_risk_direction',
  'copy_risk_order_type',
  'copy_risk_source_volume',
  'copy_risk_spread',
  'copy_risk_entry_deviation',
  'copy_risk_price_move',
  'copy_risk_signal_age',
  'copy_risk_position_age',
  'copy_risk_duplicate',
  'copy_risk_already_a_copy',
  'copy_risk_copy_frequency',
  'copy_risk_min_gap',
  'copy_risk_stop_distance',
  'copy_risk_reward_risk',
  'symbol_not_in_whitelist',
  'symbol_excluded',
  'copy_risk_symbol_unmapped',
  'copy_risk_deviation',
  'copy_risk_latency',
  'copy_risk_trading_disabled',
  'copy_risk_margin',
  'copy_risk_utilization',
  'copy_risk_provider_suspended',
  'copy_risk_allow_following',
  'copy_risk_provider_loss',
  'copy_risk_provider_drawdown',
  'copy_risk_provider_daily_trades',
  'copy_risk_provider_positions',
  'copy_risk_provider_lots',
  'copy_risk_provider_consecutive_losses',
  'copy_risk_execution_failures',
  'copy_risk_slippage_breaker',
  'copy_risk_exposure',
  'copy_risk_resized_exposure',
  'copy_risk_resized_budget',
  'copy_risk_auto_reduced',
  'copy_risk_resized_lot',
] as const

export type CopyRiskReason = (typeof COPY_RISK_REASONS)[number]

export interface CopyRiskLogEvent {
  reason_code: CopyRiskReason
  action: CopyRiskLogAction | 'allow'
  pause: boolean
}

/** Payload a future copier log row stores when this engine skips, resizes, pauses, or flattens. */
export function copyRiskLogEvent(decision: {
  action: CopyRiskLogAction | 'allow'
  reason: CopyRiskReason
  pause?: boolean
}): CopyRiskLogEvent {
  return {
    reason_code: decision.reason,
    action: decision.action,
    pause: decision.pause === true,
  }
}

export const COPY_RISK_REASON_LABELS: Record<CopyRiskReason, string> = {
  copy_risk_ok: 'Copied',
  copy_risk_no_stop: 'No stop-loss on this trade',
  copy_risk_volume_invalid: 'Lot size is outside the allowed range',
  copy_risk_missing_source_equity: 'Source balance missing, used fixed lot',
  copy_risk_drawdown: 'Account drawdown limit reached',
  copy_risk_equity_loss: 'Equity loss limit reached',
  copy_risk_min_equity: 'Equity is below the minimum',
  copy_risk_daily_loss: 'Daily loss limit reached',
  copy_risk_weekly_loss: 'Weekly loss limit reached',
  copy_risk_monthly_loss: 'Monthly loss limit reached',
  copy_risk_floating_loss: 'Floating loss limit reached',
  copy_risk_profit_giveback: 'Floating profit giveback limit reached',
  copy_risk_profit_lock: 'Profit target lock reached',
  copy_risk_daily_profit: 'Daily profit target reached',
  copy_risk_consecutive_losses: 'Consecutive loss limit reached',
  copy_risk_emergency_stop: 'Emergency stop',
  copy_risk_emergency_lock: 'Emergency account lock',
  copy_risk_disconnect_timeout: 'Disconnected for too long',
  copy_risk_disconnected: 'Source or follower is disconnected',
  copy_risk_stale_data: 'Quote or account data is stale',
  copy_paused: 'Copying is paused',
  copy_risk_direction: 'Trade direction is filtered',
  copy_risk_order_type: 'Order type is filtered',
  copy_risk_source_volume: 'Source volume is outside the filter',
  copy_risk_spread: 'Spread is too wide',
  copy_risk_entry_deviation: 'Price moved too far from the source entry',
  copy_risk_price_move: 'Price moved beyond the filter',
  copy_risk_signal_age: 'Signal is too old',
  copy_risk_position_age: 'Source position is already too old',
  copy_risk_duplicate: 'This source trade was already copied',
  copy_risk_already_a_copy: 'Source trade is already a copied position',
  copy_risk_copy_frequency: 'Copy frequency limit reached',
  copy_risk_min_gap: 'Minimum time between copies has not elapsed',
  copy_risk_stop_distance: 'Stop distance is outside the allowed range',
  copy_risk_reward_risk: 'Reward to risk is outside the allowed range',
  symbol_not_in_whitelist: 'Symbol not allowed',
  symbol_excluded: 'Symbol excluded',
  copy_risk_symbol_unmapped: 'Symbol could not be mapped',
  copy_risk_deviation: 'Execution price deviated too far',
  copy_risk_latency: 'Copy latency is too high',
  copy_risk_trading_disabled: 'Trading is disabled on this account',
  copy_risk_margin: 'Not enough free margin',
  copy_risk_utilization: 'Account utilization limit reached',
  copy_risk_provider_suspended: 'This provider is suspended',
  copy_risk_allow_following: 'This trader is not allowing followers',
  copy_risk_provider_loss: 'Provider loss limit reached',
  copy_risk_provider_drawdown: 'Provider drawdown limit reached',
  copy_risk_provider_daily_trades: 'Provider daily trade limit reached',
  copy_risk_provider_positions: 'Provider open position limit reached',
  copy_risk_provider_lots: 'Provider lot limit reached',
  copy_risk_provider_consecutive_losses: 'Provider consecutive loss limit reached',
  copy_risk_execution_failures: 'Execution failed too many times',
  copy_risk_slippage_breaker: 'Slippage limit paused copying',
  copy_risk_exposure: 'Account exposure limit reached',
  copy_risk_resized_exposure: 'Lot reduced to fit the exposure limit',
  copy_risk_resized_budget: 'Lot reduced to fit the risk budget',
  copy_risk_auto_reduced: 'Lot reduced as a limit was approached',
  copy_risk_resized_lot: 'Lot adjusted to the size limits',
}
