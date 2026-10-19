import { strict as assert } from 'node:assert'
import { afterEach, test } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BridgeHealthTracker } from './bridgeHealthTracker'
import { BridgeProbe, buildProbeTargets, probeTarget, type ProbeTarget } from './bridgeProbe'

const oldBase = process.env.MTAPI_BASE_URL
const oldMt4 = process.env.MTAPI_MT4_BASE_URL
const oldMt5 = process.env.MTAPI_MT5_BASE_URL
const oldOnly = process.env.BRIDGE_PROBE_TARGETS

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  restore('MTAPI_BASE_URL', oldBase)
  restore('MTAPI_MT4_BASE_URL', oldMt4)
  restore('MTAPI_MT5_BASE_URL', oldMt5)
  restore('BRIDGE_PROBE_TARGETS', oldOnly)
})

function envWith(values: Record<string, string | undefined>) {
  return { ...values }
}

// ---------------------------------------------------------------------------
// buildProbeTargets — URL candidates must match the paths nginx actually
// serves (deploy/mt4-bridge/05-nginx.sh asserts /health and /mt4/Ping).
// ---------------------------------------------------------------------------

test('buildProbeTargets: root nginx base probes the two asserted public paths', () => {
  const targets = buildProbeTargets(envWith({ MTAPI_BASE_URL: 'https://mtapi.tscopier.ai:9443' }))
  const mt5 = targets.find(t => t.target === 'bridge_mt5')
  const mt4 = targets.find(t => t.target === 'bridge_mt4')
  assert.ok(mt5 && mt4)
  assert.deepEqual(mt5.urls, [
    'https://mtapi.tscopier.ai:9443/health',
    'https://mtapi.tscopier.ai:9443/Ping',
  ])
  assert.deepEqual(mt4.urls, [
    'https://mtapi.tscopier.ai:9443/mt4/Ping',
    'https://mtapi.tscopier.ai:9443/Ping',
  ])
})

test('buildProbeTargets: MT4 base already ending in /mt4 gets only /Ping', () => {
  const targets = buildProbeTargets(envWith({
    MTAPI_BASE_URL: 'https://mtapi.tscopier.ai:9443',
    MTAPI_MT4_BASE_URL: 'https://mtapi.tscopier.ai:9443/mt4',
  }))
  const mt4 = targets.find(t => t.target === 'bridge_mt4')
  assert.ok(mt4)
  assert.deepEqual(mt4.urls, ['https://mtapi.tscopier.ai:9443/mt4/Ping'])
})

test('buildProbeTargets: separate MT4/MT5 bases are used per target', () => {
  const targets = buildProbeTargets(envWith({
    MTAPI_MT4_BASE_URL: 'http://10.66.0.1:9443/mt4',
    MTAPI_MT5_BASE_URL: 'http://10.66.0.1:9443',
  }))
  const mt5 = targets.find(t => t.target === 'bridge_mt5')
  const mt4 = targets.find(t => t.target === 'bridge_mt4')
  assert.equal(mt5?.urls[0], 'http://10.66.0.1:9443/health')
  assert.deepEqual(mt4?.urls, ['http://10.66.0.1:9443/mt4/Ping'])
})

test('buildProbeTargets: no configuration yields no targets', () => {
  assert.deepEqual(buildProbeTargets(envWith({})), [])
})

test('buildProbeTargets: trailing slashes are trimmed', () => {
  const targets = buildProbeTargets(envWith({ MTAPI_BASE_URL: 'https://bridge.example:9443///' }))
  assert.equal(targets.find(t => t.target === 'bridge_mt5')?.urls[0], 'https://bridge.example:9443/health')
})

test('buildProbeTargets: BRIDGE_PROBE_TARGETS restricts the set', () => {
  const targets = buildProbeTargets(envWith({
    MTAPI_BASE_URL: 'https://mtapi.tscopier.ai:9443',
    BRIDGE_PROBE_TARGETS: 'bridge_mt5',
  }))
  assert.deepEqual(targets.map(t => t.target), ['bridge_mt5'])
})

// ---------------------------------------------------------------------------
// probeTarget — first 200 wins; every candidate failing is DOWN (the
// nginx-up / backend-down 502 signature of the 2026-10-08 incident).
// ---------------------------------------------------------------------------

function fetchStub(responses: Record<string, number | 'throw'>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    const match = Object.entries(responses).find(([prefix]) => url.startsWith(prefix))
    const value = match?.[1]
    if (value === 'throw') throw new Error('ECONNREFUSED')
    if (value == null) throw new Error('unexpected url ' + url)
    return { status: value } as Response
  }) as unknown as typeof fetch
}

const MT5_TARGET: ProbeTarget = {
  target: 'bridge_mt5',
  urls: ['https://b/health', 'https://b/Ping'],
}

test('probeTarget: first candidate 200 marks up with latency', async () => {
  const outcome = await probeTarget(MT5_TARGET, fetchStub({ 'https://b/health': 200 }), 1000)
  assert.equal(outcome.state, 'up')
  assert.ok(outcome.latencyMs !== null && outcome.latencyMs >= 0)
  assert.match(outcome.detail, /200 https:\/\/b\/health/)
})

test('probeTarget: primary 502 but fallback 200 still marks up', async () => {
  const outcome = await probeTarget(MT5_TARGET, fetchStub({
    'https://b/health': 502,
    'https://b/Ping': 200,
  }), 1000)
  assert.equal(outcome.state, 'up')
})

test('probeTarget: all candidates non-200 marks down with statuses in detail', async () => {
  const outcome = await probeTarget(MT5_TARGET, fetchStub({
    'https://b/health': 502,
    'https://b/Ping': 502,
  }), 1000)
  assert.equal(outcome.state, 'down')
  assert.equal(outcome.latencyMs, null)
  assert.match(outcome.detail, /HTTP_502/)
})

test('probeTarget: transport error marks down with the error name', async () => {
  const outcome = await probeTarget(MT5_TARGET, fetchStub({
    'https://b/health': 'throw',
    'https://b/Ping': 'throw',
  }), 1000)
  assert.equal(outcome.state, 'down')
  assert.match(outcome.detail, /Error/)
})

// ---------------------------------------------------------------------------
// BridgeProbe.runOnce — persists every outcome and aggregates down if any
// target is down.
// ---------------------------------------------------------------------------

interface RpcCall {
  args: Record<string, unknown>
}

function stubSupabase(calls: RpcCall[]): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, 'record_probe_result')
      calls.push({ args })
      return { error: null }
    },
  } as unknown as SupabaseClient
}

test('runOnce: one target down persists both outcomes and reports aggregate down', async () => {
  const calls: RpcCall[] = []
  let aggregate: 'up' | 'down' | null = null
  const probe = new BridgeProbe({
    supabase: stubSupabase(calls),
    intervalMs: 30_000,
    timeoutMs: 1000,
    enabled: true,
    env: envWith({ MTAPI_BASE_URL: 'https://b' }),
    fetchImpl: fetchStub({ 'https://b/health': 200 }),
    onAggregate: state => { aggregate = state },
  })
  await probe.runOnce()
  assert.equal(calls.length, 2)
  assert.equal(aggregate, 'down') // bridge_mt4 candidates are not stubbed -> down
  const mt5Call = calls.find(c => c.args.p_target === 'bridge_mt5')
  const mt4Call = calls.find(c => c.args.p_target === 'bridge_mt4')
  assert.equal(mt5Call?.args.p_state, 'up')
  assert.equal(mt4Call?.args.p_state, 'down')
})

test('runOnce: all targets up reports aggregate up', async () => {
  const calls: RpcCall[] = []
  let aggregate: 'up' | 'down' | null = null
  const probe = new BridgeProbe({
    supabase: stubSupabase(calls),
    intervalMs: 30_000,
    timeoutMs: 1000,
    enabled: true,
    env: envWith({ MTAPI_BASE_URL: 'https://b' }),
    fetchImpl: fetchStub({ 'https://b/': 200 }),
    onAggregate: state => { aggregate = state },
  })
  await probe.runOnce()
  assert.equal(aggregate, 'up')
  assert.ok(calls.every(c => c.args.p_state === 'up'))
})

// ---------------------------------------------------------------------------
// BridgeHealthTracker — grace period then exactly one alert, reset on success.
// ---------------------------------------------------------------------------

test('BridgeHealthTracker: failure before grace does not alert', () => {
  const tracker = new BridgeHealthTracker({ graceMs: () => 120_000 })
  tracker.noteFailure()
  assert.ok(tracker.outageStartedAt() !== null)
  assert.equal(tracker.sustainedAlertSent(), false)
})

test('BridgeHealthTracker: sustained failure alerts once, success resets', () => {
  const tracker = new BridgeHealthTracker({ graceMs: () => 0 })
  tracker.noteFailure()
  assert.equal(tracker.sustainedAlertSent(), true)
  tracker.noteFailure()
  tracker.noteFailure()
  tracker.noteSuccess()
  assert.equal(tracker.sustainedAlertSent(), false)
  assert.equal(tracker.outageStartedAt(), null)
})
