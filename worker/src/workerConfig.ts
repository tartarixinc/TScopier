/**
 * Worker process role and shard configuration (Railway / multi-service deploy).
 *
 * WORKER_ROLE:
 *   all          — monolith (default): listener + trade monitors + backtest HTTP
 *   listener     — Telegram ingest only; no trade monitors; backtest HTTP returns 503
 *   trade        — TradeExecutor (entries + management) + all monitors
 *   trade_entry  — buy/sell only + execution-side monitors (virtual pending, CWE, …)
 *   trade_mgmt   — management only + reconcile / auto-mgmt monitors
 *   backtest     — Ephemeral Telegram client for backtest sync only
 */

import { tradeExecutorModeForRole, type TradeExecutorMode } from './tradeSignalActions'

export type WorkerRole =
  | 'all'
  | 'listener'
  | 'trade'
  | 'trade_entry'
  | 'trade_mgmt'
  | 'backtest'

function parseRole(raw: string | undefined): WorkerRole {
  const v = String(raw ?? 'all').toLowerCase().trim()
  if (
    v === 'listener'
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

export const workerConfig = {
  role,
  instanceId: String(
    process.env.WORKER_INSTANCE_ID
    ?? `${process.env.HOSTNAME ?? 'local'}:${process.pid}`,
  ),
  shardId: Math.max(0, Math.floor(Number(process.env.WORKER_SHARD_ID ?? 0))),
  shardCount: Math.max(1, Math.floor(Number(process.env.WORKER_SHARD_COUNT ?? 1))),
  runsListener: role === 'all' || role === 'listener',
  runsTrade: runsTradeRole,
  tradeExecutorMode: tradeExecutorModeForRole(role) as TradeExecutorMode,
  runsExecutionMonitors:
    role === 'all' || role === 'trade' || role === 'trade_entry',
  runsManagementMonitors:
    role === 'all' || role === 'trade' || role === 'trade_mgmt',
  runsBacktestHttp: role === 'all' || role === 'backtest',
  /** Backtest uses a short-lived Telegram client, never the live listener connection. */
  backtestUsesEphemeralClient: role !== 'all' || process.env.BACKTEST_EPHEMERAL_CLIENT !== 'false',
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

export function listenerWorkerId(): string {
  return `listener:${workerConfig.shardId}:${workerConfig.instanceId}`
}

export function leaseRoleLabel(): string {
  if (workerConfig.role === 'listener') return 'listener'
  if (workerConfig.role === 'all') return 'listener'
  return workerConfig.role
}
