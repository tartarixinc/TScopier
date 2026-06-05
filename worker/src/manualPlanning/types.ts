import type { OrderSendArgs } from '../metatraderapi'
import type { PipQuote } from '../pipCalculator'

export interface ParsedSignal {
  action: string
  symbol: string | null
  entry_price: number | null
  entry_zone_low: number | null
  entry_zone_high: number | null
  sl: number | null
  tp: number[] | null
  lot_size: number | null
  open_tp?: boolean
  partial_close_fraction?: number | null
  raw_instruction?: string
  /** Explicit channel intent to open a new trade (not modify existing). */
  re_enter?: boolean
}

export interface ManualTpLot {
  label: string
  lot: number
  percent?: number
  enabled: boolean
}

export interface ManualSettings {
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
  multi_trade_leg_percent?: number
  trade_style?: 'single' | 'multi'
  range_trading?: boolean
  range_percent?: number
  range_step_pips?: number
  range_distance_pips?: number
  range_layer_till_close?: boolean
  close_worse_entries?: boolean
  close_worse_entries_pips?: number
  /** @deprecated Replaced by `range_percent`. */
  range_total_lot?: number
  reverse_signal?: boolean
  use_signal_entry_price?: boolean | string | number
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
  close_on_opposite_signal?: boolean
  time_filter_enabled?: boolean
  trade_start_time?: string
  trade_end_time?: string
  days_filter_enabled?: boolean
  trade_days?: number[]
  trailing_enabled?: boolean
  trailing_start_pips?: number
  trailing_step_pips?: number
  trailing_distance_pips?: number
  move_sl_to_entry_after_mode?: 'none' | 'pips' | 'rr' | 'money' | 'tp_hit'
  move_sl_to_entry_after_value?: number
  move_sl_to_entry_tp_index?: number
  move_sl_to_entry_type?: 'sl_only' | 'sl_and_close_half'
  breakeven_offset_pips?: number
}

export interface ChannelKeywords {
  signal_phrases?: { buy?: string; sell?: string; entry_point?: string; sl?: string; tp?: string; market_order?: string }
  additional?: {
    ignore_keyword?: string
    skip_keyword?: string
    sl_in_pips?: boolean
    tp_in_pips?: boolean
    prefer_entry?: 'first_price' | 'last_price'
    delay_msec?: number
    all_order?: boolean
    remove_sl?: string
  }
}

export interface PlannerContext {
  /** MT point size for the symbol (e.g. 0.0001 for EURUSD, 0.01 for XAUUSD). Used for pip math. */
  point: number
  /** Number of decimal places to keep on prices when rounding. */
  digits: number
  minLot: number
  lotStep: number
  contractSize?: number | null
  stopsLevel?: number
  freezeLevel?: number
  defaultLot: number
  lastBalance: number | null
  now?: Date
  liveBid?: number
  liveAsk?: number
}

export interface VirtualPendingLeg {
  stepIdx: number
  stepPriceOffset: number
  isBuy: boolean
  volume: number
  stoploss: number | null
  takeprofit: number | null
  slippage: number
  comment: string
  expertID?: number
  expiryHours?: number
  cweClosePrice?: number | null
}

export interface PlannerCloseWorseEntries {
  immediates: number
  pipsFromAnchor: number
}

export interface PlannerAnchor {
  source: 'signal' | 'unknown'
  value: number | null
}

export interface PlannerStrictEntry {
  entryPrice: number
  isBuy: boolean
}

export interface PlannerPartialTp {
  tpIdx: number
  triggerPrice: number
  closeLots: number
  percent: number
}

export interface PlannerResult {
  orders: OrderSendArgs[]
  virtualPendings?: VirtualPendingLeg[]
  anchor?: PlannerAnchor
  pip?: number
  pipQuote?: PipQuote
  isBuy?: boolean
  closeWorseEntries?: PlannerCloseWorseEntries
  partialTps?: PlannerPartialTp[]
  strictEntry?: PlannerStrictEntry
  skip_reason?: string
  fallback_reason?: string
  delay_ms: number
}

export interface PlanRangeSplitArgs {
  totalLegs: number
  baseIsPendingSignal: boolean
  rangeOn: boolean
  rangePct: number
  stepPips: number
  distPips: number
  pip: number
  minStepPriceUnits: number
  hasSignalAnchor: boolean
}

export interface PlanRangeSplitResult {
  immediateLegs: number
  pendingLegs: number
  effectiveStepPips: number
  stepPriceOffset: number
  fallbackReason?: string
}

export interface ComputeCwOverrideTpArgs {
  policy: PlannerCloseWorseEntries
  anchor: number
  isBuy: boolean
  pip: number
  digits: number
  minStopDistance: number
}
