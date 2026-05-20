#!/usr/bin/env node
/**
 * Synthetic burst load against trade entry POST /internal/dispatch-signal.
 * Measures HTTP dispatch latency only (no MT OrderSend unless real signal data is used).
 */

const baseUrl = String(process.env.TRADE_WORKER_URL ?? '').replace(/\/$/, '')
const token = String(process.env.WORKER_INTERNAL_TOKEN ?? '').trim()
const userIds = String(process.env.LOAD_USER_IDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
const total = Math.max(1, Number(process.env.LOAD_SIGNAL_COUNT ?? 100))
const concurrency = Math.max(1, Number(process.env.LOAD_CONCURRENCY ?? 20))

if (!baseUrl || !token) {
  console.error('Set TRADE_WORKER_URL and WORKER_INTERNAL_TOKEN')
  process.exit(1)
}
if (userIds.length === 0) {
  console.error('Set LOAD_USER_IDS (comma-separated UUIDs)')
  process.exit(1)
}

const url = `${baseUrl}/internal/dispatch-signal`

function fakeSignal(userId, i) {
  const id = `load-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    user_id: userId,
    channel_id: null,
    parsed_data: { action: 'buy', symbol: 'XAUUSD', lots: 0.01 },
    status: 'parsed',
    created_at: new Date().toISOString(),
  }
}

async function postOne(userId, i) {
  const t0 = performance.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': token,
    },
    body: JSON.stringify({
      signal: fakeSignal(userId, i),
      priority: 'high',
      source: 'load_test',
    }),
  })
  const ms = performance.now() - t0
  const text = await res.text().catch(() => '')
  return { ok: res.ok, status: res.status, ms, detail: text.slice(0, 120) }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[idx]
}

async function main() {
  console.log(`burst-dispatch: ${total} requests, concurrency=${concurrency}, users=${userIds.length}`)
  const latencies = []
  let ok = 0
  let failed = 0
  let cursor = 0

  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= total) break
      const userId = userIds[i % userIds.length]
      try {
        const r = await postOne(userId, i)
        latencies.push(r.ms)
        if (r.ok) ok++
        else {
          failed++
          if (failed <= 5) console.warn(`fail status=${r.status} ${r.detail}`)
        }
      } catch (err) {
        failed++
        if (failed <= 5) console.warn('fail', err instanceof Error ? err.message : err)
      }
    }
  }

  const tStart = performance.now()
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const elapsed = performance.now() - tStart

  latencies.sort((a, b) => a - b)
  console.log(JSON.stringify({
    total,
    ok,
    failed,
    elapsed_ms: Math.round(elapsed),
    rps: Math.round((total / elapsed) * 1000),
    p50_ms: Math.round(percentile(latencies, 50)),
    p99_ms: Math.round(percentile(latencies, 99)),
    max_ms: Math.round(latencies[latencies.length - 1] ?? 0),
  }, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
