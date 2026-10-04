/**
 * Suppresses GramJS internal noise that carries no per-line operational value:
 *
 *  - flood-wait INFO lines ("Sleeping for Xs on flood wait") — 83% of log volume
 *    in production before this existed;
 *  - `Error: TIMEOUT` stacks thrown by GramJS's own `_updateLoop` ping loop
 *    every ~9–30 s per dead connection (incident 2026-09-29: ~935 stack lines
 *    per 10 minutes, which pushed Railway past its 500 lines/second limit and
 *    dropped real incident logs).
 *
 * Each kind is counted per 60s window and emitted as a single consolidated
 * line, so the rate stays visible without the noise. Our own logs (reconnects,
 * probes, recovery) are never touched.
 *
 * Must be imported before `initWorkerSentry()` (which wraps console.error) and
 * before any TelegramClient is constructed, so the patches are in place before
 * GramJS first logs.
 */

const FLOOD_WAIT_RE = /Sleeping for (\d+)s on flood wait/

/**
 * True for the error object GramJS logs from `client/updates.js` when its ping
 * race times out. Matched on the message and the originating stack so an
 * identical message from our own code is still printed.
 */
export function isGramjsUpdateLoopTimeout(value: unknown): boolean {
  if (!(value instanceof Error) || value.message !== 'TIMEOUT') return false
  return /telegram[\\/]client[\\/]updates\.js/.test(value.stack ?? '')
}

const originalLog = console.log
const originalError = console.error

let windowStart = Date.now()
let count = 0
let totalSec = 0
let minSec = Infinity
let maxSec = 0
let timeoutCount = 0

console.log = (...args: unknown[]) => {
  const msg = typeof args[0] === 'string' ? args[0] : String(args[0] ?? '')

  if (FLOOD_WAIT_RE.test(msg)) {
    const m = msg.match(FLOOD_WAIT_RE)
    if (m) {
      const sec = parseInt(m[1], 10)
      count++
      totalSec += sec
      if (sec < minSec) minSec = sec
      if (sec > maxSec) maxSec = sec
    }
    return
  }

  originalLog.apply(console, args)
}

console.error = (...args: unknown[]) => {
  if (isGramjsUpdateLoopTimeout(args[0])) {
    timeoutCount++
    return
  }
  originalError.apply(console, args)
}

setInterval(() => {
  const now = Date.now()
  const elapsedSec = ((now - windowStart) / 1000).toFixed(0)
  // Deliberately the live `console.log`, not the captured original: Sentry's
  // logging integration wraps console.log after this module loads, so the
  // aggregate (one line per minute) is still reported while the individual
  // stacks are not. The aggregate lines never match the flood-wait filter
  // above, so they cannot be swallowed recursively.
  if (count > 0) {
    const avg = Math.round(totalSec / count)
    console.log(
      `[telegram] aggregated_flood_wait count=${count} window=${elapsedSec}s`
      + ` avg=${avg}s min=${minSec}s max=${maxSec}s`,
    )
  }
  if (timeoutCount > 0) {
    console.log(
      `[telegram] aggregated_update_loop_timeout count=${timeoutCount} window=${elapsedSec}s`,
    )
  }
  windowStart = now
  count = 0
  totalSec = 0
  minSec = Infinity
  maxSec = 0
  timeoutCount = 0
}, 60_000).unref()
