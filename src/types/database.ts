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

export interface BrokerAccount {
  id: string
  user_id: string
  label: string
  platform: string
  metaapi_account_id: string
  /** MT server hostname as entered when linking (used to infer broker label). */
  broker_server?: string | null
  is_active: boolean
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

export interface TelegramChannel {
  id: string
  user_id: string
  channel_id: string
  channel_username: string
  display_name: string
  is_active: boolean
  lot_size_override: number | null
  pip_tolerance_override: number | null
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
  broker_account_id: string | null
  metaapi_order_id: string | null
  symbol: string
  direction: string
  entry_price: number | null
  sl: number | null
  tp: number | null
  lot_size: number
  status: string
  opened_at: string
  closed_at: string | null
  profit: number | null
  created_at: string
}

export type ParsedSignal = {
  action: 'buy' | 'sell' | 'close' | 'breakeven' | 'partial_profit' | 'modify'
  symbol: string
  entry_price?: number
  entry_zone_low?: number
  entry_zone_high?: number
  sl?: number
  tp?: number[]
  lot_size?: number
  confidence: number
  raw_instruction: string
}
