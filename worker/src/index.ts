import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { UserSessionManager } from './sessionManager'
import { AuthService } from './authService'
import { startHttpServer } from './httpServer'
import { TradeExecutor } from './tradeExecutor'
import { VirtualPendingMonitor } from './virtualPendingMonitor'
import { CweCloseMonitor } from './cweCloseMonitor'
import { PartialTpMonitor } from './partialTpMonitor'

// Supabase Realtime needs a WebSocket transport in Node < 22.
// Railway is currently running Node 20, so we provide ws explicitly.
if (!globalThis.WebSocket) {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const sessionManager = new UserSessionManager(supabase)
const authService = new AuthService(supabase, sessionManager)
const httpServer = startHttpServer(authService, sessionManager)
const tradeExecutor = new TradeExecutor(supabase)
const virtualPendingMonitor = new VirtualPendingMonitor(supabase)
const cweCloseMonitor = new CweCloseMonitor(supabase)
const partialTpMonitor = new PartialTpMonitor(supabase)

async function main() {
  console.log('[worker] TSCopier Telegram worker starting...')

  await sessionManager.loadAll()
  await tradeExecutor.start()
  virtualPendingMonitor.start()
  cweCloseMonitor.start()
  partialTpMonitor.start()

  setInterval(async () => {
    await sessionManager.syncSessions()
  }, 30_000)

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down...`)
    httpServer.close()
    authService.shutdown()
    tradeExecutor.stop()
    virtualPendingMonitor.stop()
    cweCloseMonitor.stop()
    partialTpMonitor.stop()
    await sessionManager.disconnectAll()
    process.exit(0)
  }

  process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)) })
  process.on('SIGINT',  () => { shutdown('SIGINT').catch(() => process.exit(1)) })
}

main().catch(err => {
  console.error('[worker] Fatal error:', err)
  process.exit(1)
})
