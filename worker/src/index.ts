import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import { UserSessionManager } from './sessionManager'
import { AuthService } from './authService'
import { startHttpServer } from './httpServer'
import { ManagementWorker } from './managementWorker'

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
const managementWorker = new ManagementWorker(supabase)

async function main() {
  console.log('[worker] TSCopier Telegram worker starting...')

  await sessionManager.loadAll()
  managementWorker.start()

  setInterval(async () => {
    await sessionManager.syncSessions()
  }, 30_000)

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, shutting down...`)
    httpServer.close()
    authService.shutdown()
    managementWorker.stop()
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
