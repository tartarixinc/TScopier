import type { MtOperation } from '../metatraderapi'
import type { ChannelKeywords, ManualSettings, ParsedSignal, PlannerContext, PlannerResult } from './types'
import { deriveManualStopsWithClamp, reverseSignalGateSatisfied } from './manualStops'
import { flipOperation, resolveOpExecAndStrict } from './executionShape'
import { signalEntryPriceStrictEnabled } from './manualSettings'
import {
  parsedHasExplicitEntryAnchor,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
} from './parsedEntry'
import { planMultiManualOrders } from './planMultiManualOrders'
import { planSingleManualOrders } from './planSingleManualOrders'

function withinTimeWindow(start: string, end: string, now: Date): boolean {
  const toMinutes = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
    return h * 60 + mm
  }
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s == null || e == null) return true
  const cur = now.getHours() * 60 + now.getMinutes()
  if (s <= e) return cur >= s && cur <= e
  return cur >= s || cur <= e
}

/** Build the order plan. Returns an empty plan with skip_reason when filtered out. */
export function planManualOrders(args: {
  parsed: ParsedSignal
  resolvedSymbol: string
  baseOperation: MtOperation
  manual: ManualSettings
  channelKeywords: ChannelKeywords | null
  manualLot: number
  ctx: PlannerContext
  commentPrefix: string
  expertId?: number
  slippage?: number
}): PlannerResult {
  const {
    parsed,
    resolvedSymbol,
    baseOperation,
    manual,
    channelKeywords,
    manualLot,
    ctx,
    commentPrefix,
    expertId,
    slippage,
  } = args

  const now = ctx.now ?? new Date()
  const delay_ms = Math.max(0, Number(channelKeywords?.additional?.delay_msec ?? 0) | 0)

  if (manual.days_filter_enabled) {
    const allowed = (manual.trade_days ?? [0, 1, 2, 3, 4, 5, 6]).map(Number)
    if (!allowed.includes(now.getDay())) {
      return { orders: [], skip_reason: 'filtered_day', delay_ms }
    }
  }
  if (manual.time_filter_enabled && manual.trade_start_time && manual.trade_end_time) {
    if (!withinTimeWindow(manual.trade_start_time, manual.trade_end_time, now)) {
      return { orders: [], skip_reason: 'filtered_time', delay_ms }
    }
  }
  if (signalEntryPriceStrictEnabled(manual) && !parsedHasExplicitEntryAnchor(parsed)) {
    return { orders: [], skip_reason: SKIP_REASON_SIGNAL_ENTRY_REQUIRED, delay_ms }
  }

  let entry: number | null = resolvedParsedEntryPrice(parsed)
  if (entry == null) {
    const z = resolvedParsedEntryZone(parsed)
    if (z) {
      const prefer = channelKeywords?.additional?.prefer_entry ?? 'first_price'
      entry = prefer === 'last_price' ? z.hi : z.lo
    }
  }
  const entryOk = entry != null && Number.isFinite(entry) && entry > 0
  const entryAnchorFromSignal = entryOk ? entry : null

  const effectiveReverse = manual.reverse_signal === true && reverseSignalGateSatisfied(manual, entryAnchorFromSignal)
  const opSplit: MtOperation = effectiveReverse ? flipOperation(baseOperation) : baseOperation
  const isBuy = opSplit.startsWith('Buy')

  let entryAnchor: number | null = entryAnchorFromSignal
  if (
    entryAnchor == null
    && (manual.use_predefined_sl_pips === true || manual.use_predefined_tp_pips === true)
  ) {
    const ask = ctx.liveAsk
    const bid = ctx.liveBid
    if (isBuy && typeof ask === 'number' && Number.isFinite(ask) && ask > 0) entryAnchor = ask
    else if (!isBuy && typeof bid === 'number' && Number.isFinite(bid) && bid > 0) entryAnchor = bid
  }

  const { pipQuote, pip, finalSl, finalTps, minStopDist, roundPrice } = deriveManualStopsWithClamp({
    parsed,
    manual,
    channelKeywords,
    resolvedSymbol,
    ctx,
    entryAnchor,
    isBuy,
  })

  const manualStrict = signalEntryPriceStrictEnabled(manual)
  const hasExplicitEntry = parsedHasExplicitEntryAnchor(parsed)

  const { orderBase, expirationFields, strictEntry } = resolveOpExecAndStrict({
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
    pendingExpiryRaw: manual.pending_expiry_hours,
  })

  const tradeStyle = manual.trade_style === 'multi' ? 'multi' : 'single'

  const singleShared = {
    orderBase,
    expirationFields,
    strictEntry,
    manualLot,
    finalSl,
    finalTps,
    manual,
    ctx,
    delay_ms,
    entryAnchor,
    isBuy,
    pip,
    pipQuote,
    roundPrice,
  }

  if (tradeStyle !== 'multi') {
    return planSingleManualOrders(singleShared)
  }

  return planMultiManualOrders({
    ...singleShared,
    commentPrefix,
    expertId,
    slippage,
    minStopDist,
    buildSingleOrder: planSingleManualOrders,
  })
}
