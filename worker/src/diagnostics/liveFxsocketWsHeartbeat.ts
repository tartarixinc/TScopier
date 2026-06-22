/**
 * Live FxSocket MT5 check — REST + WebSocket per https://fxsocket.com/docs/mt5
 *
 *   npm run load:ws:live
 *   LOAD_WS_ACCOUNT_IDS=59e57588-...:MT5 npm run load:ws:live
 */
import '../loadEnv'
import { FxsocketBrokerClient } from '../fxsocketClient'
import {
  formatFxsocketWsHeartbeatReport,
  runFxsocketWsHeartbeatLoad,
} from '../test/fxsocketWsHeartbeatLoadRunner'

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

function parsePrimaryAccount(): { accountId: string; platform: 'MT4' | 'MT5' } | null {
  const raw = (process.env.LOAD_WS_ACCOUNT_IDS ?? process.env.FXSOCKET_TEST_ACCOUNT_ID ?? '').trim()
  if (!raw) return null
  const entry = raw.split(',')[0]!.trim()
  const [id, platformRaw] = entry.split(':').map(s => s.trim())
  if (!id) return null
  const platform = platformRaw?.toUpperCase() === 'MT4' ? 'MT4' : 'MT5'
  return { accountId: id, platform }
}

const primary = parsePrimaryAccount()
if (!primary && !process.env.SUPABASE_URL) {
  console.error(
    'Set LOAD_WS_ACCOUNT_IDS=your-fxsocket-uuid:MT5 in worker/.env.local'
    + ' (FxSocket account UUID from dashboard → Accounts)',
  )
  process.exit(1)
}

const durationMs = envInt('LOAD_WS_DURATION_MS', 20_000)
const heartbeatMs = envInt('LOAD_WS_HEARTBEAT_MS', 5_000)
const accountCount = envInt('LOAD_WS_ACCOUNTS', 1)

async function runRestChecks(accountId: string, platform: 'MT4' | 'MT5'): Promise<void> {
  console.log('Step 1 — FxSocket REST (MT5 per-account base URL)')
  console.log(`  GET https://api.fxsocket.com/${platform.toLowerCase()}/${accountId}/AccountSummary`)
  console.log('')

  const api = new FxsocketBrokerClient(platform)
  api.seedPlatformCache(accountId, platform)

  const summary = await api.accountSummary(accountId)
  console.log('  AccountSummary OK')
  console.log(`    balance:  ${summary.balance ?? '—'}`)
  console.log(`    equity:   ${summary.equity ?? '—'}`)
  console.log(`    currency: ${summary.currency ?? '—'}`)

  const alive = await api.keepSessionAlive(accountId)
  console.log(`  keepSessionAlive: ${alive ? 'OK' : 'failed'}`)
  console.log('')
}

async function main(): Promise<void> {
  console.log('')
  console.log('FxSocket live account test (REST + WebSocket)')
  if (primary) {
    console.log(`  Account ID: ${primary.accountId}`)
    console.log(`  Platform:   ${primary.platform}`)
  } else {
    console.log('  Account ID: (from Supabase broker_accounts)')
  }
  console.log(`  Docs:       https://fxsocket.com/docs/mt5`)
  console.log('')

  if (primary) {
    await runRestChecks(primary.accountId, primary.platform)
  }

  console.log('Step 2 — FxSocket WebSocket stream + heartbeat')
  console.log(
    `  wss://api.fxsocket.com/${(primary?.platform ?? 'MT5').toLowerCase()}`
    + `/{account_id}/ws?api_key=...`,
  )
  console.log(`  Duration: ${(durationMs / 1000).toFixed(0)}s @ ${heartbeatMs}ms ping interval`)
  console.log('')

  const report = await runFxsocketWsHeartbeatLoad({
    accountCount,
    concurrency: 1,
    heartbeatIntervalMs: heartbeatMs,
    durationMs,
    useMockServer: false,
    onProgress: (ev) => {
      if (ev.phase === 'running') {
        process.stdout.write(
          `\r  connected: ${ev.connected}/${ev.accounts}`
          + ` | ping: ${ev.pingsSent} | pong: ${ev.pongsReceived}`
          + ` | ${(ev.elapsedMs / 1000).toFixed(1)}s   `,
        )
      }
    },
  })

  console.log('')
  console.log(formatFxsocketWsHeartbeatReport(report))

  if (report.connectedPeak < 1) {
    console.error('')
    console.error('FAILED: WebSocket did not connect.')
    console.error('If you see "unable to verify the first certificate", your network uses a TLS proxy.')
    console.error('Fix: set NODE_EXTRA_CA_CERTS to your corporate CA, or temporarily NODE_TLS_REJECT_UNAUTHORIZED=0 for local dev only.')
    process.exitCode = 1
    return
  }
  if (report.pongSuccessRate < 0.95) {
    console.error(`WARNING: pong success rate ${(report.pongSuccessRate * 100).toFixed(2)}%`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
