import type { FxsocketBrokerClient } from './fxsocketClient'
import { findOpenedRowByTicket } from './signalEntryPendingHelpers'

export interface CloseVerificationResult {
  confirmed: boolean
  reason?: string
  attempts: number
}

function mgmtCloseVerifySleepMs(liveFast: boolean): number {
  if (liveFast) {
    const raw = Number(process.env.MGMT_CLOSE_VERIFY_MS ?? 0)
    return Number.isFinite(raw) && raw >= 0 ? raw : 0
  }
  return 400
}

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
  return { confirmed: true, attempts: 1 }
}

export async function closeWithVerification(
  api: FxsocketBrokerClient,
  uuid: string,
  ticket: number,
  opts: { maxAttempts?: number; slippageEscalation?: number; liveFast?: boolean } = {},
): Promise<CloseVerificationResult> {
  const liveFast = opts.liveFast === true
  const verifySleepMs = mgmtCloseVerifySleepMs(liveFast)
  if (liveFast && verifySleepMs === 0) {
    const maxAttempts = opts.maxAttempts ?? 2
    const slippageStep = opts.slippageEscalation ?? 50
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const slippage = 20 + (attempt - 1) * slippageStep
      const result = await closeOrderFast(api, uuid, ticket, slippage)
      if (result.confirmed) return { ...result, attempts: attempt }
      if (attempt >= maxAttempts) return result
    }
    return { confirmed: false, reason: 'exhausted attempts', attempts: maxAttempts }
  }

  const maxAttempts = opts.maxAttempts ?? 2
  const slippageStep = opts.slippageEscalation ?? 50

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const slippage = 20 + (attempt - 1) * slippageStep
    const result = await api.orderClose(uuid, { ticket, slippage })

    if (result.state && /^(rejected|cancelled|expired)/i.test(result.state)) {
      if (attempt >= maxAttempts) {
        return { confirmed: false, reason: `orderClose state=${result.state}`, attempts: attempt }
      }
      await new Promise(r => setTimeout(r, 300))
      continue
    }

    if (verifySleepMs > 0) {
      await new Promise(r => setTimeout(r, verifySleepMs))
    }

    let stillOpen = false
    try {
      const openOrders = await api.openedOrders(uuid)
      stillOpen = findOpenedRowByTicket(openOrders ?? [], ticket) != null
    } catch {
      return { confirmed: true, attempts: attempt }
    }

    if (!stillOpen) {
      return { confirmed: true, attempts: attempt }
    }

    if (attempt >= maxAttempts) {
      return { confirmed: false, reason: 'ticket still open after orderClose + verification', attempts: attempt }
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return { confirmed: false, reason: 'exhausted attempts', attempts: maxAttempts }
}
