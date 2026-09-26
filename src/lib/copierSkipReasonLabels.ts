/** Default English labels when a locale bundle omits a skip-reason key (shallow locale merge). */
import { normalizeCopierSkipReasonKey } from './brokerBridgeErrorDisplay'

export function resolveCopierSkipReasonKey(reason: string | null | undefined): string {
  const raw = String(reason ?? '').trim()
  if (!raw) return ''
  if (/invalid\s+stops/i.test(raw)) return 'invalid_stops'
  if (/invalid\s+s\/l/i.test(raw)) return 'invalid_stops'
  const normalized = normalizeCopierSkipReasonKey(raw)
  return normalized.replace(/[\s-]+/g, '_')
}

export const COPIER_SKIP_REASON_LABELS: Record<string, string> = {
  ai_classified_as_non_actionable: 'AI found no trade signal in this message',
  ai_classified_as_non_entry: 'AI found no entry instruction in this message',
  modification_no_open_trade: 'No open trade to modify',
  entry_price_moved_adverse: 'Price moved past the entry before the order was placed',
  ai_classified_as_uncertain_human_review_required: 'AI was uncertain — review before trading',
  ai_review_expired: 'Review window expired',
  ai_review_price_passed: 'Price moved outside the review entry range',
  invalid_stops: 'Broker rejected stop levels',
  entry_not_opened: 'No position opened',
  entry_zone_far_from_market: 'Entry too far from market',
  broker_session_not_connected: 'Broker not connected',
  broker_bridge_unavailable: 'Broker bridge unavailable',
  broker_reactivated_after_signal: 'Signal arrived while broker was offline',
  channel_max_risk_hit: 'Daily risk limit reached',
  channel_profit_target_hit: 'Daily profit target reached',
  channel_config_missing: 'Channel not configured',
  channel_config_incomplete: 'Channel settings incomplete',
  channel_filter_ignored: 'Ignored by channel filter',
  no_broker_channel_match: 'No broker linked to channel',
  copier_paused: 'Copier is paused',
  telegram_listener_not_live: 'Telegram not connected',
  subscription_inactive: 'Subscription inactive',
  plan_advanced_feature_required: 'Plan upgrade required',
  entry_not_execution_eligible: 'Signal not eligible to trade',
  duplicate_provider_signal: 'Duplicate signal',
  explicit_stops_required_when_add_to_existing_off: 'SL/TP required for this channel mode',
  entry_tp_without_sl: 'SL not given — set predefined SL pips in broker configuration',
  signal_missing_required_sl: 'SL not given — set predefined SL pips in broker configuration',
  basket_modify_failed: 'Could not update open trades',
  parameter_follow_up_no_open_basket: 'No open trade to update',
  delete_pendings_no_parent: 'Original trade not found for this reply',
  delete_pendings_requires_reply: 'Must be a reply to the original signal',
  delete_pendings_none: 'No pending orders to cancel',
  mgmt_no_open_trades: 'No matching open trade',
  mgmt_no_open_trades_db: 'No open trade in copier',
  mgmt_no_open_trades_broker: 'No open position on broker',
  mgmt_no_open_trades_symbol: 'Symbol did not match open legs',
  no_matching_open_trade: 'No matching open trade',
  symbol_not_in_whitelist: 'Symbol not allowed',
  symbol_excluded: 'Symbol excluded',
  symbol_exempted_from_trading: 'Symbol exempted',
  close_worse_entries_disabled: 'Close worse entries disabled',
  message_revision_direction_flip_close_failed: 'Could not close for direction flip',
  message_revision_direction_flip_closed: 'Closed after direction change',
}

export const COPIER_SKIP_REASON_DETAILS: Record<string, string> = {
  invalid_stops:
    'The broker rejected the SL/TP on this order. This often happens when price moved before the order filled, or stops were on the wrong side of market. Check that SL/TP still make sense at the fill price.',
  entry_not_opened:
    'The copier processed this signal but the broker did not open a position. This can happen when entry filters block the trade or the broker rejects the order.',
  entry_zone_far_from_market:
    'The signal entry zone was too far from the current market price based on your pip tolerance settings.',
  broker_session_not_connected:
    'Your broker account was not connected when this signal was processed. Open Account Configuration and reconnect the account.',
  broker_bridge_unavailable:
    'The MT5 bridge was unavailable. Enable Algo Trading on MT5, keep the terminal running, and confirm Trade EA ready is green in Account Configuration.',
  broker_reactivated_after_signal:
    'This signal arrived while the broker was disabled or reconnecting. New signals after reconnect are copied normally; this one was not replayed automatically.',
  channel_max_risk_hit:
    'This channel reached its configured max daily risk limit. Copying is paused until the limit resets (usually at midnight in your profile timezone) or you raise the limit in Account Configuration.',
  channel_profit_target_hit:
    'This channel reached its configured daily profit target. Copying is paused until the limit resets or you adjust the target in Account Configuration.',
  channel_config_missing:
    'This Telegram channel has no saved trading settings. Open Account Configuration, select the channel, set lot size and trade style, then Save.',
  channel_config_incomplete:
    'Saved settings for this channel are incomplete. Open Account Configuration and finish lot size, trade style, and channel selection.',
  channel_filter_ignored:
    'This message matched an Ignore or Skip keyword configured for the channel in Account Configuration.',
  no_broker_channel_match:
    'No active broker account is linked to this channel. Open Account Configuration → select your broker → Channels tab → enable this channel → Save.',
  copier_paused:
    'Signal copying is paused for your account. Resume the copier from the dashboard or Copier Engine.',
  telegram_listener_not_live:
    'Telegram was not connected when this signal arrived. Open Copier Engine and reconnect Telegram.',
  subscription_inactive:
    'Your subscription is inactive. Renew your plan to resume signal copying.',
  plan_advanced_feature_required:
    'This feature requires a higher plan. Upgrade in Billing to enable it.',
  entry_not_execution_eligible:
    'The message was parsed but did not meet execution rules (for example missing NOW, SL, or TP cues for this channel).',
  duplicate_provider_signal:
    'The same provider signal was already processed recently and was not copied again.',
  explicit_stops_required_when_add_to_existing_off:
    'This channel uses single-slot mode (Add to Existing Trades off). New entries must include labeled SL and TP in the message.',
  entry_tp_without_sl:
    'The signal had take-profit(s) but no stop loss. Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can place the trade.',
  signal_missing_required_sl:
    'The signal did not include a usable stop loss. Enable Override signal SL and set Stop loss (pips from entry) in Account Configuration so the copier can still place the trade.',
  basket_modify_failed:
    'The signal was received but updating SL/TP on open trades failed. Check open positions and broker connection.',
  parameter_follow_up_no_open_basket:
    'This looked like an SL/TP update but there was no open trade from this channel to modify.',
  delete_pendings_no_parent:
    'This message was sent as a reply, but the original signal it references was not found in the copier. Reply to the exact original signal message to cancel its pending orders.',
  delete_pendings_requires_reply:
    'Cancel-pending instructions must be sent as a reply to the original signal message, not as a standalone message.',
  delete_pendings_none:
    'The copier understood the cancel-pending instruction, but there were no pending orders to cancel for this trade.',
  mgmt_no_open_trades:
    'This management instruction (close, modify, breakeven, etc.) did not match any open trade from this channel.',
  mgmt_no_open_trades_db:
    'The copier had no open trade record for this channel when the management message arrived.',
  mgmt_no_open_trades_broker:
    'There was no open position on the broker for this channel when the management message arrived.',
  mgmt_no_open_trades_symbol:
    'The symbol on the management message did not match any open leg for this channel.',
  no_matching_open_trade:
    'No open trade matched this follow-up instruction.',
  symbol_not_in_whitelist:
    'This symbol is not in the allowed list for the broker or channel.',
  symbol_excluded:
    'This symbol is excluded from copying in your settings.',
  symbol_exempted_from_trading:
    'This symbol is exempt from automated trading on this account.',
  close_worse_entries_disabled:
    'Close worse entries is disabled in your channel or account settings.',
  message_revision_direction_flip_close_failed:
    'Telegram edited the signal to flip buy/sell but closing the existing basket failed.',
  message_revision_direction_flip_closed:
    'Telegram edited the signal to flip direction; open trades were closed and no new entry was placed.',
}
