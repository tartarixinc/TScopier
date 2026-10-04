/**
 * Health of the LIVE broker feed — the read that talks to the broker through
 * the edge (`fxsocketBroker.trades` and friends). Pages report every real
 * attempt: a success clears the flag, a failure raises it.
 *
 * The degraded banner subscribes to this store, so the notice appears when a
 * live read fails and **disappears on its own** as soon as one succeeds —
 * no reload, no manual dismissal. Cache hits are not attempts: serving a
 * fresh session cache proves nothing about the feed and reports nothing.
 *
 * Failures raised WHILE a read is in flight (the edge layer reports a
 * partial provider failure from inside `fetchTradesAcrossProviders`) must
 * not be cleared by that same read's success. Callers therefore capture
 * `getLiveFeedGeneration()` before a read and pass it to
 * `reportLiveFeedSuccess(generation)`; the success only clears the banner
 * when no newer failure was reported during the read.
 *
 * Module-level on purpose: one feed, many pages (Trades, Dashboard), so the
 * banner is consistent wherever it is rendered.
 */

export type LiveFeedStatus = {
  degraded: boolean
  /** Epoch ms of the FIRST consecutive failure — null while healthy. */
  since: number | null
  /** Last failure message, for debugging only; never rendered to users. */
  reason: string | null
}

const HEALTHY: LiveFeedStatus = { degraded: false, since: null, reason: null }

let status: LiveFeedStatus = HEALTHY
/** Monotonic counter of failure reports — never reset. */
let generation = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getLiveFeedStatus(): LiveFeedStatus {
  return status
}

/** Capture before starting a live read; pass to `reportLiveFeedSuccess`. */
export function getLiveFeedGeneration(): number {
  return generation
}

export function subscribeLiveFeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A live read succeeded: the feed is healthy again, drop the banner.
 * Pass the generation captured before the read started — if a failure was
 * reported while it was in flight (partial provider fetch), the banner stays.
 */
export function reportLiveFeedSuccess(expectedGeneration?: number): void {
  if (expectedGeneration != null && expectedGeneration !== generation) return
  if (!status.degraded) return
  status = HEALTHY
  emit()
}

/** A live read failed: raise (or keep) the banner, preserving `since`. */
export function reportLiveFeedFailure(reason: string): void {
  // Always bump — callers use the generation to detect failures raised
  // during their own read, even when the visible status does not change.
  generation += 1
  if (status.degraded && status.reason === reason) return
  status = {
    degraded: true,
    since: status.since ?? Date.now(),
    reason,
  }
  emit()
}

/**
 * True for errors about OUR session rather than the broker feed (our auth
 * guard, or the auth failures the API layers return). Recovery must still
 * run for them, but they must not raise a banner that blames broker
 * infrastructure. Anchored alternatives so broker/edge error text can never
 * match by coincidence.
 */
export function isAuthSessionError(reason: string): boolean {
  return /^(?:Not signed in|JWT expired|Unauthorized)$/.test(reason)
}

/** Test-only: back to the healthy initial state. */
export function resetLiveFeedStatus(): void {
  if (!status.degraded && status.reason === null) return
  status = HEALTHY
  emit()
}
