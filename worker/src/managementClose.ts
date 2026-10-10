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
const EMPTY_READBACK_BACKOFF_MS = 250

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
  let effectiveTicket = ticket
  let before: unknown[] = []
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
  } catch {
    return { confirmed: false, reason: 'close pre-readback failed', attempts: 0, ticket, reconciliationRequired: true }
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
    for (let r = 0; r < EMPTY_READBACK_ATTEMPTS; r++) {
      try {
        after = await api.openedOrders(uuid)
        lastReadFailed = false
      } catch {
        lastReadFailed = true
        after = []
      }
      if (after.length > 0) break
      if (r < EMPTY_READBACK_ATTEMPTS - 1) {
        await new Promise(resolve => setTimeout(resolve, EMPTY_READBACK_BACKOFF_MS))
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
      // A persistently empty readback. If the account held exactly one position —
      // the one we just resolved and closed — empty is the expected result of a
      // successful close, so confirm it instead of bouncing to reconciliation.
      if (before.length === 1) {
        return { confirmed: true, attempts: attempt, ticket: effectiveTicket }
      }
      return {
        confirmed: false,
        reason: 'close broker readback was empty; reconciliation required',
        attempts: attempt,
        ticket: effectiveTicket,
        reconciliationRequired: true,
      }
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
