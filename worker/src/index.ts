import 'dotenv/config'
import {
  captureWorkerFatalError,
  captureWorkerLog,
  captureWorkerWarning,
  flushWorkerSentry,
  initWorkerSentry,
  installWorkerProcessSentryHandlers,
} from './observability/sentry'
import { startWorkerHeartbeatCheckIns, stopWorkerHeartbeatCheckIns } from './observability/workerHeartbeat'
// Must be loaded before any TelegramClient runtime code — patches console.log
// to suppress GramJS flood-wait INFO noise (83% of log volume).
import './gramjsLogSuppress'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { UserSessionManager } from './sessionManager'
import { AuthService } from './authService'
import { startHttpServer, startTradeHttpServer } from './httpServer'
import { TradeExecutor } from './tradeExecutor'
import { VirtualPendingMonitor, registerVirtualPendingMonitor } from './virtualPendingMonitor'
import { RangeBrokerPendingMonitor } from './rangeBrokerPendingMonitor'
import { CweCloseMonitor } from './cweCloseMonitor'
import { PartialTpMonitor } from './partialTpMonitor'
import { SignalEntryPendingMonitor } from './signalEntryPendingMonitor'
import { SignalRangeEntryMonitor } from './signalRangeEntryMonitor'
import { AutoManagementMonitor } from './autoManagementMonitor'
import { TrailingStopMonitor } from './trailingStopMonitor'
import { BasketSlTpReconcileMonitor } from './basketSlTpReconcileMonitor'
import { NewsTradingMonitor } from './newsTradingMonitor'
import { V2ReconcileMonitor } from './engine/v2ReconcileMonitor'
import { v2EngineConfigured } from './engine/executionMode'
import { OpenTradeReconcileMonitor } from './openTradeReconcileMonitor'
import { ClosedTradeClosePriceMonitor } from './closedTradeClosePriceMonitor'
import { attachBrokerStreamProxy } from './brokerStreamProxy'
import { getFxsocketStreamManager } from './fxsocketStreamManager'
import { CopyLimitMonitor } from './copyLimitMonitor'
import { workerConfig, WORKER_BUILD_TAG } from './workerConfig'
import { validateListenerTradeShardConfig, validateListenerMgmtShardConfig, validateListenerQueueConfig } from './tradeSignalPush'
import { SignalQueueConsumerManager } from './queue/signalQueueConsumer'
import { deployedTradeShardCount, signalQueueConfig, redisQueueConfigured } from './queue/signalQueueConfig'
import { setQueueMetricsProvider } from './queue/queueHealth'
import type { MonitorLoopHandle } from './monitorIdleGate'
import { subscribeMonitorWorkWake } from './monitorWorkWake'
import { startTradeLogRetention } from './tradeLogRetention'
import type { Server } from 'http'
import { telegramShutdownDrainMs } from './workerShutdown'
import { registerOrderCloseAuditSupabase } from './orderCloseAudit'
import { initializeBrokerExecutionCapability } from './brokerExecutionMode'
import { testFlagEnabled } from './testFlags'
import { MtapiSessionManager } from './mtapiSessionManager'

initWorkerSentry()
installWorkerProcessSentryHandlers()
startWorkerHeartbeatCheckIns()
captureWorkerLog('info', 'worker startup', {
  subsystem: 'worker',
  operation: 'startup',
  errorCode: 'STARTUP',
  attributes: {
    build_tag: WORKER_BUILD_TAG,
    role: workerConfig.role,
    shard_id: workerConfig.shardId,
    shard_count: workerConfig.shardCount,
  },
})

// TEST ONLY: force a critical uncaught exception to verify Sentry captures it.
// Throws after a short delay so the process handlers + heartbeat are installed first.
// Refused in production (see testFlags.ts). Remove the flag after the test to
// avoid crash-looping the worker.
if (testFlagEnabled(process.env, 'CRITICAL_EXCEPTION_TEST_FORCE')) {
  setTimeout(() => {
    throw new Error('TEST_FORCED_CRITICAL_EXCEPTION')
  }, 1000)
}

if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)
registerOrderCloseAuditSupabase(supabase)

const sessionManager = new UserSessionManager(supabase)
let httpServer: Server | null = null
let authService: AuthService | null = null
let tradeExecutor: TradeExecutor | null = null
let signalQueueConsumers: SignalQueueConsumerManager | null = null
let mtapiSessionManager: MtapiSessionManager | null = null

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
    const rangeBrokerPendingMonitor = new RangeBrokerPendingMonitor(supabase)
    const cweCloseMonitor = new CweCloseMonitor(supabase)
    const partialTpMonitor = new PartialTpMonitor(supabase)
    const signalEntryPendingMonitor = new SignalEntryPendingMonitor(supabase)
    const openTradeReconcileMonitor = new OpenTradeReconcileMonitor(supabase)
    const closedTradeClosePriceMonitor = new ClosedTradeClosePriceMonitor(supabase)
    virtualPendingMonitor.start()
    registerVirtualPendingMonitor(virtualPendingMonitor)
    rangeBrokerPendingMonitor.start()
    cweCloseMonitor.start()
    partialTpMonitor.start()
    signalEntryPendingMonitor.start()
    openTradeReconcileMonitor.start()
    closedTradeClosePriceMonitor.start()
    trackMonitor(virtualPendingMonitor)
    trackMonitor(rangeBrokerPendingMonitor)
    trackMonitor(cweCloseMonitor)
    trackMonitor(partialTpMonitor)
    trackMonitor(signalEntryPendingMonitor)
    trackMonitor(openTradeReconcileMonitor)
    trackMonitor(closedTradeClosePriceMonitor)
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

    // Management-first v2 cutover: a single reconcile loop owns background
    // convergence for v2-flagged brokers (the v1 job reconciler skips them).
    if (v2EngineConfigured()) {
      const v2ReconcileMonitor = new V2ReconcileMonitor(supabase)
      v2ReconcileMonitor.start()
      trackMonitor(v2ReconcileMonitor)
    }
  }

  stopLogRetention = startTradeLogRetention(supabase)
}

async function main() {
  initializeBrokerExecutionCapability()

  if (workerConfig.runsListener) {
    const shardErr = validateListenerTradeShardConfig()
    if (shardErr) {
      console.error(`[worker] FATAL: ${shardErr}`)
      process.exit(1)
    }
    const mgmtShardErr = validateListenerMgmtShardConfig()
    if (mgmtShardErr) {
      console.error(`[worker] FATAL: ${mgmtShardErr}`)
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
    + ` instance=${workerConfig.instanceId} build=${WORKER_BUILD_TAG}`,
  )

  if (workerConfig.runsListener || workerConfig.runsBacktestHttp) {
    authService = new AuthService(supabase, sessionManager)
    httpServer = startHttpServer(authService, sessionManager)
  }

  if (workerConfig.runsTrade) {
    mtapiSessionManager = new MtapiSessionManager(supabase)
    await mtapiSessionManager.start().catch(error => {
      console.warn(
        '[worker] MTAPI session startup skipped: '
        + (error instanceof Error ? error.name : 'UNKNOWN'),
      )
    })
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
    // Register periodic lease renewal + session sync BEFORE (and independent of)
    // loadAll. Previously loadAll was awaited first, so a single hung listener
    // connect during startup (e.g. a wedged Telegram warm-up) blocked loadAll
    // forever, the renewal interval was never scheduled, and every lease expired
    // and never refreshed — taking the whole engine offline while the process
    // otherwise kept running. loadAll now runs in the background and adds
    // listeners as they connect; renewal keeps whatever is connected alive.
    setInterval(() => {
      void sessionManager.syncSessions()
    }, 30_000)

    if (workerConfig.runsListener) {
      setInterval(() => {
        void sessionManager.renewAllLeases()
      }, Math.max(10_000, Number(process.env.WORKER_LEASE_RENEW_INTERVAL_MS ?? 20_000)))

      // Kick renewal soon after boot so a restarted listener pod refreshes leases before TTL (~45s).
      setTimeout(() => {
        void sessionManager.renewAllLeases()
      }, 8_000)
    }

    void sessionManager.loadAll().catch(err =>
      console.error('[worker] loadAll failed:', err instanceof Error ? err.message : err),
    )
    void sessionManager.startChannelListenerServices().catch(err =>
      console.error('[worker] channel listener services failed:', err instanceof Error ? err.message : err),
    )
  } else if (workerConfig.runsBacktestHttp) {
    console.log('[worker] backtest-only: no live Telegram listeners loaded')
  }

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down...`)
    const shutdownStartedAt = Date.now()
    const warnAfterMs = Math.max(1_000, Math.min(30_000, Number(process.env.SENTRY_SHUTDOWN_WARN_AFTER_MS ?? 20_000)))
    const shutdownWarnTimer = setTimeout(() => {
      captureWorkerWarning('worker shutdown exceeded warning threshold', {
        subsystem: 'worker',
        operation: 'shutdown_timeout',
        errorCode: 'SHUTDOWN_TIMEOUT',
        fingerprint: ['worker', 'SHUTDOWN_TIMEOUT', workerConfig.role],
        context: {
          stage: 'shutdown',
          worker_role: workerConfig.role,
          shard_id: workerConfig.shardId,
          extra: {
            signal,
            elapsed_ms: Date.now() - shutdownStartedAt,
          },
        },
      })
    }, warnAfterMs)
    shutdownWarnTimer.unref?.()
    httpServer?.close()
    stopWorkerHeartbeatCheckIns()
    await authService?.shutdown()
    stopWorkWake?.()
    stopLogRetention?.()
    setQueueMetricsProvider(null)
    await signalQueueConsumers?.stop()
    mtapiSessionManager?.stop()
    tradeExecutor?.stop()
    for (const m of monitors) m.stop()
    if (workerConfig.runsListener) {
      await sessionManager.disconnectAll()
    }
    const drainMs = telegramShutdownDrainMs()
    console.log(`[worker] Telegram shutdown drain ${drainMs}ms before exit`)
    await new Promise(r => setTimeout(r, drainMs))
    clearTimeout(shutdownWarnTimer)
    await flushWorkerSentry(1800)
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(err => {
      captureWorkerFatalError(err, {
        subsystem: 'worker',
        operation: 'shutdown_failed',
        errorCode: 'SHUTDOWN_FAILED',
        fingerprint: ['worker', 'SHUTDOWN_FAILED', workerConfig.role],
      })
      void flushWorkerSentry(1800).finally(() => process.exit(1))
    })
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(err => {
      captureWorkerFatalError(err, {
        subsystem: 'worker',
        operation: 'shutdown_failed',
        errorCode: 'SHUTDOWN_FAILED',
        fingerprint: ['worker', 'SHUTDOWN_FAILED', workerConfig.role],
      })
      void flushWorkerSentry(1800).finally(() => process.exit(1))
    })
  })
}

main().catch(err => {
  console.error('[worker] Fatal error:', err)
  captureWorkerFatalError(err, {
    subsystem: 'worker',
    operation: 'startup_failure',
    errorCode: 'STARTUP_FAILURE',
    fingerprint: ['worker', 'STARTUP_FAILURE', workerConfig.role],
  })
  void flushWorkerSentry(1800).finally(() => process.exit(1))
})
