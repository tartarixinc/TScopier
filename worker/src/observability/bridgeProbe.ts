/*
 * Bridge probe — the standalone liveness check for the MTAPI bridge containers
 * behind nginx (deploy/mt4-bridge/). Writes results to the database through
 * the record_probe_result RPC (compare-and-set, safe for concurrent probers).
 *
 * Why it exists: the bridge emits no telemetry of its own and the 2026-10-08
 * outage ran overnight because nothing watched it. The worker already talks to
 * the bridge, so the probe lives here — but its results go to the probe tables
 * AND through the shared BridgeHealthTracker, so Sentry and the admin dashboard
 * always agree.
 *
 * URL candidates (verified against deploy/mt4-bridge/05-nginx.sh, which asserts
 * 200 on both public paths):
 *   bridge_mt5: <base>/health      (nginx), <base>/Ping      (direct container)
 *   bridge_mt4: <base>/mt4/Ping    (nginx from a root base), <base>/Ping
 *              (direct container, or an MTAPI_MT4_BASE_URL that already ends in /mt4)
 * The first candidate that answers 200 wins; a non-200 on every candidate is
 * DOWN — that is exactly the nginx-up / backend-down (502) signature of the
 * 2026-10-08 incident.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ProbeTarget {
  target: string
  urls: string[]
}

export interface ProbeOutcome {
  target: string
  state: 'up' | 'down'
  latencyMs: number | null
  detail: string
}

type EnvLike = Record<string, string | undefined>

function trimBase(value: string | undefined): string {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

export function buildProbeTargets(env: EnvLike): ProbeTarget[] {
  const mt5Base = trimBase(env.MTAPI_MT5_BASE_URL) || trimBase(env.MTAPI_BASE_URL)
  const mt4Base = trimBase(env.MTAPI_MT4_BASE_URL) || trimBase(env.MTAPI_BASE_URL)
  const targets: ProbeTarget[] = []

  if (mt5Base) {
    targets.push({ target: 'bridge_mt5', urls: [`${mt5Base}/health`, `${mt5Base}/Ping`] })
  }
  if (mt4Base) {
    const urls = mt4Base.endsWith('/mt4')
      ? [`${mt4Base}/Ping`]
      : [`${mt4Base}/mt4/Ping`, `${mt4Base}/Ping`]
    targets.push({ target: 'bridge_mt4', urls })
  }

  // Optional operator override, e.g. BRIDGE_PROBE_TARGETS=bridge_mt5
  const only = String(env.BRIDGE_PROBE_TARGETS ?? '').trim()
  if (!only) return targets
  const allow = new Set(only.split(',').map(s => s.trim()).filter(Boolean))
  return targets.filter(t => allow.has(t.target))
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ status: number | null; error: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'GET', signal: controller.signal })
    return { status: res.status, error: null }
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.name : 'UNKNOWN' }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeTarget(
  t: ProbeTarget,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const attempts: string[] = []
  const startedAt = Date.now()
  for (const url of t.urls) {
    const { status, error } = await fetchWithTimeout(fetchImpl, url, timeoutMs)
    if (status === 200) {
      return {
        target: t.target,
        state: 'up',
        latencyMs: Date.now() - startedAt,
        detail: `200 ${url}`,
      }
    }
    attempts.push(error ? `${url} ${error}` : `${url} HTTP_${status}`)
  }
  return {
    target: t.target,
    state: 'down',
    latencyMs: null,
    detail: attempts.join(' | ').slice(0, 400),
  }
}

export interface BridgeProbeOptions {
  supabase: SupabaseClient
  /** Poll interval; caller resolves it from env with the shared resolver. */
  intervalMs: number
  /** Per-URL timeout; caller resolves it from env. */
  timeoutMs: number
  /** Probe runs only on shard 0 (see MtapiSessionManager.start). */
  enabled: boolean
  env?: EnvLike
  fetchImpl?: typeof fetch
  /** Called after every full pass with the aggregate state (down if any target is down). */
  onAggregate?: (state: 'up' | 'down') => void
}

export class BridgeProbe {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly targets: ProbeTarget[]
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: BridgeProbeOptions) {
    this.targets = buildProbeTargets(options.env ?? process.env)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get probeTargets(): ProbeTarget[] {
    return this.targets
  }

  start(): void {
    if (!this.options.enabled) return
    if (this.timer) return // already started — never leak a second interval
    if (this.targets.length === 0) {
      console.warn('[bridgeProbe] no targets — MTAPI_BASE_URL not configured')
      return
    }
    this.running = true
    void this.runOnce()
      .catch(error => {
        console.warn('[bridgeProbe] initial probe failed code=' + (error instanceof Error ? error.name : 'UNKNOWN'))
      })
      .finally(() => { this.running = false })
    this.timer = setInterval(() => {
      if (this.running) return
      this.running = true
      void this.runOnce()
        .catch(error => {
          console.warn('[bridgeProbe] probe failed code=' + (error instanceof Error ? error.name : 'UNKNOWN'))
        })
        .finally(() => { this.running = false })
    }, this.options.intervalMs)
    this.timer.unref?.()
    console.info(
      `[bridgeProbe] started interval=${this.options.intervalMs}ms targets=${this.targets.map(t => t.target).join(',')}`,
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async runOnce(): Promise<void> {
    if (this.targets.length === 0) return
    let aggregate: 'up' | 'down' = 'up'
    for (const target of this.targets) {
      const outcome = await probeTarget(target, this.fetchImpl, this.options.timeoutMs)
      if (outcome.state === 'down') aggregate = 'down'
      const { error } = await this.options.supabase.rpc('record_probe_result', {
        p_target: outcome.target,
        p_state: outcome.state,
        p_latency_ms: outcome.latencyMs,
        p_detail: outcome.detail,
      })
      if (error) {
        console.warn(`[bridgeProbe] persist failed target=${outcome.target} code=${error.message}`)
      }
      if (outcome.state === 'down') {
        console.warn(`[bridgeProbe] DOWN target=${outcome.target} detail=${outcome.detail}`)
      }
    }
    this.options.onAggregate?.(aggregate)
  }
}
