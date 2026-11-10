import type { FxsocketBrokerClient } from './fxsocketClient'
import { resolveCanonicalOpenPosition } from './livePositionIdentity'

export interface CloseVerificationResult {
  confirmed: boolean
  reason?: string
  attempts: number
  ticket?: number
  reconciliationRequired?: boolean
}

function mgmtCloseVerifySleepMs(liveFast: boolean): number {
  if (liveFast) {
    const raw = Number(process.env.MGMT_CLOSE_VERIFY_MS ?? 0)
    return Number.isFinite(raw) && raw >= 0 ? raw : 0
  }
  return 400
}

/** Post-close readback retries when the broker returns an empty list (bridge lag). */
const EMPTY_READBACK_ATTEMPTS = 3
/** Extra attempts when other positions were open pre-close — MTAPI often returns [] mid multi-leg burst. */
const EMPTY_READBACK_MULTI_EXTRA_ATTEMPTS = 3
const EMPTY_READBACK_BACKOFF_MS = 250
const EMPTY_READBACK_MULTI_BACKOFF_MS = 400

/** Single orderClose — no post-close openedOrders poll (live fast tier). */
export async function closeOrderFast(
  api: FxsocketBrokerClient,
  uuid: string,
  ticket: number,
  slippage = 20,
): Promise<CloseVerificationResult> {
  const result = await api.orderClose(uuid, { ticket, slippage })
  if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
    return { confirmed: false, reason: `orderClose state=${result.state}`, attempts: 1 }
  }
  return {
    confirmed: false,
    reason: 'orderClose accepted but broker readback was skipped',
    attempts: 1,
    ticket,
    reconciliationRequired: true,
  }
}

export async function closeWithVerification(
  api: FxsocketBrokerClient,
  uuid: string,
  ticket: number,
  opts: { maxAttempts?: number; slippageEscalation?: number; liveFast?: boolean } = {},
): Promise<CloseVerificationResult> {
  const liveFast = opts.liveFast === true
  const verifySleepMs = mgmtCloseVerifySleepMs(liveFast)

  const maxAttempts = opts.maxAttempts ?? 2
  const slippageStep = opts.slippageEscalation ?? 50

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  let effectiveTicket: number
  let before: unknown[]
  try {
    before = await api.openedOrders(uuid)
    const resolved = resolveCanonicalOpenPosition({
      trade: { id: 'close-verification', metaapi_order_id: String(ticket) },
      openedOrders: before,
    })
    if (resolved.status !== 'resolved') {
      return {
        confirmed: false,
        reason: `close reconciliation required: ${resolved.reason}`,
        attempts: 0,
        ticket,
        reconciliationRequired: true,
      }
    }
    effectiveTicket = resolved.ticket
  } catch (error) {
    const cause = error instanceof Error ? error.message.trim().slice(0, 160) : ''
    return { confirmed: false, reason: cause ? `close pre-readback failed: ${cause}` : 'close pre-readback failed', attempts: 0, ticket, reconciliationRequired: true }
  }

    const slippage = 20 + (attempt - 1) * slippageStep
    const result = await api.orderClose(uuid, { ticket: effectiveTicket, slippage })

    if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
      if (attempt >= maxAttempts) {
        return { confirmed: false, reason: `orderClose state=${result.state}`, attempts: attempt, ticket: effectiveTicket }
      }
      await new Promise(r => setTimeout(r, 300))
      continue
    }

    if (verifySleepMs > 0) {
      await new Promise(r => setTimeout(r, verifySleepMs))
    }

    // Read back the open positions. An empty list is ambiguous — it can mean the
    // close succeeded, or that the read failed / lagged (common on the MT4
    // bridge). Retry briefly, then decide using the pre-close snapshot.
    let after: unknown[] = []
    let lastReadFailed = false
    const emptyAttempts = before.length > 1
      ? EMPTY_READBACK_ATTEMPTS + EMPTY_READBACK_MULTI_EXTRA_ATTEMPTS
      : EMPTY_READBACK_ATTEMPTS
    const emptyBackoffMs = before.length > 1 ? EMPTY_READBACK_MULTI_BACKOFF_MS : EMPTY_READBACK_BACKOFF_MS
    for (let r = 0; r < emptyAttempts; r++) {
      try {
        after = await api.openedOrders(uuid)
        lastReadFailed = false
      } catch {
        lastReadFailed = true
        after = []
      }
      if (after.length > 0) break
      if (r < emptyAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, emptyBackoffMs))
      }
    }
    if (lastReadFailed && after.length === 0) {
      return {
        confirmed: false,
        reason: 'close broker readback failed',
        attempts: attempt,
        ticket: effectiveTicket,
        reconciliationRequired: true,
      }
    }
    if (after.length === 0) {
      // cTrader reconcile is authoritative: closing the only position leaves an
      // empty book. An empty FxSocket snapshot is still not proof of closure.
      if (result.state === 'position_closed') {
        return { confirmed: true, attempts: attempt, ticket: effectiveTicket }
      }
      // A persistently empty readback after a non-rejected orderClose. We already
      // resolved this ticket in `before`, so an empty book means it is not open.
      // Multi-leg closes often see flaky [] snapshots while siblings remain on
      // the broker — treating that as failure left user-visible "Could not close"
      // errors even when the ticket was gone. Confirm this ticket; remaining
      // legs keep their own close/reconcile path.
      return { confirmed: true, attempts: attempt, ticket: effectiveTicket }
    }

    const afterResolution = resolveCanonicalOpenPosition({
      trade: { id: 'close-verification', metaapi_order_id: String(effectiveTicket) },
      openedOrders: after,
    })
    if (afterResolution.status === 'missing') {
      return { confirmed: true, attempts: attempt, ticket: effectiveTicket }
    }
    if (afterResolution.status === 'ambiguous') {
      return {
        confirmed: false,
        reason: `close reconciliation required: ${afterResolution.reason}`,
        attempts: attempt,
        ticket: effectiveTicket,
        reconciliationRequired: true,
      }
    }

    if (attempt >= maxAttempts) {
      return { confirmed: false, reason: 'ticket still open after orderClose + verification', attempts: attempt, ticket: effectiveTicket }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return { confirmed: false, reason: 'exhausted attempts', attempts: maxAttempts }
}
