import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { breakevenStopLossForSymbol } from './autoManagement'
import type { ManualTpLot } from './manualPlanning/types'
import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import { resolveChannelTradingConfig } from './channelTradingConfig'
import {
  channelParamsPredateBasket,
  estimateBasketTotalPlannedLegs,
  loadChannelActiveTradeParamsForSymbol,
  stripInvalidStopsForSide,
} from './channelActiveTradeParams'
import { resolveRangeBasketLegCounts } from './rangeBasketTpSync'
import {
  takeProfitForEntryQualityLeg,
  takeProfitForPoolLegIndex,
  takeProfitForSplitBasketLeg,
  type EntryQualityLeg,
  type RangeBasketTpPhase,
} from './manualPlanning/tpBucketDistribution'
import { isBenignOrderModifyError } from './orderModifyBenign'

type ParsedMgmt = {
  action?: string
  symbol?: string | null
  sl?: number | null
  tp?: number[] | null
}

function sanitizeLevel(v: number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function positiveTps(parsed: ParsedMgmt | null | undefined): number[] {
  return (parsed?.tp ?? []).filter(
    (t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0,
  )
}

export function symbolsCompatibleForBasket(signalSym: string | null | undefined, brokerSym: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const a = norm(String(signalSym ?? ''))
  const b = norm(String(brokerSym ?? ''))
  if (!a.length || !b.length) return false
  return a === b || b.includes(a) || a.includes(b)
}

/** Symbol-less modify/breakeven messages apply to the whole channel basket for `brokerSymbol`. */
export function mgmtSignalMatchesBasketSymbol(
  parsed: { action?: string; symbol?: string | null },
  brokerSymbol: string,
): boolean {
  const act = String(parsed.action ?? '').toLowerCase()
  if (act === 'modify' || act === 'breakeven') {
    const sym = parsed.symbol
    if (sym == null || String(sym).trim() === '') return true
    return symbolsCompatibleForBasket(sym, brokerSymbol)
  }
  return symbolsCompatibleForBasket(parsed.symbol, brokerSymbol)
}

type FollowUpLegContext = {
  legIndex: number
  openCount: number
  immediateLegCount: number
  rangeLegCount: number
  tpLots: ManualTpLot[] | null | undefined
  anchorParsed: ParsedMgmt | null | undefined
  existingSl: number | null
  existingTp: number | null
  entryPrice: number | null
  symbol: string
  isBuy: boolean
  manual: { breakeven_offset_pips?: number; range_trading?: boolean }
  tradeRowId?: string
  openLegsForTp?: EntryQualityLeg[]
  tpPhase?: RangeBasketTpPhase
}

export function computeFollowUpStops(
  ctx: FollowUpLegContext,
  source: {
    sl?: number | null
    tpLevels?: number[] | null
    action?: string
  },
): { stoploss: number; takeprofit: number; dbPatch: Record<string, number | null> } | null {
  const act = String(source.action ?? 'modify').toLowerCase()
  if (act === 'breakeven') {
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

  const hasNewSl = typeof source.sl === 'number' && Number.isFinite(source.sl) && source.sl > 0
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
    if (ctx.manual.range_trading === true && ctx.tpPhase === 'layering_rebalance'
      && ctx.tradeRowId && ctx.openLegsForTp?.length) {
      takeprofit = takeProfitForEntryQualityLeg({
        legId: ctx.tradeRowId,
        openLegs: ctx.openLegsForTp,
        isBuy: ctx.isBuy,
        finalTps,
        tpLots: ctx.tpLots,
      })
    } else if (ctx.manual.range_trading === true && ctx.tpPhase === 'instant_only') {
      takeprofit = takeProfitForPoolLegIndex({
        poolLegIndex: idx,
        poolLegCount: Math.max(1, ctx.immediateLegCount),
        finalTps,
        tpLots: ctx.tpLots,
      })
    } else {
      takeprofit = takeProfitForSplitBasketLeg({
        legIndex: idx,
        immediateLegCount: ctx.immediateLegCount,
        rangeLegCount: ctx.rangeLegCount,
        finalTps,
        tpLots: ctx.tpLots,
      })
    }
    if (takeprofit <= 0) {
      takeprofit = finalTps[finalTps.length - 1]!
    }
    if (takeprofit > 0) dbPatch.tp = takeprofit
  }

  return { stoploss, takeprofit, dbPatch }
}

async function executeFollowUpModify(
  supabase: SupabaseClient,
  api: FxsocketBrokerClient,
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
      await supabase.from('trades').update(args.dbPatch).eq('id', args.tradeRowId)
    }
    await supabase.from('trade_execution_logs').insert({
      user_id: args.userId,
      signal_id: args.sourceSignalId,
      broker_account_id: args.brokerAccountId,
      action: 'mgmt_range_leg_followup',
      status: 'success',
      request_payload: {
        ticket: args.ticket,
        trade_id: args.tradeRowId,
        leg_index: args.legIndex >= 0 ? args.legIndex + 1 : null,
        stoploss: args.stoploss,
        takeprofit: args.takeprofit,
        basket_signal_id: args.basketSignalId,
      } as unknown as Record<string, unknown>,
    })
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const benign = isBenignOrderModifyError(msg)
    await supabase.from('trade_execution_logs').insert({
      user_id: args.userId,
      signal_id: args.sourceSignalId,
      broker_account_id: args.brokerAccountId,
      action: 'mgmt_range_leg_followup',
      status: benign ? 'success' : 'failed',
      error_message: benign ? null : msg,
      request_payload: {
        ticket: args.ticket,
        trade_id: args.tradeRowId,
        basket_signal_id: args.basketSignalId,
      } as unknown as Record<string, unknown>,
    })
    return benign
  }
}

/**
 * When a virtual range leg fills after an SL/TP (or breakeven) message was already
 * processed for the basket, apply the newest matching management instruction to this
 * position immediately (do not wait for the trade-executor sweep).
 */
export async function tryApplyBasketFollowUpToNewFill(
  supabase: SupabaseClient,
  api: FxsocketBrokerClient,
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
    tpLots?: ManualTpLot[] | null
    /** Direction of the filled leg — enables wrong-side stop validation. */
    isBuy?: boolean | null
  },
): Promise<void> {
  const { data: basket } = await supabase
    .from('signals')
    .select('channel_id, created_at, parsed_data')
    .eq('id', args.basketSignalId)
    .maybeSingle()

  const channelId = basket?.channel_id as string | null | undefined
  const createdAt = basket?.created_at as string | null | undefined
  const anchorParsed = basket?.parsed_data as ParsedMgmt | null | undefined
  if (!channelId || !createdAt) return

  let tpLots = args.tpLots
  let channelManual: { breakeven_offset_pips?: number } = {}
  const { data: br } = await supabase
    .from('broker_accounts')
    .select('manual_settings, channel_trading_configs, copier_mode, ai_settings')
    .eq('id', args.brokerAccountId)
    .maybeSingle()
  const resolvedManual = normalizeManualSettingsForExecution(
    resolveChannelTradingConfig(
      (br ?? {}) as Parameters<typeof resolveChannelTradingConfig>[0],
      channelId,
    ).manual_settings,
  )
  channelManual = resolvedManual
  if (tpLots === undefined) {
    tpLots = resolvedManual.tp_lots
  }

  const { data: openLegs } = await supabase
    .from('trades')
    .select('id, entry_price, opened_at')
    .eq('broker_account_id', args.brokerAccountId)
    .eq('signal_id', args.basketSignalId)
    .eq('status', 'open')
    .order('opened_at', { ascending: true })
    .limit(500)
  const legIndex = (openLegs ?? []).findIndex(r => r.id === args.tradeRowId)

  const { data: pendingRows } = await supabase
    .from('range_pending_legs')
    .select('step_idx, status')
    .eq('broker_account_id', args.brokerAccountId)
    .eq('signal_id', args.basketSignalId)
    .limit(500)
  const openCount = openLegs?.length ?? 0
  const activePendingCount = (pendingRows ?? []).filter(
    r => r.status === 'pending' || r.status === 'claimed',
  ).length
  const maxPendingStepIdx = Math.max(0, ...(pendingRows ?? []).map(r => Number(r.step_idx) || 0))
  const totalPlannedLegs = estimateBasketTotalPlannedLegs({
    openLegCount: openCount,
    activePendingCount,
    maxPendingStepIdx,
  })
  const firedPendingApprox = Math.max(0, maxPendingStepIdx - activePendingCount)
  const immediateLegCount = Math.max(0, openCount - firedPendingApprox)
  const rangeLegCount = Math.max(0, totalPlannedLegs - immediateLegCount)
  const planImmediateLegCount = Math.max(immediateLegCount, openCount - firedPendingApprox)
  const { phase: tpPhase } = resolveRangeBasketLegCounts({
    openLegCount: openCount,
    planImmediateLegCount,
    activePendingCount,
    maxPendingStepIdx,
  })
  const openLegsForTp: EntryQualityLeg[] = (openLegs ?? []).map(row => ({
    id: row.id,
    entryPrice: Number(row.entry_price ?? 0),
    openedAt: String(row.opened_at ?? ''),
  }))

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
    tradeRowId: args.tradeRowId,
    openLegsForTp,
    tpPhase,
  }

  const channelParams = await loadChannelActiveTradeParamsForSymbol(
    supabase,
    args.userId,
    channelId,
    args.symbol,
  )
  if (channelParams && channelParamsPredateBasket(channelParams, createdAt)) {
    // Memory left over from an older signal cycle (clearing was blocked, e.g.
    // by ghost open rows). Applying it gives wrong-side "Invalid stops".
    console.log(
      `[basketModFollowUp] skip stale channel memory basket=${args.basketSignalId}`
      + ` symbol=${args.symbol} memory_updated=${channelParams.updatedAt}`
      + ` basket_created=${createdAt}`,
    )
  } else if (channelParams) {
    const skipChannelTp =
      resolvedManual.range_trading === true && tpPhase === 'layering_rebalance'
    const channelStops = computeFollowUpStops(legCtx, {
      action: 'modify',
      sl: channelParams.stoploss,
      tpLevels: skipChannelTp ? [] : channelParams.tpLevels,
    })
    if (channelStops) {
      let stops = channelStops
      const entryRef = sanitizeLevel(args.entryPrice)
      if (entryRef > 0 && args.isBuy != null) {
        const stripped = stripInvalidStopsForSide({
          stoploss: channelStops.stoploss,
          takeprofit: channelStops.takeprofit,
          referencePrice: entryRef,
          isBuy: args.isBuy,
        })
        if (stripped.stripped.length) {
          console.warn(
            `[basketModFollowUp] channel memory stops on wrong side basket=${args.basketSignalId}`
            + ` ticket=${args.ticket} dropped: ${stripped.stripped.join(', ')}`,
          )
          const dbPatch = { ...channelStops.dbPatch }
          if (stripped.stoploss <= 0) delete dbPatch.sl
          if (stripped.takeprofit <= 0) delete dbPatch.tp
          stops = {
            stoploss: stripped.stoploss > 0 ? stripped.stoploss : sanitizeLevel(legCtx.existingSl),
            takeprofit: stripped.takeprofit > 0 ? stripped.takeprofit : sanitizeLevel(legCtx.existingTp),
            dbPatch,
          }
        }
      }
      const changesAnything =
        stops.stoploss !== sanitizeLevel(legCtx.existingSl)
        || stops.takeprofit !== sanitizeLevel(legCtx.existingTp)
      if (changesAnything) {
        const applied = await executeFollowUpModify(supabase, api, {
          userId: args.userId,
          brokerAccountId: args.brokerAccountId,
          metaUuid: args.metaUuid,
          ticket: args.ticket,
          tradeRowId: args.tradeRowId,
          basketSignalId: args.basketSignalId,
          sourceSignalId: args.basketSignalId,
          legIndex,
          ...stops,
        })
        if (applied) return
      }
    }
  }

  const { data: candidates } = await supabase
    .from('signals')
    .select('id, parsed_data, created_at, is_modification')
    .eq('user_id', args.userId)
    .eq('channel_id', channelId)
    .in('status', ['parsed', 'executed'])
    .gte('created_at', createdAt)
    .order('created_at', { ascending: false })
    .limit(60)

  for (const row of candidates ?? []) {
    const parsed = row.parsed_data as ParsedMgmt | null
    if (!parsed?.action) continue
    const act = String(parsed.action).toLowerCase()
    if (act !== 'modify' && act !== 'breakeven') continue
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
