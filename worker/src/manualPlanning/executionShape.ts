import type { MtOperation, OrderSendArgs } from '../fxsocketClient'
import type { PlannerStrictEntry } from './types'
import { clampPendingExpiryHours } from './manualSettings'

export function flipOperation(op: MtOperation): MtOperation {
  switch (op) {
    case 'Buy': return 'Sell'
    case 'Sell': return 'Buy'
    case 'BuyLimit': return 'SellLimit'
    case 'SellLimit': return 'BuyLimit'
    case 'BuyStop': return 'SellStop'
    case 'SellStop': return 'BuyStop'
    case 'BuyStopLimit': return 'SellStopLimit'
    case 'SellStopLimit': return 'BuyStopLimit'
    default: return op
  }
}

/**
 * True when the live quote is already at or better than the signal entry for immediate
 * execution (buy: ask ≤ entry; sell: bid ≥ entry). Used by the executor after a post-delay /Quote.
 */
export function strictSignalEntryQuoteAllowsImmediate(args: {
  isBuy: boolean
  entryPrice: number
  bid: number
  ask: number
  tolerancePips?: number
  pipSize?: number
}): boolean {
  const { isBuy, entryPrice, bid, ask } = args
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(bid) || !Number.isFinite(ask)) {
    return false
  }
  const tolPips = Math.max(0, Number(args.tolerancePips ?? 0))
  const pip = Number(args.pipSize ?? 0)
  const tolPx = tolPips > 0 && pip > 0 ? tolPips * pip : 0
  return isBuy
    ? ask <= entryPrice + tolPx
    : bid >= entryPrice - tolPx
}

export interface ResolveOpExecAndStrictArgs {
  opSplit: MtOperation
  isBuy: boolean
  entryAnchor: number | null
  /** `signalEntryPriceStrictEnabled(manual)` */
  manualStrict: boolean
  /** `parsedHasExplicitEntryAnchor(parsed)` */
  hasExplicitEntry: boolean
  roundPrice: (v: number | null | undefined) => number
  resolvedSymbol: string
  commentPrefix: string
  expertId?: number
  slippage?: number
  now: Date
  pendingExpiryRaw: unknown
}

export interface ResolveOpExecAndStrictResult {
  opExec: MtOperation
  orderPrice: number
  roundedEntry: number
  expirationFields: { expiration?: string; expirationType?: OrderSendArgs['expirationType'] }
  strictEntry: PlannerStrictEntry | undefined
  orderBase: Omit<OrderSendArgs, 'volume' | 'stoploss' | 'takeprofit' | 'expiration' | 'expirationType'>
}

/**
 * Owns the decision table for `opSplit` → `opExec`, `orderPrice`, `strictEntry`, and pending `expiration`.
 */
export function resolveOpExecAndStrict(args: ResolveOpExecAndStrictArgs): ResolveOpExecAndStrictResult {
  const {
    opSplit,
    isBuy,
    entryAnchor,
    manualStrict,
    hasExplicitEntry,
    roundPrice,
    resolvedSymbol,
    commentPrefix,
    expertId,
    slippage,
    now,
    pendingExpiryRaw,
  } = args

  let opExec: MtOperation = opSplit
  if (manualStrict && hasExplicitEntry && entryAnchor != null) {
    opExec = isBuy ? 'Buy' : 'Sell'
  } else if (
    !manualStrict
    && (opSplit.includes('Limit') || opSplit.includes('Stop'))
  ) {
    // Single- and multi-trade immediates: never send broker pendings here — MT often
    // rejects "Invalid price" when the parsed limit/stop price is on the wrong side
    // of the live quote. `planMultiManualOrders` keys range split off this op too.
    opExec = isBuy ? 'Buy' : 'Sell'
  }

  const isMarketExec = opExec === 'Buy' || opExec === 'Sell'
  const roundedEntry =
    entryAnchor != null && Number.isFinite(entryAnchor) && entryAnchor > 0
      ? roundPrice(entryAnchor)
      : 0
  // Market immediates use price=0 (live fill). Signal entry is carried in strictEntry
  // for defer / broker-pending placement — not as a market order price.
  const orderPrice = isMarketExec ? 0 : roundedEntry

  const orderBase = {
    symbol: resolvedSymbol,
    operation: opExec,
    price: orderPrice,
    slippage: slippage ?? 20,
    comment: commentPrefix,
    expertID: expertId,
  } satisfies Omit<OrderSendArgs, 'volume' | 'stoploss' | 'takeprofit' | 'expiration' | 'expirationType'>

  const expirationFields: { expiration?: string; expirationType?: OrderSendArgs['expirationType'] } = {}
  if (opExec.includes('Limit') || opExec.includes('Stop')) {
    const hours = clampPendingExpiryHours(pendingExpiryRaw)
    if (hours > 0) {
      const exp = new Date(now.getTime() + hours * 60 * 60 * 1000)
      expirationFields.expiration = exp.toISOString()
      expirationFields.expirationType = 'Specified'
    }
  }

  const strictEntry: PlannerStrictEntry | undefined =
    manualStrict && hasExplicitEntry && roundedEntry > 0
      ? { entryPrice: roundedEntry, isBuy }
      : undefined

  return { opExec, orderPrice, roundedEntry, expirationFields, strictEntry, orderBase }
}
