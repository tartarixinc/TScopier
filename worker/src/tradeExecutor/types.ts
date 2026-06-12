import type { ChannelMessageFiltersMap } from '../channelMessageFilters'
import type { ParsedSignal } from '../manualPlanning/types'
import { monitorActiveIntervalMs, monitorIdleIntervalMs } from '../monitorIdleGate'
import type { PipelineTimestamps } from '../pipelineTimestamps'

export type { ParsedSignal }

/** When true (default), channel-attached signals only execute if MTProto is connected in this process. */
export function telegramLiveTradeGateEnabled(): boolean {
  const v = String(process.env.WORKER_REQUIRE_TELEGRAM_LIVE_FOR_TRADES ?? 'true').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** Per-broker summary so `handleSignal` can flip `signals.status` when every account skips entry-strict. */
export type SendOrderOutcome = {
  openedOrMerged?: boolean
  signalEntryRequiredSkip?: boolean
  /** Deterministic no-op where retrying the same parsed signal won't change outcome. */
  finalizeSkipReason?: string
  /** Channel `delay_msec` from Copier Engine (skipped on live fast path). */
  channelDelayMs?: number
  channelDelaySkipped?: boolean
}

export const PARSED_STATUSES = new Set(['parsed'])

export interface SignalRow {
  id: string
  user_id: string
  channel_id: string | null
  parsed_data: ParsedSignal | null
  status: string
  parent_signal_id: string | null
  is_modification: boolean
  created_at?: string
  telegram_message_id?: string | null
  reply_to_message_id?: string | null
  /** Latency stamps from listener → trade entry (live path). */
  pipeline_ts?: PipelineTimestamps
  /** In-memory dispatch hint (not persisted on signals row). */
  dispatch_source?: string
  /** Prior parsed action before a same-message revision (in-memory only). */
  revision_prior_action?: string | null
}

/** In-process priority-queue entry: signal plus the dispatch flags it arrived with. */
export interface QueuedSignal {
  row: SignalRow
  liveDispatch?: boolean
  source?: string
  dispatchReceivedAt?: number
}

export interface RangePendingCancelScope {
  signalId: string
  brokerAccountId: string
  symbol: string
}

/** Merge path ran (cancel + re-insert virtuals under anchor); caller must not fall through to standard sendOrder. */
export type MergeOutcome =
  | { handled: false }
  | { handled: true; success: boolean }

export interface BrokerRow {
  id: string
  user_id: string
  is_active: boolean
  platform: string
  connection_status?: string | null
  metaapi_account_id: string | null
  account_login: string | null
  broker_server: string | null
  copier_mode: 'ai' | 'manual' | null
  signal_channel_ids: string[] | null
  enforce_signal_channel_filter: boolean | null
  ai_settings: Record<string, unknown> | null
  manual_settings: Record<string, unknown> | null
  default_lot_size: number | null
  last_balance: number | null
  last_equity: number | null
  last_currency: string | null
  performance_baseline_balance?: number | null
  channel_message_filters?: ChannelMessageFiltersMap | null
  channel_trading_configs?: Record<string, unknown> | null
  /**
   * Wall time the broker's `is_active` most recently flipped to TRUE
   * (maintained by `broker_accounts_stamp_activated_at` trigger). Used to
   * reject parsed signals that pre-date a reactivation, so sweep replay
   * doesn't fire trades that piled up while the broker was disabled.
   */
  last_activated_at?: string | null
  /** Encrypted MT password for worker hard reconnect (never logged). */
  auto_reconnect_enabled?: boolean | null
  mt_password_encrypted?: string | null
}

export interface SymbolCacheEntry {
  digits: number
  point: number
  minLot: number
  maxLot: number
  lotStep: number
  contractSize: number | null
  stopsLevel: number
  freezeLevel: number
  loadedAt: number
}

export interface SymbolListCacheEntry {
  set: Set<string>
  list: string[]
  loadedAt: number
}

export interface SymbolMappingResult {
  symbol: string
  whitelist: string[]
  /** True when prefix/suffix or explicit symbol_mapping was applied — broker resolve must not downgrade. */
  userDecorated: boolean
}

export interface Leg {
  args: import('../metatraderapi').OrderSendArgs
  idx: number
  cweClosePrice?: number | null
  partialTps?: import('../manualPlanner').PlannerPartialTp[]
}

/**
 * Long-lived cache TTLs (24h). Symbol-cache keepalive refreshes entries every
 * SYMBOL_CACHE_KEEPALIVE_MS so we never serve content older than that even if
 * the broker quietly changes contract specs.
 */
export const SYMBOL_CACHE_TTL_MS = 24 * 60 * 60_000
export const SYMBOL_LIST_TTL_MS = 24 * 60 * 60_000
export const SYMBOL_CACHE_STALE_MS = Math.max(
  30_000,
  Math.min(SYMBOL_CACHE_TTL_MS, Number(process.env.SYMBOL_CACHE_STALE_MS ?? 5 * 60_000)),
)
export const SYMBOL_CACHE_KEEPALIVE_MS = Math.max(
  30_000,
  Math.min(SYMBOL_CACHE_TTL_MS, Number(process.env.SYMBOL_CACHE_KEEPALIVE_MS ?? 5 * 60_000)),
)
export const BROKER_SESSION_HEARTBEAT_MS = Math.max(
  5_000,
  Math.min(60_000, Number(process.env.BROKER_SESSION_HEARTBEAT_MS ?? 15_000)),
)
export const SESSION_PING_MIN_INTERVAL_MS = Math.max(
  5_000,
  Math.min(120_000, Number(process.env.BROKER_SESSION_PING_MIN_INTERVAL_MS ?? BROKER_SESSION_HEARTBEAT_MS)),
)
export const EXECUTOR_PARSED_SWEEP_MS = monitorActiveIntervalMs('EXECUTOR_PARSED_SWEEP_MS', 3_000)
export const EXECUTOR_SWEEP_IDLE_MS = monitorIdleIntervalMs('EXECUTOR_SWEEP_IDLE_MS', 60_000)
export const EXECUTOR_REPLAY_MAX_AGE_MS = Math.max(
  60_000,
  Math.min(30 * 60_000, Number(process.env.EXECUTOR_REPLAY_MAX_AGE_MS ?? 5 * 60_000)),
)
export const EXECUTOR_MAX_CONCURRENT_SIGNALS = Math.max(
  1,
  Math.min(16, Number(process.env.EXECUTOR_MAX_CONCURRENT_SIGNALS ?? 4)),
)
export const EXECUTION_LOG_ACTIONS_HANDLED = [
  'order_send',
  'virtual_pending_inserted',
  'merge_modify_summary',
  'mgmt_close_worse_entries',
] as const
