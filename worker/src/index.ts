import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { UserSessionManager } from './sessionManager'
import { AuthService } from './authService'
import { startHttpServer, startTradeHttpServer } from './httpServer'
import { TradeExecutor } from './tradeExecutor'
import { VirtualPendingMonitor } from './virtualPendingMonitor'
import { CweCloseMonitor } from './cweCloseMonitor'
import { PartialTpMonitor } from './partialTpMonitor'
import { SignalEntryPendingMonitor } from './signalEntryPendingMonitor'
import { SignalRangeEntryMonitor } from './signalRangeEntryMonitor'
import { AutoManagementMonitor } from './autoManagementMonitor'
import { TrailingStopMonitor } from './trailingStopMonitor'
import { BasketSlTpReconcileMonitor } from './basketSlTpReconcileMonitor'
import { NewsTradingMonitor } from './newsTradingMonitor'
import { OpenTradeReconcileMonitor } from './openTradeReconcileMonitor'
import { attachBrokerStreamProxy } from './brokerStreamProxy'
import { getFxsocketStreamManager } from './fxsocketStreamManager'
import { CopyLimitMonitor } from './copyLimitMonitor'
import { workerConfig } from './workerConfig'
import { validateListenerTradeShardConfig, validateListenerQueueConfig } from './tradeSignalPush'
import { SignalQueueConsumerManager } from './queue/signalQueueConsumer'
import { deployedTradeShardCount, signalQueueConfig, redisQueueConfigured } from './queue/signalQueueConfig'
import { setQueueMetricsProvider } from './queue/queueHealth'
import type { MonitorLoopHandle } from './monitorIdleGate'
import { subscribeMonitorWorkWake } from './monitorWorkWake'
import { startTradeLogRetention } from './tradeLogRetention'
import type { Server } from 'http'

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const sessionManager = new UserSessionManager(supabase)
let httpServer: Server | null = null
let authService: AuthService | null = null
let tradeExecutor: TradeExecutor | null = null
let signalQueueConsumers: SignalQueueConsumerManager | null = null

const monitors: Array<{ stop: () => void }> = []
const monitorLoops: MonitorLoopHandle[] = []
let stopLogRetention: (() => void) | null = null
let stopWorkWake: (() => void) | null = null

function trackMonitor(m: { stop: () => void; getLoopHandle?: () => MonitorLoopHandle | null; getLoopHandles?: () => MonitorLoopHandle[] }) {
  monitors.push(m)
  if (m.getLoopHandle) {
    const h = m.getLoopHandle()
    if (h) monitorLoops.push(h)
  }
  if (m.getLoopHandles) {
    monitorLoops.push(...m.getLoopHandles())
  }
}

function startTradeMonitors(executor: TradeExecutor | null) {
  if (workerConfig.runsExecutionMonitors) {
    const virtualPendingMonitor = new VirtualPendingMonitor(supabase)
    const cweCloseMonitor = new CweCloseMonitor(supabase)
    const partialTpMonitor = new PartialTpMonitor(supabase)
    const signalEntryPendingMonitor = new SignalEntryPendingMonitor(supabase)
    const openTradeReconcileMonitor = new OpenTradeReconcileMonitor(supabase)
    virtualPendingMonitor.start()
    cweCloseMonitor.start()
    partialTpMonitor.start()
    signalEntryPendingMonitor.start()
    openTradeReconcileMonitor.start()
    trackMonitor(virtualPendingMonitor)
    trackMonitor(cweCloseMonitor)
    trackMonitor(partialTpMonitor)
    trackMonitor(signalEntryPendingMonitor)
    trackMonitor(openTradeReconcileMonitor)
    if (executor) {
      const signalRangeEntryMonitor = new SignalRangeEntryMonitor(supabase, executor)
      signalRangeEntryMonitor.start()
      trackMonitor(signalRangeEntryMonitor)
    }
  }

  if (workerConfig.runsTrade) {
    const copyLimitMonitor = new CopyLimitMonitor(supabase)
    copyLimitMonitor.start()
    trackMonitor(copyLimitMonitor)
  }

  if (workerConfig.runsManagementMonitors) {
    const trailingStopMonitor = new TrailingStopMonitor(supabase)
    const autoManagementMonitor = new AutoManagementMonitor(supabase)
    const basketSlTpReconcileMonitor = new BasketSlTpReconcileMonitor(supabase)
    const newsTradingMonitor = new NewsTradingMonitor(supabase)
    trailingStopMonitor.start()
    autoManagementMonitor.start()
    basketSlTpReconcileMonitor.start()
    newsTradingMonitor.start()
    trackMonitor(trailingStopMonitor)
    trackMonitor(autoManagementMonitor)
    trackMonitor(basketSlTpReconcileMonitor)
    trackMonitor(newsTradingMonitor)
  }

  stopLogRetention = startTradeLogRetention(supabase)
}

async function main() {
  if (workerConfig.runsListener) {
    const shardErr = validateListenerTradeShardConfig()
    if (shardErr) {
      console.error(`[worker] FATAL: ${shardErr}`)
      process.exit(1)
    }
    const queueErr = validateListenerQueueConfig()
    if (queueErr) {
      console.error(`[worker] FATAL: ${queueErr}`)
      process.exit(1)
    }
  }

  console.log(
    `[worker] starting role=${workerConfig.role} shard=${workerConfig.shardId}/${workerConfig.shardCount}`
    + ` instance=${workerConfig.instanceId}`,
  )

  if (workerConfig.runsListener || workerConfig.runsBacktestHttp) {
    authService = new AuthService(supabase, sessionManager)
    httpServer = startHttpServer(authService, sessionManager)
  }

  if (workerConfig.runsTrade) {
    tradeExecutor = new TradeExecutor(supabase, sessionManager)
    sessionManager.setTradeExecutor(tradeExecutor)
    await tradeExecutor.start()
    const sweepHandle = tradeExecutor.getSweepLoopHandle()
    if (sweepHandle) monitorLoops.push(sweepHandle)
    startTradeMonitors(tradeExecutor)
    if (monitorLoops.length > 0 && !stopWorkWake) {
      stopWorkWake = subscribeMonitorWorkWake(supabase, monitorLoops)
    }
    if (!httpServer) {
      httpServer = startTradeHttpServer(sessionManager, tradeExecutor)
    }
    if (httpServer) {
      const streamManager = getFxsocketStreamManager()
      if (streamManager) {
        attachBrokerStreamProxy(httpServer, supabase, streamManager)
        console.log('[worker] broker stream proxy attached at /broker/stream')
      } else {
        console.error(
          '[worker] broker stream proxy DISABLED — set FXSOCKET_API_KEY on this trade worker'
          + ' and point WORKER_PUBLIC_URL / VITE_WORKER_URL here (not the listener service)',
        )
      }
    }

    const queueCfg = signalQueueConfig()
    if (queueCfg.enabled && redisQueueConfigured()) {
      if (queueCfg.shardCount > 1 && workerConfig.shardCount <= 1) {
        console.warn(
          `[worker] TRADE_SIGNAL_QUEUE_SHARD_COUNT=${queueCfg.shardCount} but this worker`
          + ` is shard ${workerConfig.shardId} only — users on other shards need matching trade workers`,
        )
      }
      if (workerConfig.shardId >= queueCfg.shardCount) {
        console.error(
          `[worker] FATAL: WORKER_SHARD_ID=${workerConfig.shardId} >= TRADE_SIGNAL_QUEUE_SHARD_COUNT=${queueCfg.shardCount}`,
        )
        process.exit(1)
      }
      const tradeShards = deployedTradeShardCount()
      if (queueCfg.shardCount > tradeShards && workerConfig.shardId === 0) {
        console.warn(
          `[worker] queue shard count (${queueCfg.shardCount}) > deployed trade shards (${tradeShards})`
          + ' — set TRADE_SIGNAL_QUEUE_SHARD_COUNT=1 on listener and worker',
        )
      }
      signalQueueConsumers = new SignalQueueConsumerManager(supabase, tradeExecutor)
      signalQueueConsumers.start()
      setQueueMetricsProvider(() => signalQueueConsumers!.getMetrics())
      console.log('[worker] signal queue consumers started')
    } else if (queueCfg.enabled) {
      console.warn('[worker] TRADE_SIGNAL_QUEUE_ENABLED=true but Redis REST URL/token missing — queue disabled')
      setQueueMetricsProvider(null)
    }
  } else {
    sessionManager.setTradeExecutor(null)
  }

  if (workerConfig.runsListener) {
    await sessionManager.loadAll()
    setInterval(async () => {
      await sessionManager.syncSessions()
    }, 30_000)

    if (workerConfig.role === 'listener' || workerConfig.role === 'all') {
      setInterval(async () => {
        await sessionManager.renewAllLeases()
      }, Math.max(10_000, Number(process.env.WORKER_LEASE_RENEW_INTERVAL_MS ?? 20_000)))
    }
  } else if (workerConfig.runsBacktestHttp) {
    console.log('[worker] backtest-only: no live Telegram listeners loaded')
  }

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down...`)
    httpServer?.close()
    authService?.shutdown()
    stopWorkWake?.()
    stopLogRetention?.()
    setQueueMetricsProvider(null)
    await signalQueueConsumers?.stop()
    tradeExecutor?.stop()
    for (const m of monitors) m.stop()
    if (workerConfig.runsListener) {
      await sessionManager.disconnectAll()
    }
    await new Promise(r => setTimeout(r, Math.min(10_000, Number(process.env.TELEGRAM_SHUTDOWN_DRAIN_MS ?? 8000))))
    process.exit(0)
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
  process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)) })
}

main().catch(err => {
  console.error('[worker] Fatal error:', err)
  process.exit(1)
})
