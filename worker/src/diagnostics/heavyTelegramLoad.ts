/**
 * CLI: heavy Telegram → MT4/MT5/FXSocket load simulation.
 *
 * Usage:
 *   npm run load:stress
 *   LOAD_PROFILE=mixed LOAD_USERS=5000 npm run load:stress
 *   LOAD_WS_ACCOUNTS=5000 LOAD_WS_DURATION_MS=15000 npm run load:stress
 */
import '../loadEnv'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  formatFxsocketWsHeartbeatReport,
  runFxsocketWsHeartbeatLoad,
  type FxsocketWsHeartbeatProgress,
} from '../test/fxsocketWsHeartbeatLoadRunner'
import {
  formatHeavyLoadReport,
  runHeavyTelegramLoadTest,
  type HeavyLoadProgressEvent,
} from '../test/heavyTelegramLoadRunner'

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

function envProfile(): 'happy' | 'mixed' | 'unhappy' {
  const p = (process.env.LOAD_PROFILE ?? 'happy').toLowerCase()
  if (p === 'mixed' || p === 'unhappy') return p
  return 'happy'
}

const userCount = envInt('LOAD_USERS', 5000)
const minSignals = envInt('LOAD_MIN_SIGNALS', 4)
const maxSignals = envInt('LOAD_MAX_SIGNALS', 10)
const concurrency = envInt('LOAD_CONCURRENCY', 24)
const profile = envProfile()
const writeJson = process.env.LOAD_WRITE_JSON === '1'
const runWsHeartbeat = process.env.LOAD_SKIP_WS_HEARTBEAT !== '1'
const wsAccounts = envInt('LOAD_WS_ACCOUNTS', userCount)
const wsDurationMs = envInt('LOAD_WS_DURATION_MS', 12_000)
const wsHeartbeatMs = envInt('LOAD_WS_HEARTBEAT_MS', 5_000)
const wsConcurrency = envInt('LOAD_WS_CONCURRENCY', Math.min(32, concurrency))

function printPipelineProgress(ev: HeavyLoadProgressEvent): void {
  if (ev.phase === 'building') {
    console.log('\n[1/4] Building user population and signal matrix…')
    return
  }
  if (ev.phase === 'running') {
    const barLen = 30
    const filled = Math.round((ev.percent / 100) * barLen)
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
    process.stdout.write(
      `\r[2/4] Telegram pipeline ${bar} ${ev.percent.toFixed(1)}%`
      + ` | ${ev.completed.toLocaleString()}/${ev.total.toLocaleString()} signals`
      + ` | broker: ${ev.brokerReached.toLocaleString()}`
      + ` | ${ev.signalsPerSec.toFixed(0)}/s`
      + ` | ${(ev.elapsedMs / 1000).toFixed(1)}s   `,
    )
    if (ev.completed === ev.total) console.log('')
    return
  }
  console.log('[2/4] Telegram pipeline complete.')
}

function printWsProgress(ev: FxsocketWsHeartbeatProgress): void {
  if (ev.phase === 'starting') {
    console.log('\n[3/4] FxSocket WebSocket heartbeat load (mock upstream)…')
    return
  }
  if (ev.phase === 'running') {
    process.stdout.write(
      `\r[3/4] WS heartbeat | connected: ${ev.connected.toLocaleString()}`
      + ` / ${ev.accounts.toLocaleString()}`
      + ` | failed: ${ev.connectFailures.toLocaleString()}`
      + ` | ping: ${ev.pingsSent.toLocaleString()}`
      + ` | pong: ${ev.pongsReceived.toLocaleString()}`
      + ` | timeouts: ${ev.timeouts}`
      + ` | ${(ev.elapsedMs / 1000).toFixed(1)}s   `,
    )
    return
  }
  console.log('\n[3/4] FxSocket WebSocket heartbeat complete.')
}

async function main(): Promise<void> {
  console.log('')
  console.log('TSCopier heavy load test')
  console.log(`  ${userCount.toLocaleString()} users × ${minSignals}-${maxSignals} Telegram signals each`)
  console.log(`  Profile: ${profile} (happy = all succeed; mixed/unhappy = failure paths)`)
  console.log(`  Platforms: MetaTrader 4, MetaTrader 5 via FxSocket REST + WebSocket`)
  console.log(`  Concurrency: ${concurrency}`)
  if (runWsHeartbeat) {
    console.log(
      `  WS heartbeat: ${wsAccounts.toLocaleString()} accounts × ${(wsDurationMs / 1000).toFixed(0)}s`
      + ` @ ${wsHeartbeatMs}ms interval`,
    )
  }
  console.log('')

  const { report, outcomes } = await runHeavyTelegramLoadTest({
    userCount,
    minSignalsPerUser: minSignals,
    maxSignalsPerUser: maxSignals,
    concurrency,
    profile,
    onProgress: printPipelineProgress,
  })

  console.log('[4/4] Reports')
  console.log(formatHeavyLoadReport(report))

  let wsReport = null
  if (runWsHeartbeat) {
    wsReport = await runFxsocketWsHeartbeatLoad({
      accountCount: wsAccounts,
      concurrency: wsConcurrency,
      heartbeatIntervalMs: wsHeartbeatMs,
      durationMs: wsDurationMs,
      useMockServer: process.env.LOAD_WS_LIVE !== '1',
      onProgress: printWsProgress,
    })
    console.log(formatFxsocketWsHeartbeatReport(wsReport))
  }

  if (writeJson) {
    const outPath = resolve(process.cwd(), `heavy-load-report-${Date.now()}.json`)
    writeFileSync(
      outPath,
      JSON.stringify({ report, wsReport, sampleOutcomes: outcomes.slice(0, 50) }, null, 2),
      'utf8',
    )
    console.log(`JSON report written: ${outPath}`)
  }

  if (profile === 'happy' && report.signalDeliveryRate < 1) {
    console.error(
      `WARNING: ${report.signalsFailed.toLocaleString()} signals did not reach broker OrderSend.`,
    )
    process.exitCode = 1
  }

  if (wsReport && wsReport.pongSuccessRate < 0.95 && wsReport.connectedPeak > 0) {
    console.error(
      `WARNING: FxSocket WS heartbeat pong success rate ${(wsReport.pongSuccessRate * 100).toFixed(2)}%`,
    )
    process.exitCode = 1
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
