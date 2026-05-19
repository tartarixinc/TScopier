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
import { AutoManagementMonitor } from './autoManagementMonitor'
import { TrailingStopMonitor } from './trailingStopMonitor'
import { BasketSlTpReconcileMonitor } from './basketSlTpReconcileMonitor'
import { NewsTradingMonitor } from './newsTradingMonitor'
import { BrokerConnectionMonitor } from './brokerConnectionMonitor'
import { workerConfig } from './workerConfig'
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

const monitors: Array<{ stop: () => void }> = []

function startTradeMonitors() {
  if (workerConfig.runsExecutionMonitors) {
    const virtualPendingMonitor = new VirtualPendingMonitor(supabase)
    const cweCloseMonitor = new CweCloseMonitor(supabase)
    const partialTpMonitor = new PartialTpMonitor(supabase)
    const signalEntryPendingMonitor = new SignalEntryPendingMonitor(supabase)
    virtualPendingMonitor.start()
    cweCloseMonitor.start()
    partialTpMonitor.start()
    signalEntryPendingMonitor.start()
    monitors.push(
      virtualPendingMonitor,
      cweCloseMonitor,
      partialTpMonitor,
      signalEntryPendingMonitor,
    )
  }

  if (workerConfig.runsTrade) {
    const brokerConnectionMonitor = new BrokerConnectionMonitor(supabase)
    brokerConnectionMonitor.start()
    monitors.push(brokerConnectionMonitor)
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
    monitors.push(
      trailingStopMonitor,
      autoManagementMonitor,
      basketSlTpReconcileMonitor,
      newsTradingMonitor,
    )
  }
}

async function main() {
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
    startTradeMonitors()
    if (!httpServer) {
      httpServer = startTradeHttpServer(sessionManager, tradeExecutor)
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
