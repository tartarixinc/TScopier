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
    }
  }
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
  /** Range only: when true, the immediate legs (+ a configurable number of shallowest pendings) take a small profit at `close_worse_entries_pips` instead of riding the percent-row TPs. */
  close_worse_entries?: boolean
  /** Pips of profit per worse-entry leg (from each leg's own entry) at which to close. Default 20. */
  close_worse_entries_pips?: number
  /** How many of the shallowest pendings (in addition to all immediates) should also use the tight TP. Default 0 (immediates only). Capped at the effective pending count. */
  close_worse_extra_pendings?: number
  /** @deprecated Legacy lot-based range; replaced by `range_percent`. Stripped on load. */
  range_total_lot?: number
  reverse_signal?: boolean
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
  allow_high_impact_news?: boolean
  close_before_news_minutes?: number
  resume_after_news_minutes?: number
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
  is_active: boolean
  /** AI uses balance-scaled sizing; Manual uses defaults unless signal specifies lots. */
  copier_mode?: 'ai' | 'manual'
  /** Subscribed telegram_channels row ids; only enforced when enforce_signal_channel_filter is true. */
  signal_channel_ids?: string[] | null
  /** When false (default), all connected Telegram channels copy to this broker. */
  enforce_signal_channel_filter?: boolean | null
  ai_settings?: Json | null
  manual_settings?: Json | null
  default_lot_size: number
  pip_tolerance: number
  max_trades_per_zone: number
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
