/**
 * Production pipeline latency regression report.
 *
 * Compares recent pipeline_summary timings vs a 7-day baseline from trade_execution_logs.
 *
 * Usage:
 *   cd worker && npm run latency-report
 *
 * Env:
 *   LATENCY_CURRENT_HOURS   default 6
 *   LATENCY_BASELINE_DAYS   default 7
 *   LATENCY_REGRESSION_PCT  flag when p50 or p95 total_ms rises more than this % (default 25)
 */
import 'dotenv/config'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { PREP_SUBSTAGE_KEYS } from '../pipelineTimestamps'

const STAGE_KEYS = [
  'total_ms',
  'listener_to_dispatch_ms',
  'parse_ms',
  'dispatch_ms',
  'prep_ms',
  ...PREP_SUBSTAGE_KEYS,
  'order_send_ms',
  'broker_send_ms',
  'broker_resolve_ms',
  'queue_wait_ms',
] as const

type StageKey = (typeof STAGE_KEYS)[number]

type PipelinePayload = Partial<Record<StageKey, number>> & {
  live_fast?: boolean | string
  dispatch_source?: string
  brokers_warm_at_dispatch?: boolean | string
}

type LogRow = {
  user_id: string
  request_payload: PipelinePayload | null
  created_at: string
}

type WindowStats = {
  label: string
  from: string
  to: string
  samples: number
  slowCount: number
  percentiles: Partial<Record<StageKey, { p50: number; p95: number; p99: number }>>
}

const CURRENT_HOURS = Math.max(1, Number(process.env.LATENCY_CURRENT_HOURS ?? 6))
const BASELINE_DAYS = Math.max(1, Number(process.env.LATENCY_BASELINE_DAYS ?? 7))
const REGRESSION_PCT = Math.max(1, Number(process.env.LATENCY_REGRESSION_PCT ?? 25))
const SLOW_PIPELINE_MS = 4000
const PAGE_SIZE = 1000

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

function stagePercentiles(values: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  }
}

function extractPayload(row: LogRow): PipelinePayload | null {
  const p = row.request_payload
  if (!p || typeof p !== 'object') return null
  if (String(p.live_fast ?? 'false') !== 'true') return null
  const total = num(p.total_ms)
  if (total == null) return null
  return p
}

async function fetchPipelineRows(
  supabase: SupabaseClient,
  from: Date,
  to: Date,
): Promise<LogRow[]> {
  const rows: LogRow[] = []
  let offset = 0

  while (true) {
    const { data, error } = await supabase
      .from('trade_execution_logs')
      .select('user_id,request_payload,created_at')
      .eq('action', 'pipeline_summary')
      .gte('created_at', from.toISOString())
      .lt('created_at', to.toISOString())
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) throw new Error(`fetch pipeline_summary: ${error.message}`)
    const batch = (data ?? []) as LogRow[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return rows
}

function buildWindowStats(label: string, from: Date, to: Date, rows: LogRow[]): WindowStats {
  const payloads = rows.map(extractPayload).filter((p): p is PipelinePayload => p != null)
  const byStage: Partial<Record<StageKey, number[]>> = {}
  let slowCount = 0

  for (const p of payloads) {
    const total = num(p.total_ms)
    if (total != null && total > SLOW_PIPELINE_MS) slowCount += 1
    for (const key of STAGE_KEYS) {
      const v = num(p[key])
      if (v == null) continue
      ;(byStage[key] ??= []).push(v)
    }
  }

  const percentiles: WindowStats['percentiles'] = {}
  for (const key of STAGE_KEYS) {
    const vals = byStage[key]
    if (!vals?.length) continue
    percentiles[key] = stagePercentiles(vals)
  }

  return {
    label,
    from: from.toISOString(),
    to: to.toISOString(),
    samples: payloads.length,
    slowCount,
    percentiles,
  }
}

function pctChange(current: number, baseline: number): string {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return 'n/a'
  const pct = ((current - baseline) / baseline) * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function fmtMs(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${Math.round(v)}`
}

function printComparison(current: WindowStats, baseline: WindowStats): boolean {
  console.log('=== Pipeline latency regression ===\n')
  console.log(`Current window:  last ${CURRENT_HOURS}h (${current.samples} live_fast samples)`)
  console.log(`Baseline window: prior ${BASELINE_DAYS}d excluding current (${baseline.samples} samples)`)
  console.log(`Slow pipelines (>${SLOW_PIPELINE_MS}ms): current=${current.slowCount}, baseline=${baseline.slowCount}\n`)

  if (current.samples === 0) {
    console.log('No pipeline_summary samples in current window — widen LATENCY_CURRENT_HOURS or check copier activity.')
    return false
  }
  if (baseline.samples === 0) {
    console.log('No baseline samples — cannot compute regression.')
    return false
  }

  const header = ['stage', 'current_p50', 'baseline_p50', 'change', 'current_p95', 'baseline_p95', 'change_p95']
  console.log(header.join('\t'))
  console.log('-'.repeat(90))

  let regressed = false
  for (const key of STAGE_KEYS) {
    const c = current.percentiles[key]
    const b = baseline.percentiles[key]
    if (!c || !b) continue
    const changeP50 = pctChange(c.p50, b.p50)
    const changeP95 = pctChange(c.p95, b.p95)
    if (key === 'total_ms') {
      const p50Pct = ((c.p50 - b.p50) / b.p50) * 100
      const p95Pct = ((c.p95 - b.p95) / b.p95) * 100
      if (p50Pct > REGRESSION_PCT || p95Pct > REGRESSION_PCT) regressed = true
    }
    console.log(
      [
        key,
        fmtMs(c.p50),
        fmtMs(b.p50),
        changeP50,
        fmtMs(c.p95),
        fmtMs(b.p95),
        changeP95,
      ].join('\t'),
    )
  }

  console.log()
  if (regressed) {
    console.log(`REGRESSION: p50 or p95 total_ms rose more than ${REGRESSION_PCT}% vs baseline.`)
  } else {
    console.log(`OK: total_ms within ${REGRESSION_PCT}% of baseline (p50/p95).`)
  }
  return regressed
}

function printDispatchBreakdown(rows: LogRow[]) {
  const bySource = new Map<string, number[]>()
  for (const row of rows) {
    const p = extractPayload(row)
    if (!p) continue
    const total = num(p.total_ms)
    if (total == null) continue
    const src = String(p.dispatch_source ?? 'unknown')
    if (!bySource.has(src)) bySource.set(src, [])
    bySource.get(src)!.push(total)
  }
  if (bySource.size === 0) return

  console.log('\n=== dispatch_source (current window) ===')
  for (const [src, vals] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const p = stagePercentiles(vals)
    console.log(`  ${src}: n=${vals.length} p50=${fmtMs(p.p50)} p95=${fmtMs(p.p95)}`)
  }
}

function printPrepSubstages(rows: LogRow[]) {
  const byKey = new Map<string, number[]>()
  for (const row of rows) {
    const p = extractPayload(row)
    if (!p) continue
    for (const key of PREP_SUBSTAGE_KEYS) {
      const v = num(p[key])
      if (v == null || v <= 0) continue
      if (!byKey.has(key)) byKey.set(key, [])
      byKey.get(key)!.push(v)
    }
  }
  if (byKey.size === 0) return

  console.log('\n=== prep_ms substages (current window, samples with value > 0) ===')
  for (const key of PREP_SUBSTAGE_KEYS) {
    const vals = byKey.get(key)
    if (!vals?.length) continue
    const p = stagePercentiles(vals)
    console.log(`  ${key}: n=${vals.length} p50=${fmtMs(p.p50)} p95=${fmtMs(p.p95)}`)
  }
}

function printWarmCold(rows: LogRow[]) {
  const warm: number[] = []
  const cold: number[] = []
  for (const row of rows) {
    const p = extractPayload(row)
    if (!p) continue
    const total = num(p.total_ms)
    if (total == null) continue
    if (String(p.brokers_warm_at_dispatch ?? 'false') === 'true') warm.push(total)
    else cold.push(total)
  }
  if (!warm.length && !cold.length) return

  console.log('\n=== brokers_warm_at_dispatch (current window) ===')
  if (warm.length) {
    const p = stagePercentiles(warm)
    console.log(`  warm:  n=${warm.length} p50=${fmtMs(p.p50)} p95=${fmtMs(p.p95)}`)
  }
  if (cold.length) {
    const p = stagePercentiles(cold)
    console.log(`  cold:  n=${cold.length} p50=${fmtMs(p.p50)} p95=${fmtMs(p.p95)}`)
  }
}

function printWorstUsers(rows: LogRow[]) {
  const byUser = new Map<string, number[]>()
  for (const row of rows) {
    const p = extractPayload(row)
    if (!p) continue
    const total = num(p.total_ms)
    if (total == null) continue
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, [])
    byUser.get(row.user_id)!.push(total)
  }

  const worst = [...byUser.entries()]
    .filter(([, vals]) => vals.length >= 5)
    .map(([userId, vals]) => ({ userId, n: vals.length, p99: stagePercentiles(vals).p99 }))
    .sort((a, b) => b.p99 - a.p99)
    .slice(0, 10)

  if (!worst.length) return
  console.log('\n=== Worst users by p99 total_ms (current, min 5 samples) ===')
  for (const w of worst) {
    console.log(`  ${w.userId}: n=${w.n} p99=${fmtMs(w.p99)}`)
  }
}

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in worker/.env')
    process.exit(2)
  }

  const supabase = createClient(url, key)
  const now = new Date()
  const currentStart = new Date(now.getTime() - CURRENT_HOURS * 3600_000)
  const baselineStart = new Date(now.getTime() - BASELINE_DAYS * 86400_000)

  console.log(`Supabase: ${url.replace(/https?:\/\//, '').split('/')[0]}`)
  console.log(`Fetching pipeline_summary rows...\n`)

  const [currentRows, baselineRows] = await Promise.all([
    fetchPipelineRows(supabase, currentStart, now),
    fetchPipelineRows(supabase, baselineStart, currentStart),
  ])

  const current = buildWindowStats('current', currentStart, now, currentRows)
  const baseline = buildWindowStats('baseline', baselineStart, currentStart, baselineRows)

  const regressed = printComparison(current, baseline)
  printDispatchBreakdown(currentRows)
  printPrepSubstages(currentRows)
  printWarmCold(currentRows)
  printWorstUsers(currentRows)

  console.log('\nDeeper drill-down: scripts/diagnostics/pipeline_latency_regression.sql')
  process.exit(regressed ? 1 : 0)
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
