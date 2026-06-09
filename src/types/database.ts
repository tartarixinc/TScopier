export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      broker_accounts: {
        Row: BrokerAccount
        Insert: Omit<BrokerAccount, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<BrokerAccount, 'id' | 'created_at' | 'updated_at'>>
      }
      telegram_sessions: {
        Row: TelegramSession
        Insert: Omit<TelegramSession, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<TelegramSession, 'id' | 'created_at' | 'updated_at'>>
      }
      telegram_auth_pending: {
        Row: TelegramAuthPending
        Insert: TelegramAuthPending
        Update: Partial<TelegramAuthPending>
      }
      telegram_channels: {
        Row: TelegramChannel
        Insert: Omit<TelegramChannel, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<TelegramChannel, 'id' | 'created_at' | 'updated_at'>>
      }
      channel_signal_profiles: {
        Row: ChannelSignalProfile
        Insert: Omit<ChannelSignalProfile, 'id' | 'created_at' | 'updated_at' | 'analyzed_at'>
        Update: Partial<Omit<ChannelSignalProfile, 'id' | 'created_at'>>
      }
      signals: {
        Row: Signal
        Insert: Omit<Signal, 'id' | 'created_at'>
        Update: Partial<Omit<Signal, 'id' | 'created_at'>>
      }
      trades: {
        Row: Trade
        Insert: Omit<Trade, 'id' | 'created_at'>
        Update: Partial<Omit<Trade, 'id' | 'created_at'>>
      }
      user_profiles: {
        Row: UserProfileRow
        Insert: Omit<UserProfileRow, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }
        Update: Partial<Omit<UserProfileRow, 'user_id' | 'created_at'>>
      }
      affiliate_profiles: {
        Row: AffiliateProfileRow
        Insert: Omit<AffiliateProfileRow, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string }
        Update: Partial<Omit<AffiliateProfileRow, 'user_id' | 'created_at'>>
      }
      referral_attributions: {
        Row: ReferralAttributionRow
        Insert: Omit<ReferralAttributionRow, 'id' | 'created_at'> & { id?: string; created_at?: string }
        Update: Partial<Omit<ReferralAttributionRow, 'id' | 'created_at'>>
      }
      commission_ledger: {
        Row: CommissionLedgerRow
        Insert: Omit<CommissionLedgerRow, 'id' | 'created_at'> & { id?: string; created_at?: string }
        Update: Partial<Omit<CommissionLedgerRow, 'id' | 'created_at'>>
      }
      payout_batches: {
        Row: PayoutBatchRow
        Insert: Omit<PayoutBatchRow, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string }
        Update: Partial<Omit<PayoutBatchRow, 'id' | 'created_at'>>
      }
    }
  }
}

export interface UserProfileRow {
  user_id: string
  display_name: string
  first_name: string
  last_name: string
  username: string
  country: string
  city: string
  mobile_number: string
  address: string
  base_currency: string
  timezone: string
  is_admin: boolean
  admin_until: string | null
  subscription_status: string | null
  onboarding_completed_at: string | null
  referred_by_user_id: string | null
  notification_sound_enabled: boolean
  created_at: string
  updated_at: string
}

export interface AffiliateProfileRow {
  user_id: string
  referral_code: string
  is_active: boolean
  payout_email: string | null
  stripe_connect_account_id: string | null
  total_earned_cents: number
  total_paid_cents: number
  created_at: string
  updated_at: string
}

export interface ReferralAttributionRow {
  id: string
  referred_user_id: string
  affiliate_user_id: string
  referral_code: string
  attribution_source: 'signup_url' | 'signup_form' | 'onboarding' | 'admin'
  created_at: string
}

export interface CommissionLedgerRow {
  id: string
  affiliate_user_id: string
  referred_user_id: string
  stripe_invoice_id: string
  stripe_subscription_id: string | null
  invoice_amount_cents: number
  commission_rate: number
  commission_cents: number
  currency: string
  status: 'pending' | 'approved' | 'paid' | 'reversed'
  payout_batch_id: string | null
  period_start: string | null
  period_end: string | null
  created_at: string
}

export interface PayoutBatchRow {
  id: string
  period_label: string
  total_cents: number
  status: 'draft' | 'processing' | 'paid' | 'cancelled'
  paid_at: string | null
  notes: string | null
  created_by_admin: string | null
  created_at: string
  updated_at: string
}

export interface AiBrokerSettings {
  risk_percent_per_trade?: number
  min_lot?: number
  max_lot?: number
  reference_equity?: number
  fallback_lot?: number | null
  /** `equity` (default): percent applies to equity, then balance if equity missing. `balance`: always balance when set. */
  risk_basis?: 'equity' | 'balance'
  /** `linear` (default): scale lots with account vs reference_equity. `margin`: risk USD / RequiredMargin per 1 lot. */
  sizing_mode?: 'linear' | 'margin'
}

export interface ManualTpLot {
  label: string
  lot: number
  /** Multi Trades: percent of the total leg count that should target this TP level (e.g. 50 = 50%). */
  percent?: number
  enabled: boolean
}

export interface ManualChannelKeywords {
  signal: {
    entry_point: string
    buy: string
    sell: string
    sl: string
    tp: string
    market_order: string
  }
  update: {
    close_tp1: string
    close_tp2: string
    close_tp3: string
    close_tp4: string
    close_full: string
    close_half: string
    close_partial: string
    break_even: string
    set_tp1: string
    set_tp2: string
    set_tp3: string
    set_tp4: string
    set_tp5: string
    set_tp: string
    adjust_tp: string
    set_sl: string
    adjust_sl: string
    delete: string
  }
  additional: {
    layer: string
    close_all: string
    delete_all: string
    ignore_keyword: string
    skip_keyword: string
    remove_sl: string
    delay_msec: number
    prefer_entry: 'first_price' | 'last_price'
    sl_in_pips: boolean
    tp_in_pips: boolean
    delimiters: string
    all_order: boolean
    read_forwarded: boolean
    read_image: boolean
  }
}

export type ChannelKeywords = ManualChannelKeywords

export type CopyLimitPeriod = 'daily' | 'weekly' | 'monthly' | 'overall'
export type CopyLimitValueType = 'amount' | 'percent'
export type CopyLimitTimezoneMode = 'profile' | 'custom'

export interface ProfitTargetRule {
  id: string
  enabled: boolean
  period: CopyLimitPeriod
  value_type: CopyLimitValueType
  value: number
}

export interface MaxRiskRule {
  id: string
  enabled: boolean
  period: CopyLimitPeriod
  value_type: CopyLimitValueType
  value: number
}

export interface CopyLimitsConfig {
  profit_targets_enabled: boolean
  profit_targets: ProfitTargetRule[]
  max_risk_enabled: boolean
  max_risks: MaxRiskRule[]
  timezone_mode: CopyLimitTimezoneMode
  timezone?: string
}

export interface CopyLimitPeriodSnapshot {
  period_key: string
  reference_equity: number
  peak_channel_pnl: number
  last_evaluated_at: string
}

export interface CopyLimitState {
  paused_period_keys: string[]
  flattened_pause_keys?: string[]
  periods: Record<string, CopyLimitPeriodSnapshot>
}

export interface ManualSettings {
  schema_version?: number
  symbol_mapping?: Record<string, string>
  symbol_prefix?: string
  symbol_suffix?: string
  symbol_to_trade?: string | null
  symbols_exclude?: string[]
  risk_mode?: 'fixed_lot' | 'dynamic_balance_percent'
  fixed_lot?: number
  dynamic_balance_percent?: number
  tp_lots?: ManualTpLot[]
  single_tp_target?: 'tp1' | 'tp2' | 'tp3' | 'farthest'
  /** Multi Trades: per-leg size as a percent of the resolved fixed lot (default 5). */
  multi_trade_leg_percent?: number
  trade_style?: 'single' | 'multi'
  range_trading?: boolean
  /** Multi Trades + Range Trading: percent of the planned legs reserved for pending range orders (0..100). */
  range_percent?: number
  /** Pip distance between consecutive pending range orders. */
  range_step_pips?: number
  /** Total pip distance the range spans from entry. Caps the pending count to floor(distance / step). */
  range_distance_pips?: number
  /** When true, virtual range pendings stay active until the whole basket is flat (not after first TP/CWE close). */
  range_layer_till_close?: boolean
  /** When true, immediate multi-trade legs are closed at anchor + `close_worse_entries_pips` via the worker. */
  close_worse_entries?: boolean
  /** Pips from signal entry (anchor) at which instant legs auto-close. Default 30. */
  close_worse_entries_pips?: number
  /** @deprecated Legacy lot-based range; replaced by `range_percent`. Stripped on load. */
  range_total_lot?: number
  reverse_signal?: boolean
  /**
   * When true (manual mode), compare live quote to signal entry ± pip tolerance:
   * market fill if still acceptable, otherwise limit/stop at signal entry.
   */
  use_signal_entry_price?: boolean
  /** Pips above (buy) / below (sell) entry within which a market order is allowed. */
  signal_entry_pip_tolerance?: number
  use_predefined_sl_pips?: boolean
  predefined_sl_pips?: number
  use_predefined_tp_pips?: boolean
  predefined_tp_pips?: number[]
  rr_for_sl_enabled?: boolean
  rr_for_sl?: number
  rr_for_tps_enabled?: boolean
  rr_for_tps?: number[]
  pending_expiry_hours?: number
  add_new_trades_to_existing?: boolean
  move_sl_to_entry_after_mode?: 'none' | 'pips' | 'rr' | 'money' | 'tp_hit'
  move_sl_to_entry_after_value?: number
  move_sl_to_entry_tp_index?: number
  move_sl_to_entry_type?: 'sl_only' | 'sl_and_close_half'
  breakeven_offset_pips?: number
  partial_close_percent?: number
  half_close_percent?: number
  trailing_enabled?: boolean
  trailing_start_pips?: number
  trailing_step_pips?: number
  trailing_distance_pips?: number
  close_on_opposite_signal?: boolean
  time_filter_enabled?: boolean
  trade_start_time?: string
  trade_end_time?: string
  days_filter_enabled?: boolean
  trade_days?: number[]
  /** When true, signals may copy through news windows (no calendar blackout). */
  news_trading_enabled?: boolean
  /** Impact levels to avoid when `news_trading_enabled` is false. */
  news_avoid_impacts?: Array<'high' | 'medium' | 'low'>
  /** @deprecated Use `news_trading_enabled`. */
  allow_high_impact_news?: boolean
  close_before_news_minutes?: number
  resume_after_news_minutes?: number
  /** Per-channel profit targets and max risk (Targets tab). */
  copy_limits?: CopyLimitsConfig
}

export interface BrokerAccount {
  id: string
  user_id: string
  label: string
  platform: string
  /** MetatraderAPI account UUID returned by /RegisterAccount. */
  metaapi_account_id: string
  /** MT login number, kept separate from the UUID for display. */
  account_login?: string | null
  /** Human-readable broker name (e.g. "IC Markets"). */
  broker_name?: string | null
  /** MT server hostname as entered when linking (e.g. ICMarketsSC-MT5-2). */
  broker_server?: string | null
  /** Last known status from MetatraderAPI register/check. */
  connection_status?: 'pending' | 'connected' | 'error' | null
  /** Cached AccountSummary values for fast UI render. */
  last_balance?: number | null
  last_equity?: number | null
  last_currency?: string | null
  last_synced_at?: string | null
  /**
   * Balance at first successful link/summary (TSCopier tracking start).
   * Dashboard total profit uses current equity minus this baseline per account.
   */
  performance_baseline_balance?: number | null
  /** Balance at the start of `day_start_balance_on` (local calendar day). */
  day_start_balance?: number | null
  /** Local calendar day (YYYY-MM-DD) for `day_start_balance`. */
  day_start_balance_on?: string | null
  /** User opted in to encrypted server-side password storage for automatic reconnect. */
  auto_reconnect_enabled?: boolean | null
  /** When stored credentials were last written (no password exposed to client). */
  password_updated_at?: string | null
  /** Classified last connect failure (wrong_password, session_expired, etc.). */
  connection_error_kind?: string | null
  /** User-facing last connect failure message. */
  connection_error_message?: string | null
  is_active: boolean
  /** AI uses balance-scaled sizing; Manual uses defaults unless signal specifies lots. */
  copier_mode?: 'ai' | 'manual'
  /** Subscribed telegram_channels row ids; signals copy only when listed here. */
  signal_channel_ids?: string[] | null
  /** True when at least one channel is explicitly linked. */
  enforce_signal_channel_filter?: boolean | null
  ai_settings?: Json | null
  manual_settings?: Json | null
  /** Per Telegram channel id → management category → allow|ignore. */
  channel_message_filters?: Json | null
  /** Per telegram_channels.id → { copier_mode, manual_settings, ai_settings }. */
  channel_trading_configs?: Json | null
  default_lot_size: number
  pip_tolerance: number
  max_trades_per_zone: number
  created_at: string
  updated_at: string
}

export interface ChannelTradingPreset {
  id: string
  user_id: string
  name: string
  copier_mode: 'ai' | 'manual'
  manual_settings: ManualSettings
  channel_filters: Json
  created_at: string
  updated_at: string
}

/** Authoritative per-broker, per-channel trading configuration row. */
export interface BrokerChannelTradingConfig {
  id: string
  user_id: string
  broker_account_id: string
  channel_id: string
  copier_mode: 'ai' | 'manual'
  manual_settings: ManualSettings
  ai_settings: Json
  created_at: string
  updated_at: string
}

export interface TelegramSession {
  id: string
  user_id: string
  session_string: string
  phone_number: string
  is_active: boolean
  created_at: string
  updated_at: string
}

/** Worker-only row for Telegram login between send_code and verify_code. */
export interface TelegramAuthPending {
  user_id: string
  phone: string
  phone_code_hash: string
  expires_at: string
}

export interface TelegramChannel {
  id: string
  user_id: string
  channel_id: string
  channel_username: string
  display_name: string
  is_active: boolean
  lot_size_override: number | null
  pip_tolerance_override: number | null
  channel_keywords?: Json | null
  /** High-water mark of last Telegram message id seen by the listener. */
  last_seen_message_id?: number | null
  /** When the listener last mapped a message to this channel row. */
  last_seen_at?: string | null
  /** When the listener last received a live Telegram event for this channel. */
  last_live_at?: string | null
  created_at: string
  updated_at: string
}

export interface Signal {
  id: string
  user_id: string
  channel_id: string | null
  raw_message: string
  raw_image_url: string | null
  parsed_data: Json | null
  status: string
  skip_reason: string | null
  telegram_message_id: string | null
  /** Telegram reply_to target message id (same channel). */
  reply_to_message_id?: string | null
  is_modification: boolean
  parent_signal_id: string | null
  telegram_message_edited_at?: string | null
  created_at: string
}

export interface ChannelSignalProfile {
  id: string
  user_id: string
  channel_id: string
  lookback_days: number
  sample_size: number
  signal_type: string
  tp_style: string
  sl_style: string
  entry_type: string
  most_traded_asset: string | null
  estimated_tp_pips: number | null
  estimated_sl_pips: number | null
  analysis_summary: string | null
  meta: Json
  analyzed_at: string
  created_at: string
  updated_at: string
}

export interface Trade {
  id: string
  user_id: string
  signal_id: string | null
  telegram_channel_id?: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol: string
  direction: string
  entry_price: number | null
  sl: number | null
  tp: number | null
  tp_levels?: number[]
  tp_open?: boolean
  tp_step_policy?: Json
  next_tp_index?: number
  lot_size: number
  status: string
  opened_at: string
  closed_at: string | null
  profit: number | null
  created_at: string
}

export interface MtServer {
  id: string
  server_name: string
  platform: 'MT4' | 'MT5' | 'ANY'
  broker_label: string | null
  is_active: boolean
}

export type ParsedSignal = {
  action: 'buy' | 'sell' | 'close' | 'breakeven' | 'partial_profit' | 'partial_breakeven' | 'modify'
  symbol: string
  entry_price?: number
  entry_zone_low?: number
  entry_zone_high?: number
  sl?: number
  tp?: number[]
  open_tp?: boolean
  lot_size?: number
  confidence: number
  raw_instruction: string
}
