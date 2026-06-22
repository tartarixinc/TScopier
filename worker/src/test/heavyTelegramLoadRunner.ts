import { performance } from 'node:perf_hooks'
import { parallelMap } from '../parallelPool'
import { percentileMs } from './perfBudget'
import {
  PIPELINE_STAGE_ORDER,
  type HeavyLoadFunnel,
  type HeavyLoadReport,
  type PipelineOutcome,
  type UserDeliverySummary,
} from './pipelineOutcome'
import {
  buildHeavyLoadRequests,
  runTelegramPipelineTracked,
  type TelegramPipelineRequest,
} from './telegramPipelineStages'
import {
  LOAD_SCENARIOS,
  scenarioLabel,
  type LoadScenario,
} from './telegramPipelineFixtures'
import {
  TRADING_PLATFORMS,
  platformLabel,
} from './tradingPlatforms'

export type HeavyLoadConfig = {
  userCount: number
  minSignalsPerUser: number
  maxSignalsPerUser: number
  concurrency: number
  profile?: 'happy' | 'mixed' | 'unhappy'
  progressEvery?: number
  onProgress?: (event: HeavyLoadProgressEvent) => void
}

export type HeavyLoadProgressEvent = {
  phase: 'building' | 'running' | 'complete'
  completed: number
  total: number
  percent: number
  brokerReached: number
  elapsedMs: number
  signalsPerSec: number
}

function emptyFunnel(): HeavyLoadFunnel {
  return {
    telegram_received: 0,
    heuristic_pass: 0,
    parsed: 0,
    eligible: 0,
    dispatched: 0,
    broker_order_send: 0,
  }
}

function bumpFunnel(funnel: HeavyLoadFunnel, stage: PipelineOutcome['stageReached']): void {
  const idx = PIPELINE_STAGE_ORDER.indexOf(stage)
  for (let i = 0; i <= idx; i++) {
    funnel[PIPELINE_STAGE_ORDER[i]!] += 1
  }
}

function summarizeUsers(outcomes: PipelineOutcome[]): UserDeliverySummary[] {
  const byUser = new Map<string, UserDeliverySummary>()
  for (const o of outcomes) {
    let row = byUser.get(o.userId)
    if (!row) {
      row = {
        userId: o.userId,
        platform: o.platform,
        expectedSignals: 0,
        brokerDelivered: 0,
        allDelivered: false,
      }
      byUser.set(o.userId, row)
    }
    row.expectedSignals += 1
    if (o.brokerReached) row.brokerDelivered += 1
  }
  for (const row of byUser.values()) {
    row.allDelivered = row.brokerDelivered === row.expectedSignals
  }
  return [...byUser.values()]
}

function latencyStats(samples: number[]): HeavyLoadReport['latencyMs'] {
  if (!samples.length) {
    return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, avg: 0 }
  }
  const sum = samples.reduce((a, b) => a + b, 0)
  return {
    min: Math.min(...samples),
    p50: percentileMs(samples, 50),
    p95: percentileMs(samples, 95),
    p99: percentileMs(samples, 99),
    max: Math.max(...samples),
    avg: sum / samples.length,
  }
}

export async function runHeavyTelegramLoadTest(
  config: HeavyLoadConfig,
): Promise<{ report: HeavyLoadReport; outcomes: PipelineOutcome[] }> {
  const {
    userCount,
    minSignalsPerUser,
    maxSignalsPerUser,
    concurrency,
    profile = 'happy',
    progressEvery = Math.max(500, Math.floor(userCount / 20)),
    onProgress,
  } = config

  onProgress?.({
    phase: 'building',
    completed: 0,
    total: 0,
    percent: 0,
    brokerReached: 0,
    elapsedMs: 0,
    signalsPerSec: 0,
  })

  const requests = buildHeavyLoadRequests(
    userCount,
    minSignalsPerUser,
    maxSignalsPerUser,
    profile,
  )
  const total = requests.length
  const outcomes: PipelineOutcome[] = new Array(total)
  const funnel = emptyFunnel()
  let brokerReachedCount = 0
  let completed = 0
  const wallStart = performance.now()
  const latencySamples: number[] = []

  onProgress?.({
    phase: 'running',
    completed: 0,
    total,
    percent: 0,
    brokerReached: 0,
    elapsedMs: 0,
    signalsPerSec: 0,
  })

  await parallelMap(requests, concurrency, async (req: TelegramPipelineRequest, index) => {
    const outcome = await runTelegramPipelineTracked(req.rawMessage, req)
    outcomes[index] = outcome
    bumpFunnel(funnel, outcome.stageReached)
    if (outcome.brokerReached) {
      brokerReachedCount += 1
      if (outcome.latencyMs != null) latencySamples.push(outcome.latencyMs)
    }
    completed += 1
    if (completed % progressEvery === 0 || completed === total) {
      const elapsedMs = performance.now() - wallStart
      onProgress?.({
        phase: 'running',
        completed,
        total,
        percent: Math.round((completed / total) * 1000) / 10,
        brokerReached: brokerReachedCount,
        elapsedMs,
        signalsPerSec: elapsedMs > 0 ? (completed / elapsedMs) * 1000 : 0,
      })
    }
  })

  const wallMs = performance.now() - wallStart
  const userSummaries = summarizeUsers(outcomes.filter(Boolean))
  const usersAllSignalsOnBroker = userSummaries.filter(u => u.allDelivered).length
  const usersPartialBroker = userSummaries.filter(
    u => u.brokerDelivered > 0 && !u.allDelivered,
  ).length
  const usersNoBroker = userSummaries.filter(u => u.brokerDelivered === 0).length

  const byScenario = Object.fromEntries(
    LOAD_SCENARIOS.map(s => [s, { signals: 0, brokerReached: 0 }]),
  ) as HeavyLoadReport['byScenario']
  const failureReasons: Record<string, number> = {}
  let signalsExpectedOnBroker = 0

  for (const o of outcomes) {
    if (!o) continue
    const scenario = o.scenario ?? 'happy'
    const bucket = byScenario[scenario]
    bucket.signals += 1
    if (o.brokerReached) bucket.brokerReached += 1
    if (scenario === 'happy') signalsExpectedOnBroker += 1
    if (!o.brokerReached && o.skipReason) {
      failureReasons[o.skipReason] = (failureReasons[o.skipReason] ?? 0) + 1
    }
  }

  const byPlatform = Object.fromEntries(
    TRADING_PLATFORMS.map(p => [p, { signals: 0, brokerReached: 0, users: 0, usersAllDelivered: 0 }]),
  ) as HeavyLoadReport['byPlatform']

  for (const o of outcomes) {
  if (!o) continue
    const bucket = byPlatform[o.platform]
    bucket.signals += 1
    if (o.brokerReached) bucket.brokerReached += 1
  }
  for (const u of userSummaries) {
    const bucket = byPlatform[u.platform]
    bucket.users += 1
    if (u.allDelivered) bucket.usersAllDelivered += 1
  }

  const signalsFailed = total - brokerReachedCount

  const report: HeavyLoadReport = {
    config: {
      userCount,
      minSignalsPerUser,
      maxSignalsPerUser,
      concurrency,
      totalSignals: total,
      profile,
    },
    funnel,
    signalsFailed,
    signalsExpectedOnBroker,
    usersAllSignalsOnBroker,
    usersPartialBroker,
    usersNoBroker,
    userDeliveryRate: userCount > 0 ? usersAllSignalsOnBroker / userCount : 0,
    signalDeliveryRate: total > 0 ? brokerReachedCount / total : 0,
    byScenario,
    failureReasons,
    latencyMs: latencyStats(latencySamples),
    byPlatform,
    wallMs,
    throughputSignalsPerSec: wallMs > 0 ? (total / wallMs) * 1000 : 0,
  }

  onProgress?.({
    phase: 'complete',
    completed: total,
    total,
    percent: 100,
    brokerReached: brokerReachedCount,
    elapsedMs: wallMs,
    signalsPerSec: report.throughputSignalsPerSec,
  })

  return { report, outcomes: outcomes.filter(Boolean) }
}

export function formatHeavyLoadReport(report: HeavyLoadReport): string {
  const lines: string[] = []
  const { config: c, funnel: f } = report

  lines.push('')
  lines.push('═'.repeat(72))
  lines.push('  TSCopier heavy load — Telegram → MetaTrader / FXSocket')
  lines.push('═'.repeat(72))
  lines.push('')
  lines.push('Configuration')
  lines.push(`  Users:              ${c.userCount.toLocaleString()}`)
  lines.push(`  Signals per user:   ${c.minSignalsPerUser}–${c.maxSignalsPerUser}`)
  lines.push(`  Total signals:      ${c.totalSignals.toLocaleString()}`)
  lines.push(`  Concurrency:        ${c.concurrency}`)
  lines.push(`  Profile:            ${c.profile}`)
  lines.push(`  Wall time:          ${(report.wallMs / 1000).toFixed(2)}s`)
  lines.push(`  Throughput:         ${report.throughputSignalsPerSec.toFixed(1)} signals/sec`)
  lines.push('')
  lines.push('Pipeline funnel (how many signals reached each stage)')
  lines.push('─'.repeat(72))
  for (const stage of PIPELINE_STAGE_ORDER) {
    const count = f[stage]
    const pct = c.totalSignals > 0 ? ((count / c.totalSignals) * 100).toFixed(2) : '0.00'
    const bar = '█'.repeat(Math.min(40, Math.round((count / c.totalSignals) * 40)))
    lines.push(
      `  ${stage.padEnd(22)} ${String(count).padStart(8)}  (${pct.padStart(6)}%)  ${bar}`,
    )
  }
  lines.push('')
  lines.push('User delivery (all Telegram signals → broker OrderSend)')
  lines.push('─'.repeat(72))
  lines.push(
    `  Users with ALL signals on broker:  ${report.usersAllSignalsOnBroker.toLocaleString()}`
    + ` / ${c.userCount.toLocaleString()}`
    + ` (${(report.userDeliveryRate * 100).toFixed(2)}%)`,
  )
  lines.push(`  Users partial (some signals):    ${report.usersPartialBroker.toLocaleString()}`)
  lines.push(`  Users with NONE on broker:       ${report.usersNoBroker.toLocaleString()}`)
  lines.push(
    `  Signal delivery rate:            ${(report.signalDeliveryRate * 100).toFixed(2)}%`
    + ` (${(f.broker_order_send).toLocaleString()} / ${c.totalSignals.toLocaleString()})`,
  )
  if (c.profile !== 'happy') {
    const happyRate = report.signalsExpectedOnBroker > 0
      ? ((report.byScenario.happy?.brokerReached ?? 0) / report.signalsExpectedOnBroker * 100).toFixed(2)
      : '0.00'
    lines.push(
      `  Happy-path broker rate:          ${happyRate}%`
      + ` (${(report.byScenario.happy?.brokerReached ?? 0).toLocaleString()}`
      + ` / ${report.signalsExpectedOnBroker.toLocaleString()} expected)`,
    )
  }
  lines.push('')
  if (c.profile !== 'happy') {
    lines.push('By scenario (happy + non-happy paths)')
    lines.push('─'.repeat(72))
    for (const scenario of LOAD_SCENARIOS) {
      const b = report.byScenario[scenario]
      if (b.signals === 0) continue
      const pct = b.signals > 0 ? ((b.brokerReached / b.signals) * 100).toFixed(2) : '0.00'
      lines.push(
        `  ${scenarioLabel(scenario).slice(0, 52).padEnd(52)}`
        + ` ${String(b.brokerReached).padStart(6)} / ${String(b.signals).padStart(6)} (${pct}%)`,
      )
    }
    lines.push('')
    lines.push('Failure reasons (signals that did not reach broker)')
    lines.push('─'.repeat(72))
    const reasons = Object.entries(report.failureReasons).sort((a, b) => b[1] - a[1])
    if (reasons.length === 0) {
      lines.push('  (none)')
    } else {
      for (const [reason, count] of reasons) {
        lines.push(`  ${reason.padEnd(40)} ${count.toLocaleString()}`)
      }
    }
    lines.push('')
  }
  lines.push('Latency (worker-side, Telegram → first OrderSend, successful only)')
  lines.push('─'.repeat(72))
  const l = report.latencyMs
  lines.push(`  min: ${l.min.toFixed(2)}ms  p50: ${l.p50.toFixed(2)}ms  p95: ${l.p95.toFixed(2)}ms`
    + `  p99: ${l.p99.toFixed(2)}ms  max: ${l.max.toFixed(2)}ms  avg: ${l.avg.toFixed(2)}ms`)
  lines.push('')
  lines.push('By trading platform')
  lines.push('─'.repeat(72))
  for (const p of TRADING_PLATFORMS) {
    const b = report.byPlatform[p]
    const sigPct = b.signals > 0 ? ((b.brokerReached / b.signals) * 100).toFixed(2) : '0.00'
    const usrPct = b.users > 0 ? ((b.usersAllDelivered / b.users) * 100).toFixed(2) : '0.00'
    lines.push(
      `  ${platformLabel(p).padEnd(18)} signals: ${String(b.brokerReached).padStart(7)}`
      + ` / ${String(b.signals).padStart(7)} (${sigPct}%)`
      + `   users all-delivered: ${b.usersAllDelivered} / ${b.users} (${usrPct}%)`,
    )
  }
  lines.push('')
  lines.push('═'.repeat(72))
  lines.push('')
  return lines.join('\n')
}
