/**
 * Apply SL/TP (or breakeven) from the latest channel management signal to a newly
 * opened basket leg. Keep in sync with worker/src/basketModFollowUp.ts.
 */

type OrderModifyApi = {
  orderModify(metaUuid: string, payload: Record<string, unknown>): Promise<unknown>
}
import {
  breakevenStopLossForSymbol,
  manualSettingsForChannel,
} from "./autoManagement.ts"
import {
  takeProfitForLegIndex,
  type ManualTpLotLike,
} from "./tpBucketDistribution.ts"

type ParsedMgmt = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
}

type ChannelActiveTradeParams = {
  symbol: string
  stoploss: number | null
  tpLevels: number[]
}

function sanitizeLevel(v: number | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function positiveLevel(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : null
}

function positiveTps(parsed: ParsedMgmt | null | undefined): number[] {
  return (parsed?.tp ?? []).filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0,
  )
}

export function symbolsCompatibleForBasket(signalSym: string | null | undefined, brokerSym: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const a = norm(String(signalSym ?? ""))
  const b = norm(String(brokerSym ?? ""))
  if (!a.length || !b.length) return false
  return a === b || b.includes(a) || a.includes(b)
}

export function mgmtSignalMatchesBasketSymbol(
  parsed: { action?: string; symbol?: string | null },
  brokerSymbol: string,
): boolean {
  const act = String(parsed.action ?? "").toLowerCase()
  if (act === "modify" || act === "breakeven") {
    const sym = parsed.symbol
    if (sym == null || String(sym).trim() === "") return true
    return symbolsCompatibleForBasket(sym, brokerSymbol)
  }
  return symbolsCompatibleForBasket(parsed.symbol, brokerSymbol)
}

function estimateBasketTotalPlannedLegs(args: {
  openLegCount: number
  activePendingCount: number
  maxPendingStepIdx: number
}): number {
  const { openLegCount, activePendingCount, maxPendingStepIdx } = args
  if (maxPendingStepIdx <= 0) return Math.max(0, openLegCount)
  const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount)
  const immediateLegCount = Math.max(0, openLegCount - firedPendingApprox)
  return immediateLegCount + maxPendingStepIdx
}

async function loadChannelActiveTradeParamsForSymbol(
  supabase: SupabaseLike,
  userId: string,
  channelId: string,
  symbolHint: string,
): Promise<ChannelActiveTradeParams | null> {
  const { data, error } = await supabase
    .from("channel_active_trade_params")
    .select("symbol,stoploss,tp_levels")
    .eq("user_id", userId)
    .eq("channel_id", channelId)
    .limit(200)
  if (error) return null
  const rows = (data ?? []) as { symbol: string; stoploss: number | null; tp_levels: number[] }[]
  const match = rows.find((r) => symbolsCompatibleForBasket(symbolHint, r.symbol))
  if (!match) return null
  return {
    symbol: match.symbol,
    stoploss: positiveLevel(match.stoploss),
    tpLevels: Array.isArray(match.tp_levels)
      ? match.tp_levels.filter((t): t is number => positiveLevel(t) != null) as number[]
      : [],
  }
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = any

type FollowUpLegContext = {
  legIndex: number
  openCount: number
  immediateLegCount: number
  rangeLegCount: number
  tpLots: ManualTpLotLike[] | null | undefined
  anchorParsed: ParsedMgmt | null | undefined
  existingSl: number | null
  existingTp: number | null
  entryPrice: number | null
  symbol: string
  isBuy: boolean
  manual: { breakeven_offset_pips?: number }
}

function computeFollowUpStops(
  ctx: FollowUpLegContext,
  source: {
    sl?: number | null
    tpLevels?: number[] | null
    action?: string
  },
): { stoploss: number; takeprofit: number; dbPatch: Record<string, number | null> } | null {
  const act = String(source.action ?? "modify").toLowerCase()
  if (act === "breakeven") {
    const entry = sanitizeLevel(ctx.entryPrice)
    if (entry <= 0) return null
    const beSl = breakevenStopLossForSymbol({
      isBuy: ctx.isBuy,
      entryPrice: entry,
      manual: ctx.manual,
      symbol: ctx.symbol,
    })
    return {
      stoploss: beSl,
      takeprofit: sanitizeLevel(ctx.existingTp),
      dbPatch: { sl: beSl },
    }
  }

  const hasNewSl = typeof source.sl === "number" && Number.isFinite(source.sl) && source.sl > 0
  const signalTps = positiveTps({ tp: source.tpLevels ?? null })
  const anchorTps = positiveTps(ctx.anchorParsed)
  const finalTps = signalTps.length ? signalTps : anchorTps
  const hasNewTp = finalTps.length > 0
  if (!hasNewSl && !hasNewTp) return null

  const stoploss = hasNewSl ? (source.sl as number) : sanitizeLevel(ctx.existingSl)
  let takeprofit = sanitizeLevel(ctx.existingTp)
  const dbPatch: Record<string, number | null> = {}
  if (hasNewSl) dbPatch.sl = source.sl as number

  if (hasNewTp) {
    const idx = ctx.legIndex >= 0 ? ctx.legIndex : ctx.openCount - 1
    takeprofit = takeProfitForLegIndex({
      legIndex: idx,
      openLegCount: ctx.openCount,
      finalTps,
      tpLots: ctx.tpLots,
    })
    if (takeprofit <= 0) takeprofit = finalTps[finalTps.length - 1]!
    if (takeprofit > 0) dbPatch.tp = takeprofit
  }

  return { stoploss, takeprofit, dbPatch }
}

async function executeFollowUpModify(
  supabase: SupabaseLike,
  api: OrderModifyApi,
  args: {
    userId: string
    brokerAccountId: string
    metaUuid: string
    ticket: number
    tradeRowId: string
    basketSignalId: string
    sourceSignalId: string
    legIndex: number
    stoploss: number
    takeprofit: number
    dbPatch: Record<string, number | null>
  },
): Promise<boolean> {
  try {
    await api.orderModify(args.metaUuid, {
      ticket: args.ticket,
      stoploss: args.stoploss,
      takeprofit: args.takeprofit,
    })
    if (Object.keys(args.dbPatch).length > 0) {
      await supabase.from("trades").update(args.dbPatch).eq("id", args.tradeRowId)
    }
    await supabase.from("trade_execution_logs").insert({
      user_id: args.userId,
      signal_id: args.sourceSignalId,
      broker_account_id: args.brokerAccountId,
      action: "mgmt_range_leg_followup",
      status: "success",
      request_payload: {
        ticket: args.ticket,
        trade_id: args.tradeRowId,
        leg_index: args.legIndex >= 0 ? args.legIndex + 1 : null,
        stoploss: args.stoploss,
        takeprofit: args.takeprofit,
        basket_signal_id: args.basketSignalId,
      },
    })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabase.from("trade_execution_logs").insert({
      user_id: args.userId,
      signal_id: args.sourceSignalId,
      broker_account_id: args.brokerAccountId,
      action: "mgmt_range_leg_followup",
      status: "failed",
      error_message: msg,
      request_payload: {
        ticket: args.ticket,
        trade_id: args.tradeRowId,
        basket_signal_id: args.basketSignalId,
      },
    })
    return false
  }
}

export async function tryApplyBasketFollowUpToNewFill(
  supabase: SupabaseLike,
  api: OrderModifyApi,
  args: {
    userId: string
    basketSignalId: string
    brokerAccountId: string
    metaUuid: string
    symbol: string
    ticket: number
    tradeRowId: string
    entryPrice: number | null
    existingSl: number | null
    existingTp: number | null
    tpLots?: ManualTpLotLike[] | null
    isBuy?: boolean | null
  },
): Promise<void> {
  const { data: basket } = await supabase
    .from("signals")
    .select("channel_id, created_at, parsed_data")
    .eq("id", args.basketSignalId)
    .maybeSingle()

  const channelId = basket?.channel_id as string | null | undefined
  const createdAt = basket?.created_at as string | null | undefined
  const anchorParsed = basket?.parsed_data as ParsedMgmt | null | undefined
  if (!channelId || !createdAt) return

  let tpLots = args.tpLots
  const { data: br } = await supabase
    .from("broker_accounts")
    .select("manual_settings, channel_trading_configs")
    .eq("id", args.brokerAccountId)
    .maybeSingle()
  const channelManual = manualSettingsForChannel(
    (br ?? {}) as { manual_settings?: unknown; channel_trading_configs?: unknown },
    channelId,
  )
  if (tpLots === undefined) {
    tpLots = (channelManual.tp_lots ?? null) as ManualTpLotLike[] | null | undefined
  }

  const { data: openLegs } = await supabase
    .from("trades")
    .select("id")
    .eq("broker_account_id", args.brokerAccountId)
    .eq("signal_id", args.basketSignalId)
    .eq("status", "open")
    .order("opened_at", { ascending: true })
    .limit(500)
  const legIndex = (openLegs ?? []).findIndex((r: { id: string }) => r.id === args.tradeRowId)

  const { data: pendingRows } = await supabase
    .from("range_pending_legs")
    .select("step_idx")
    .eq("broker_account_id", args.brokerAccountId)
    .eq("signal_id", args.basketSignalId)
    .in("status", ["pending", "claimed"])
    .limit(500)
  const openCount = openLegs?.length ?? 0
  const activePendingCount = pendingRows?.length ?? 0
  const maxPendingStepIdx = Math.max(0, ...(pendingRows ?? []).map((r: { step_idx: number }) => Number(r.step_idx) || 0))
  const totalPlannedLegs = estimateBasketTotalPlannedLegs({
    openLegCount: openCount,
    activePendingCount,
    maxPendingStepIdx,
  })
  const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount)
  const immediateLegCount = Math.max(0, openCount - firedPendingApprox)
  const rangeLegCount = Math.max(0, totalPlannedLegs - immediateLegCount)

  const legCtx: FollowUpLegContext = {
    legIndex,
    openCount,
    immediateLegCount,
    rangeLegCount,
    tpLots,
    anchorParsed,
    existingSl: args.existingSl,
    existingTp: args.existingTp,
    entryPrice: args.entryPrice,
    symbol: args.symbol,
    isBuy: args.isBuy ?? true,
    manual: channelManual,
  }

  const channelParams = await loadChannelActiveTradeParamsForSymbol(
    supabase,
    args.userId,
    channelId,
    args.symbol,
  )
  if (channelParams) {
    const channelStops = computeFollowUpStops(legCtx, {
      action: "modify",
      sl: channelParams.stoploss,
      tpLevels: channelParams.tpLevels,
    })
    if (channelStops) {
      const applied = await executeFollowUpModify(supabase, api, {
        userId: args.userId,
        brokerAccountId: args.brokerAccountId,
        metaUuid: args.metaUuid,
        ticket: args.ticket,
        tradeRowId: args.tradeRowId,
        basketSignalId: args.basketSignalId,
        sourceSignalId: args.basketSignalId,
        legIndex,
        ...channelStops,
      })
      if (applied) return
    }
  }

  const { data: candidates } = await supabase
    .from("signals")
    .select("id, parsed_data, created_at, is_modification")
    .eq("user_id", args.userId)
    .eq("channel_id", channelId)
    .in("status", ["parsed", "executed"])
    .gte("created_at", createdAt)
    .order("created_at", { ascending: false })
    .limit(60)

  for (const row of candidates ?? []) {
    const parsed = row.parsed_data as ParsedMgmt | null
    if (!parsed?.action) continue
    const act = String(parsed.action).toLowerCase()
    if (act !== "modify" && act !== "breakeven") continue
    if (!mgmtSignalMatchesBasketSymbol(parsed, args.symbol)) continue

    const stops = computeFollowUpStops(legCtx, {
      action: act,
      sl: parsed.sl,
      tpLevels: parsed.tp,
    })
    if (!stops) continue

    const applied = await executeFollowUpModify(supabase, api, {
      userId: args.userId,
      brokerAccountId: args.brokerAccountId,
      metaUuid: args.metaUuid,
      ticket: args.ticket,
      tradeRowId: args.tradeRowId,
      basketSignalId: args.basketSignalId,
      sourceSignalId: row.id,
      legIndex,
      ...stops,
    })
    if (applied) return
  }
}
