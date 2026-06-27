/**
 * Worker process role and shard configuration (Railway / multi-service deploy).
 *
 * WORKER_ROLE:
 *   all          — monolith (default): listener + trade monitors + backtest HTTP
 *   listener     — Telegram ingest only; profile backfill uses live MTProto client
 *   trade        — TradeExecutor (entries + management) + all monitors
 *   trade_entry  — buy/sell only + execution-side monitors (virtual pending, CWE, …)
 *   trade_mgmt   — management only + reconcile / auto-mgmt monitors
 *   backtest          — Ephemeral Telegram client for backtest sync only
 *   channel_listener  — Channel-scoped ingest sharded by signal_channel_id
 */

import { tradeExecutorModeForRole, type TradeExecutorMode } from './tradeSignalActions'

type WorkerRole =
  | 'all'
  | 'listener'
  | 'channel_listener'
  | 'trade'
  | 'trade_entry'
  | 'trade_mgmt'
  | 'backtest'

function parseRole(raw: string | undefined): WorkerRole {
  const v = String(raw ?? 'all').toLowerCase().trim()
  if (
    v === 'listener'
    || v === 'channel_listener'
    || v === 'trade'
    || v === 'trade_entry'
    || v === 'trade_mgmt'
    || v === 'backtest'
  ) {
    return v
  }
  return 'all'
}

const role = parseRole(process.env.WORKER_ROLE)

const runsTradeRole =
  role === 'all' || role === 'trade' || role === 'trade_entry' || role === 'trade_mgmt'

/** One heartbeat loop per shard is enough — trade_mgmt shares FxSocket sessions with trade_entry. */
const runsBrokerSessionHeartbeat =
  role === 'all' || role === 'trade' || role === 'trade_entry'

export const workerConfig = {
  role,
  instanceId: String(
    process.env.WORKER_INSTANCE_ID
    ?? `${process.env.HOSTNAME ?? 'local'}:${process.pid}`,
  ),
  shardId: Math.max(0, Math.floor(Number(process.env.WORKER_SHARD_ID ?? 0))),
  shardCount: Math.max(1, Math.floor(Number(process.env.WORKER_SHARD_COUNT ?? 1))),
  runsListener: role === 'all' || role === 'listener' || role === 'channel_listener',
  runsChannelListener: role === 'all' || role === 'channel_listener',
  runsTrade: runsTradeRole,
  runsBrokerSessionHeartbeat,
  tradeExecutorMode: tradeExecutorModeForRole(role) as TradeExecutorMode,
  runsExecutionMonitors:
    role === 'all' || role === 'trade' || role === 'trade_entry',
  runsManagementMonitors:
    role === 'all' || role === 'trade' || role === 'trade_mgmt',
  runsBacktestHttp: role === 'all' || role === 'backtest',
  /** Backtest uses a short-lived Telegram client, never the live listener connection. */
  backtestUsesEphemeralClient: role !== 'all' || process.env.BACKTEST_EPHEMERAL_CLIENT !== 'false',
  /**
   * Supabase Realtime on `signals` for trade execution. Off by default on split trade
   * workers (`trade_entry` / `trade_mgmt`) — each replica would otherwise execute the
   * same row (in-memory inflight is not shared). Listener HTTP push + sweep remain.
   */
  tradeExecutorRealtime:
    parseEnvBool(process.env.EXECUTOR_REALTIME_SIGNALS, role === 'all' || role === 'trade'),
}

export function parseEnvBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') return defaultValue
  const v = raw.toLowerCase().trim()
  if (v === '0' || v === 'false' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'yes') return true
  return defaultValue
}

export function shardForUserId(userId: string, shardCount: number): number {
  let h = 0
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0
  }
  return Math.abs(h) % Math.max(1, shardCount)
}

export function userBelongsToShard(userId: string): boolean {
  if (workerConfig.shardCount <= 1) return true
  return shardForUserId(userId, workerConfig.shardCount) === workerConfig.shardId
}

/**
 * Build marker so we can confirm which worker build is actually running by
 * reading worker_session_leases.worker_id. Bump on meaningful worker changes.
 * Used symmetrically by acquire/renew/release, so changing it is safe.
 */
export const WORKER_BUILD_TAG = String(process.env.WORKER_BUILD_TAG ?? 'channel-scoped-listener-1')

export function listenerWorkerId(): string {
  return `listener:${workerConfig.shardId}:${workerConfig.instanceId}:${WORKER_BUILD_TAG}`
}

export function channelListenerWorkerId(): string {
  return `channel_listener:${workerConfig.shardId}:${workerConfig.instanceId}:${WORKER_BUILD_TAG}`
}

export function shardForSignalChannelId(signalChannelId: string, shardCount: number): number {
  let h = 0
  for (let i = 0; i < signalChannelId.length; i++) {
    h = (h * 31 + signalChannelId.charCodeAt(i)) | 0
  }
  return Math.abs(h) % Math.max(1, shardCount)
}

export function leaseRoleLabel(): string {
  if (workerConfig.role === 'listener') return 'listener'
  if (workerConfig.role === 'channel_listener') return 'channel_listener'
  if (workerConfig.role === 'all') return 'listener'
  return workerConfig.role
}
