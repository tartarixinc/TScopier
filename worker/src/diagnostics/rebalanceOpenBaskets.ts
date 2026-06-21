/**
 * One-off: redistribute TP1/TP2/TP3 across open basket legs (entry-quality + Targets %).
 *
 * Railway / production (after npm run build):
 *   node -r dotenv/config dist/diagnostics/rebalanceOpenBaskets.js
 *
 * Local dev:
 *   cd worker && npm run build && npm run rebalance-open-baskets
 *
 * Env:
 *   SIGNAL_ID     — parameter signal with SL/TP ladder (optional if CHANNEL_ID + ladder in DB)
 *   SINCE_ISO     — only baskets with trades opened after this (default: today UTC 00:00)
 *   SYMBOL_PREFIX — default XAU
 *   DRY_RUN=true  — print plan only
 *   ALL_CHANNELS=true — ignore per-signal channel filter on trade rows (default true)
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import {
  getFxsocketClient,
  hasFxsocketConfigured,
  mtPlatformFrom,
} from '../fxsocketClient'
import {
  logEffectiveBasketStops,
  resolveEffectiveBasketStops,
} from '../basketEffectiveStops'
import { brokerSessionUuid } from '../tradeExecutor/helpers'
import {
  buildEntryQualityTakeProfitMap,
  type EntryQualityLeg,
} from '../manualPlanning/tpBucketDistribution'
import { resolveRangeBasketFinalTps, toRangeBasketParsedSlice } from '../rangeBasketTpSync'
import type { BasketOpenLeg } from '../basketSlTpReconcile'
import type { ManualTpLot } from '../manualPlanning/types'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type TradeRow = BasketOpenLeg & {
  broker_account_id: string
  user_id?: string
}

type BrokerRow = {
  id: string
  user_id: string
  label?: string | null
  platform?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  manual_settings?: { tp_lots?: ManualTpLot[] | null; range_trading?: boolean } | null
}

type BasketKey = string

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function basketKey(signalId: string, brokerId: string): BasketKey {
  return `${signalId}|${brokerId}`
}

function todayUtcStart(): string {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
}

async function resolveLadderSignal(): Promise<{
  id: string
  channel_id: string | null
  user_id: string
  created_at: string
  sl: number
  tps: number[]
} | null> {
  const pinned = String(process.env.SIGNAL_ID ?? '').trim()
  if (!pinned) return null

  const { data, error } = await supabase
    .from('signals')
    .select('id,channel_id,user_id,created_at,parsed_data')
    .eq('id', pinned)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error(`signal not found: ${pinned}`)

  const parsed = (data.parsed_data ?? {}) as { sl?: unknown; tp?: unknown[] }
  const sl = num(parsed.sl)
  const tps = (parsed.tp ?? []).map(t => num(t)).filter((t): t is number => t != null)
  if (sl == null || !tps.length) {
    console.warn(`Signal ${pinned} missing parsed SL/TP — will use channel_active_trade_params per basket`)
    return {
      id: data.id,
      channel_id: data.channel_id,
      user_id: data.user_id,
      created_at: data.created_at,
      sl: sl ?? 0,
      tps: [],
    }
  }
  return { id: data.id, channel_id: data.channel_id, user_id: data.user_id, created_at: data.created_at, sl, tps }
}

async function main() {
  const dryRun = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true'
  if (!dryRun && !hasFxsocketConfigured()) {
    throw new Error('FXSOCKET_API_KEY not set — set it on Railway or use DRY_RUN=true')
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }

  const ladderSignal = await resolveLadderSignal()
  const sinceIso = process.env.SINCE_ISO?.trim() || todayUtcStart()
  const symbolPrefix = String(process.env.SYMBOL_PREFIX ?? 'XAU').trim().toUpperCase()
  const allChannels = String(process.env.ALL_CHANNELS ?? 'true').toLowerCase() === 'true'

  console.log(`Rebalance open baskets`)
  console.log(`  since=${sinceIso}  symbol~=${symbolPrefix}%  dryRun=${dryRun}`)
  if (ladderSignal) {
    console.log(
      `  ladder signal=${ladderSignal.id}  SL=${ladderSignal.sl ?? '—'}`
      + `  TPs=${ladderSignal.tps.join(',') || '(from channel memory)'}`,
    )
  }
  console.log()

  let tradesQ = supabase
    .from('trades')
    .select(
      'id,signal_id,broker_account_id,user_id,metaapi_order_id,opened_at,lot_size,sl,tp,entry_price,direction,symbol',
    )
    .eq('status', 'open')
    .gte('opened_at', sinceIso)
    .not('metaapi_order_id', 'is', null)
    .order('opened_at', { ascending: true })

  if (symbolPrefix) {
    tradesQ = tradesQ.ilike('symbol', `${symbolPrefix}%`)
  }

  const { data: trades, error: trErr } = await tradesQ
  if (trErr) throw trErr
  const rows = (trades ?? []) as TradeRow[]
  if (!rows.length) {
    console.log('No open trades matched — widen SINCE_ISO or SYMBOL_PREFIX')
    return
  }

  const byBasket = new Map<BasketKey, TradeRow[]>()
  for (const tr of rows) {
    const key = basketKey(tr.signal_id, tr.broker_account_id)
    const arr = byBasket.get(key) ?? []
    arr.push(tr)
    byBasket.set(key, arr)
  }

  const brokerIds = [...new Set(rows.map(r => r.broker_account_id))]
  const { data: brokers } = await supabase
    .from('broker_accounts')
    .select('id,user_id,label,platform,fxsocket_account_id,metaapi_account_id,manual_settings')
    .in('id', brokerIds)
  const brokerById = new Map((brokers ?? []).map(b => [b.id, b as BrokerRow]))

  const signalIds = [...new Set(rows.map(r => r.signal_id))]
  const { data: signalRows } = await supabase
    .from('signals')
    .select('id,channel_id,user_id,created_at,parsed_data')
    .in('id', signalIds)
  const signalById = new Map((signalRows ?? []).map(s => [s.id, s]))

  const api = getFxsocketClient()
  let basketsDone = 0
  let modified = 0
  let failed = 0
  let skipped = 0

  for (const [key, legs] of byBasket) {
    const [anchorSignalId, brokerId] = key.split('|')
    if (!anchorSignalId || !brokerId) continue

    const broker = brokerById.get(brokerId)
    const uuid = broker ? brokerSessionUuid(broker) : null
    if (!broker || !uuid) {
      console.warn(`SKIP basket ${key}: no FxSocket session id`)
      skipped += legs.length
      continue
    }

    const anchorSig = signalById.get(anchorSignalId)
    const channelId = anchorSig?.channel_id ?? ladderSignal?.channel_id ?? null
    const userId = broker.user_id ?? anchorSig?.user_id ?? ladderSignal?.user_id
    if (!userId) {
      skipped += legs.length
      continue
    }

    if (!allChannels && ladderSignal?.channel_id && channelId !== ladderSignal.channel_id) {
      continue
    }

    const symbol = legs[0]?.symbol ?? 'XAUUSD'
    const isBuy = String(legs[0]?.direction ?? '').toLowerCase() === 'buy'

    const parsedSlice = toRangeBasketParsedSlice(
      ladderSignal?.tps.length
        ? { sl: ladderSignal.sl, tp: ladderSignal.tps }
        : (anchorSig?.parsed_data as { sl?: unknown; tp?: unknown } | null),
    )

    const effective = await resolveEffectiveBasketStops({
      supabase,
      userId,
      channelId,
      anchorSignalId,
      symbol,
      basketCreatedAt: anchorSig?.created_at ?? ladderSignal?.created_at ?? null,
      anchorParsed: parsedSlice,
      familyTrades: legs,
    })
    logEffectiveBasketStops('[rebalanceOpenBaskets]', anchorSignalId, effective)

    const channelTpLevels = effective.tpLevels.length ? effective.tpLevels : null

    const finalTps = resolveRangeBasketFinalTps({
      parsed: effective.parsedSlice,
      plan: null,
      familyTrades: legs,
      channelTpLevels,
      direction: isBuy ? 'buy' : 'sell',
    })

    if (finalTps.length < 2) {
      console.warn(
        `SKIP basket ${broker.label ?? brokerId} signal=${anchorSignalId}`
        + ` — ladder has ${finalTps.length} TP level(s): [${finalTps.join(',')}]`,
      )
      skipped += legs.length
      continue
    }

    const targetSl = effective.stoploss > 0
      ? effective.stoploss
      : ladderSignal?.sl
        ?? num(parsedSlice.sl)
        ?? num(legs[0]?.sl)
        ?? 0

    const tpLots = broker.manual_settings?.tp_lots ?? null
    const entryLegs: EntryQualityLeg[] = legs.map(tr => ({
      id: tr.id,
      entryPrice: Number(tr.entry_price ?? 0),
      openedAt: String(tr.opened_at ?? ''),
    }))
    const tpMap = buildEntryQualityTakeProfitMap({
      legs: entryLegs,
      isBuy,
      slotLegCount: legs.length,
      finalTps,
      tpLots,
    })

    const tpCounts: Record<string, number> = {}
    for (const tp of tpMap.values()) {
      const k = String(tp)
      tpCounts[k] = (tpCounts[k] ?? 0) + 1
    }

    console.log(
      `\n${broker.label ?? brokerId} signal=${anchorSignalId} legs=${legs.length}`
      + ` ladder=[${finalTps.join(',')}] targets=${JSON.stringify(tpCounts)}`,
    )

    if (!api && !dryRun) break
    api?.seedPlatformCache(uuid, mtPlatformFrom(broker.platform))

    for (const tr of legs) {
      const ticket = Number(tr.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        skipped++
        continue
      }

      const targetTp = tpMap.get(tr.id)
      if (targetTp == null || !(targetTp > 0)) {
        skipped++
        continue
      }

      const curTp = num(tr.tp)
      const curSl = num(tr.sl)
      if (curTp === targetTp && (targetSl <= 0 || curSl === targetSl)) {
        console.log(`  ticket=${ticket} already SL=${curSl} TP=${curTp}`)
        continue
      }

      console.log(`  ticket=${ticket} ${tr.symbol} → SL=${targetSl || curSl} TP=${targetTp}`)

      if (dryRun) continue

      try {
        await api!.orderModify(uuid, {
          ticket,
          stoploss: targetSl > 0 ? targetSl : curSl ?? undefined,
          takeprofit: targetTp,
        })
        await supabase
          .from('trades')
          .update({
            sl: targetSl > 0 ? targetSl : tr.sl,
            tp: targetTp,
          })
          .eq('id', tr.id)
        await supabase.from('trade_execution_logs').insert({
          user_id: userId,
          signal_id: anchorSignalId,
          broker_account_id: brokerId,
          action: 'range_basket_tp_rebalance',
          status: 'success',
          request_payload: {
            manual_rebalance: true,
            ticket,
            trade_id: tr.id,
            target_sl: targetSl > 0 ? targetSl : curSl,
            target_tp: targetTp,
            target_tp_counts: tpCounts,
            final_tps: finalTps,
            phase: 'layering_rebalance',
          } as unknown as Record<string, unknown>,
        })
        modified++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`    FAILED ticket=${ticket}: ${msg}`)
        failed++
      }
    }
    basketsDone++
  }

  console.log(`\nDone: baskets=${basketsDone} modified=${modified} failed=${failed} skipped=${skipped}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
