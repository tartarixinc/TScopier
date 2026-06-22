import { performance } from 'node:perf_hooks'
import { FxsocketWsClient } from '../fxsocketWsClient'
import { parallelMap } from '../parallelPool'
import {
  mockWsSoftCap,
  resolveWsLoadAccounts,
  warnIfMockAccountCountHigh,
  type WsLoadAccountSource,
} from './fxsocketWsLoadAccounts'
import { startFxsocketMockWsServer } from './fxsocketWsMockServer'

export type FxsocketWsHeartbeatLoadConfig = {
  accountCount: number
  concurrency: number
  heartbeatIntervalMs: number
  durationMs: number
  platform?: 'MT4' | 'MT5'
  useMockServer?: boolean
  onProgress?: (ev: FxsocketWsHeartbeatProgress) => void
}

export type FxsocketWsHeartbeatProgress = {
  phase: 'starting' | 'running' | 'complete'
  accounts: number
  connected: number
  connectFailures: number
  pingsSent: number
  pongsReceived: number
  timeouts: number
  elapsedMs: number
}

export type FxsocketWsHeartbeatLoadReport = {
  accountCount: number
  durationMs: number
  wallMs: number
  connectedPeak: number
  connectFailures: number
  connectSuccessRate: number
  pingsSent: number
  pongsReceived: number
  timeouts: number
  reconnects: number
  pongSuccessRate: number
  avgPingsPerAccount: number
  usedMockServer: boolean
  accountIdSource: WsLoadAccountSource
  mockSoftCap: number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function runFxsocketWsHeartbeatLoad(
  config: FxsocketWsHeartbeatLoadConfig,
): Promise<FxsocketWsHeartbeatLoadReport> {
  const {
    accountCount,
    concurrency,
    heartbeatIntervalMs,
    durationMs,
    platform = 'MT5',
    useMockServer = true,
    onProgress,
  } = config

  warnIfMockAccountCountHigh(accountCount, useMockServer)

  onProgress?.({
    phase: 'starting',
    accounts: accountCount,
    connected: 0,
    connectFailures: 0,
    pingsSent: 0,
    pongsReceived: 0,
    timeouts: 0,
    elapsedMs: 0,
  })

  const resolved = await resolveWsLoadAccounts(accountCount, useMockServer)
  const accounts = resolved.accounts

  const mock = useMockServer ? await startFxsocketMockWsServer({ respondToPing: true }) : null
  const baseUrl = mock?.httpBaseUrl ?? process.env.FXSOCKET_BASE_URL
  const apiKey = process.env.FXSOCKET_API_KEY ?? 'load-test-key'

  const clients: FxsocketWsClient[] = []
  let reconnects = 0
  let connectedPeak = 0
  let connectFailures = 0
  const openTimeoutMs = useMockServer ? 8_000 : 20_000

  const wallStart = performance.now()

  await parallelMap(
    accounts,
    concurrency,
    async (account) => {
      const client = new FxsocketWsClient({
        accountId: account.accountId,
        apiKey,
        baseUrl,
        platform: account.platform ?? platform,
        heartbeatIntervalMs,
        reconnect: !useMockServer,
        reconnectDelayMs: 500,
        onConnectionChange: (connected) => {
          if (connected) reconnects += 1
        },
      })
      clients.push(client)
      client.subscribe({ topic: 'account' })
      client.subscribe({ topic: 'positions' })
      try {
        await client.whenOpen(openTimeoutMs)
      } catch {
        connectFailures += 1
      }
    },
  )

  const progressEvery = Math.max(250, Math.floor(durationMs / 20))
  let lastProgress = wallStart

  while (performance.now() - wallStart < durationMs) {
    await sleep(Math.min(progressEvery, durationMs))
    const connected = clients.filter(c => c.connected).length
    connectedPeak = Math.max(connectedPeak, connected)
    const pingsSent = clients.reduce((n, c) => n + c.heartbeatStats.pingsSent, 0)
    const pongsReceived = clients.reduce((n, c) => n + c.heartbeatStats.pongsReceived, 0)
    const timeouts = clients.reduce((n, c) => n + c.heartbeatStats.timeouts, 0)
    const elapsedMs = performance.now() - wallStart
    if (elapsedMs - (lastProgress - wallStart) >= progressEvery || elapsedMs >= durationMs) {
      lastProgress = performance.now()
      onProgress?.({
        phase: 'running',
        accounts: accounts.length,
        connected,
        connectFailures,
        pingsSent,
        pongsReceived,
        timeouts,
        elapsedMs,
      })
    }
  }

  const pingsSent = clients.reduce((n, c) => n + c.heartbeatStats.pingsSent, 0)
  const pongsReceived = clients.reduce((n, c) => n + c.heartbeatStats.pongsReceived, 0)
  const timeouts = clients.reduce((n, c) => n + c.heartbeatStats.timeouts, 0)
  const wallMs = performance.now() - wallStart

  for (const client of clients) client.close()
  await sleep(300)
  if (mock) await mock.close()

  const report: FxsocketWsHeartbeatLoadReport = {
    accountCount: accounts.length,
    durationMs,
    wallMs,
    connectedPeak,
    connectFailures,
    connectSuccessRate: accounts.length > 0 ? connectedPeak / accounts.length : 0,
    pingsSent,
    pongsReceived,
    timeouts,
    reconnects: Math.max(0, reconnects - connectedPeak),
    pongSuccessRate: pingsSent > 0 ? pongsReceived / pingsSent : 0,
    avgPingsPerAccount: accounts.length > 0 ? pingsSent / accounts.length : 0,
    usedMockServer: useMockServer,
    accountIdSource: resolved.source,
    mockSoftCap: mockWsSoftCap(),
  }

  onProgress?.({
    phase: 'complete',
    accounts: accounts.length,
    connected: 0,
    connectFailures,
    pingsSent,
    pongsReceived,
    timeouts,
    elapsedMs: wallMs,
  })

  return report
}

export function formatFxsocketWsHeartbeatReport(report: FxsocketWsHeartbeatLoadReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push('═'.repeat(72))
  lines.push('  FxSocket WebSocket heartbeat load (MT4/MT5 upstream streams)')
  lines.push('═'.repeat(72))
  lines.push('')
  lines.push(`  Accounts requested: ${report.accountCount.toLocaleString()}`)
  lines.push(`  Account ID source:  ${report.accountIdSource}`)
  lines.push(`  Duration:           ${(report.durationMs / 1000).toFixed(1)}s (wall ${(report.wallMs / 1000).toFixed(1)}s)`)
  lines.push(`  Mock server:        ${report.usedMockServer ? `yes (in-process, soft cap ${report.mockSoftCap})` : 'no (live FxSocket API)'}`)
  lines.push(`  Peak connected:     ${report.connectedPeak.toLocaleString()}`)
  lines.push(`  Connect failures:   ${report.connectFailures.toLocaleString()}`)
  lines.push(`  Connect success:    ${(report.connectSuccessRate * 100).toFixed(2)}%`)
  lines.push(`  Pings sent:         ${report.pingsSent.toLocaleString()}`)
  lines.push(`  Pongs received:     ${report.pongsReceived.toLocaleString()}`)
  lines.push(`  Heartbeat timeouts: ${report.timeouts.toLocaleString()}`)
  lines.push(`  Reconnects:         ${report.reconnects.toLocaleString()}`)
  lines.push(
    `  Pong success rate:  ${(report.pongSuccessRate * 100).toFixed(2)}%`
    + ` (avg ${report.avgPingsPerAccount.toFixed(1)} pings/account)`,
  )
  if (report.usedMockServer && report.accountCount > report.mockSoftCap) {
    lines.push('')
    lines.push('  Note: mock mode cannot realistically hold thousands of WS sockets on one')
    lines.push('  local process. For live FxSocket use LOAD_WS_LIVE=1 with real account UUIDs.')
  }
  if (!report.usedMockServer && report.accountIdSource !== 'mock') {
    lines.push('')
    lines.push('  Live mode uses FxSocket terminal UUIDs from LOAD_WS_ACCOUNT_IDS or broker_accounts.')
  }
  lines.push('')
  lines.push('═'.repeat(72))
  lines.push('')
  return lines.join('\n')
}
