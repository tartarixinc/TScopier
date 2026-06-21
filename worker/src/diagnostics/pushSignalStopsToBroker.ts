/**
 * Emergency: push signal SL/TP to live broker positions via OrderModify.
 *
 * Railway / production (after npm run build):
 *   node -r dotenv/config dist/diagnostics/pushSignalStopsToBroker.js
 *
 * Local:
 *   cd worker && npm run build && npm run push-signal-stops
 *
 * Env:
 *   SIGNAL_ID          — optional; defaults to latest buy/sell with parsed SL today
 *   SINCE_ISO          — optional; only open trades opened after this (default: signal time - 2m)
 *   DRY_RUN=true       — print plan only, no broker calls
 *   ALL_CHANNELS=true  — apply to all open trades since SINCE (ignore signal channel filter)
 *   SYMBOL_PREFIX      — optional symbol filter (default: signal symbol or XAU)
 *   SL_ONLY=true       — modify stoploss only; leave each leg's TP unchanged on broker + DB
 *   PUSH_SL_ONLY=true  — alias for SL_ONLY
 *   SL_FROM=channel    — SL source: channel (default) | signal | trade
 *   SL_OVERRIDE=4319   — optional explicit SL (overrides SL_FROM)
 *   TP_ONLY=true       — modify takeprofit only; leave SL unchanged per leg
 *   TRADE_SCOPE=signal — only open legs on SIGNAL_ID (not since-window)
 *   FXSOCKET_ONLY=true — skip brokers that still use legacy metaapi_account_id
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import {
  getFxsocketClient,
  hasFxsocketConfigured,
  mtPlatformFrom,
} from '../fxsocketClient'
import { brokerSessionUuid, brokerHasLinkedSession } from '../tradeExecutor/helpers'
import {
  buildEntryQualityTakeProfitMap,
  type EntryQualityLeg,
} from '../manualPlanning/tpBucketDistribution'
import type { ManualTpLot } from '../manualPlanning/types'
import { loadChannelActiveTradeParamsForSymbol } from '../channelActiveTradeParams'
import { isBenignOrderModifyError, stopsAlreadyMatchDb } from '../orderModifyBenign'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type TradeRow = {
  id: string
  signal_id: string
  broker_account_id: string
  metaapi_order_id: string | null
  symbol: string
  direction: string
  sl: number | null
  tp: number | null
  opened_at: string
  entry_price: number | null
  telegram_channel_id: string | null
}

type BrokerRow = {
  id: string
  label?: string | null
  platform?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  manual_settings?: { tp_lots?: ManualTpLot[] | null } | null
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

async function resolveTargetSl(args: {
  signal: { channel_id: string | null; user_id: string; parsed_data: unknown }
  symbol: string
  slFrom: 'channel' | 'signal' | 'trade'
  tradeSl?: number | null
  channelId?: string | null
}): Promise<number> {
  const override = num(process.env.SL_OVERRIDE)
  if (override != null) return override

  const parsed = (args.signal.parsed_data ?? {}) as { sl?: unknown }
  const parsedSl = num(parsed.sl)
  const channelId = args.channelId ?? args.signal.channel_id

  const tryChannel = async (): Promise<number | null> => {
    if (!channelId) return null
    const ch = await loadChannelActiveTradeParamsForSymbol(
      supabase,
      args.signal.user_id,
      channelId,
      args.symbol,
    )
    return ch?.stoploss != null ? num(ch.stoploss) : null
  }

  if (args.slFrom === 'trade') {
    const fromTrade = num(args.tradeSl)
    if (fromTrade != null) return fromTrade
    const fromCh = await tryChannel()
    if (fromCh != null) return fromCh
    if (parsedSl != null) return parsedSl
  }

  if (args.slFrom === 'signal') {
    if (parsedSl != null) return parsedSl
    const fromCh = await tryChannel()
    if (fromCh != null) return fromCh
  }

  // default: channel first (catches SL adjustments like 4319 after initial 4321)
  const fromCh = await tryChannel()
  if (fromCh != null) return fromCh
  if (parsedSl != null) return parsedSl
  const fromTrade = num(args.tradeSl)
  if (fromTrade != null) return fromTrade

  throw new Error('No SL — set SL_OVERRIDE, channel_active_trade_params, or SIGNAL_ID with parsed SL')
}

async function resolveTpLadder(
  signal: { channel_id: string | null; user_id: string; parsed_data: unknown },
  symbol: string,
): Promise<{ tps: number[] }> {
  const parsed = (signal.parsed_data ?? {}) as { tp?: unknown[] }
  let tps = (parsed.tp ?? []).map(t => num(t)).filter((t): t is number => t != null)

  if (!tps.length && signal.channel_id) {
    const ch = await loadChannelActiveTradeParamsForSymbol(
      supabase,
      signal.user_id,
      signal.channel_id,
      symbol,
    )
    if (ch?.tpLevels?.length) tps = ch.tpLevels
  }

  if (!tps.length) throw new Error('No TP ladder — set SIGNAL_ID with parsed TPs or channel_active_trade_params')
  return { tps }
}

function parseSlFrom(): 'channel' | 'signal' | 'trade' {
  const raw = String(process.env.SL_FROM ?? 'channel').trim().toLowerCase()
  if (raw === 'signal' || raw === 'trade') return raw
  return 'channel'
}

export type PushStopsConfig = {
  signalId: string
  dryRun?: boolean
  slOnly?: boolean
  tpOnly?: boolean
  slFrom?: 'channel' | 'signal' | 'trade'
  slOverride?: number
  /** `signal` = open legs on this signal_id only; `since` = opened_at window (default). */
  tradeScope?: 'since' | 'signal'
  sinceIso?: string
  allChannels?: boolean
  symbolPrefix?: string
  /** Only brokers with fxsocket_account_id and empty legacy metaapi_account_id. */
  fxsocketOnly?: boolean
}

export async function runPushSignalStops(config: PushStopsConfig): Promise<void> {
  const dryRun = config.dryRun === true
  const slOnly = config.slOnly === true
  const tpOnly = config.tpOnly === true
  const slFrom = config.slFrom ?? 'channel'
  const tradeScope = config.tradeScope ?? 'since'
  const allChannels = config.allChannels !== false
  const fxsocketOnly = config.fxsocketOnly === true

  if (!dryRun && !hasFxsocketConfigured()) {
    throw new Error('FXSOCKET_API_KEY not set — cannot call broker')
  }

  const signalId = config.signalId
  const { data: signal, error: sigErr } = await supabase
    .from('signals')
    .select('id,channel_id,user_id,created_at,parsed_data')
    .eq('id', signalId)
    .maybeSingle()
  if (sigErr || !signal) throw sigErr ?? new Error(`signal not found: ${signalId}`)

  const parsed = (signal.parsed_data ?? {}) as { sl?: unknown; tp?: unknown[]; symbol?: string; action?: string }
  const symbolPrefix = String(config.symbolPrefix ?? process.env.SYMBOL_PREFIX ?? parsed.symbol ?? 'XAU').trim().toUpperCase()
  const signalTps = slOnly ? [] : (await resolveTpLadder(signal, symbolPrefix)).tps

  const sinceIso = config.sinceIso?.trim()
    || process.env.SINCE_ISO?.trim()
    || new Date(new Date(signal.created_at).getTime() - 2 * 60_000).toISOString()

  console.log(`Signal ${signalId}`)
  if (slOnly) {
    console.log(`  mode=SL_ONLY  SL_FROM=${slFrom}`)
  } else if (tpOnly) {
    console.log(`  mode=TP_ONLY  TPs=${signalTps.join(',')}`)
  } else {
    console.log(`  SL_FROM=${slFrom}  TPs=${signalTps.join(',')}`)
  }
  console.log(`  channel=${signal.channel_id}  tradeScope=${tradeScope}`)
  if (tradeScope === 'since') console.log(`  since=${sinceIso}`)
  if (fxsocketOnly) console.log('  fxsocketOnly=true')
  console.log(`  dryRun=${dryRun}\n`)

  let tradesQ = supabase
    .from('trades')
    .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,sl,tp,opened_at,entry_price,telegram_channel_id')
    .eq('status', 'open')
    .not('metaapi_order_id', 'is', null)
    .order('opened_at', { ascending: true })

  if (tradeScope === 'signal') {
    tradesQ = tradesQ.eq('signal_id', signalId)
  } else {
    tradesQ = tradesQ.gte('opened_at', sinceIso)
    if (!allChannels && signal.channel_id) {
      tradesQ = tradesQ.eq('telegram_channel_id', signal.channel_id)
    }
  }

  if (symbolPrefix) {
    tradesQ = tradesQ.ilike('symbol', `${symbolPrefix}%`)
  }

  const { data: trades, error: trErr } = await tradesQ
  if (trErr) throw trErr
  const rows = (trades ?? []) as TradeRow[]
  if (!rows.length) {
    console.log(
      tradeScope === 'signal'
        ? 'No open trades on this signal — check SIGNAL_ID / basket anchor'
        : 'No open trades matched — widen SINCE_ISO or check channel_id',
    )
    return
  }

  const slOverride = config.slOverride ?? num(process.env.SL_OVERRIDE)
  const prevSlOverride = process.env.SL_OVERRIDE
  if (slOverride != null) process.env.SL_OVERRIDE = String(slOverride)

  const brokerIds = [...new Set(rows.map(r => r.broker_account_id))]
  const { data: brokers } = await supabase
    .from('broker_accounts')
    .select('id,label,platform,fxsocket_account_id,metaapi_account_id,manual_settings')
    .in('id', brokerIds)
  const brokerById = new Map((brokers ?? []).map(b => [b.id, b as BrokerRow]))

  const api = getFxsocketClient()
  let modified = 0
  let failed = 0
  let skipped = 0

  try {
    for (const brokerId of brokerIds) {
      const broker = brokerById.get(brokerId)
      const uuid = broker ? brokerSessionUuid(broker) : null
      if (!broker || !uuid) {
        console.warn(`SKIP broker ${brokerId}: no FxSocket session id`)
        skipped += rows.filter(r => r.broker_account_id === brokerId).length
        continue
      }
      if (fxsocketOnly && !brokerHasLinkedSession(broker)) {
        const legCount = rows.filter(r => r.broker_account_id === brokerId).length
        console.log(`SKIP ${broker.label ?? brokerId}: not FxSocket-only (${legCount} leg(s))`)
        skipped += legCount
        continue
      }

      const client = api
      if (!client && !dryRun) {
        console.warn('SKIP all: FXSOCKET client unavailable')
        break
      }

      const platform = mtPlatformFrom(broker.platform)
      client?.seedPlatformCache(uuid, platform)

      const legs = rows
        .filter(r => r.broker_account_id === brokerId)
        .sort((a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime())

      const tpLots = broker.manual_settings?.tp_lots ?? null

      const isBuy = String(legs[0]?.direction ?? '').toLowerCase() === 'buy'
      const tpMap = slOnly || tpOnly
        ? new Map<string, number>()
        : buildEntryQualityTakeProfitMap({
            legs: legs.map(tr => ({
              id: tr.id,
              entryPrice: Number(tr.entry_price ?? 0),
              openedAt: tr.opened_at,
            })) satisfies EntryQualityLeg[],
            isBuy,
            slotLegCount: legs.length,
            finalTps: signalTps,
            tpLots: tpLots ?? null,
          })

      console.log(`\n${broker.label ?? brokerId} (${broker.platform}) — ${legs.length} leg(s)`)

      const slCache = new Map<string, number>()

      for (let i = 0; i < legs.length; i++) {
        const tr = legs[i]!
        const ticket = Number(tr.metaapi_order_id)
        if (!Number.isFinite(ticket) || ticket <= 0) {
          skipped++
          continue
        }

        const keepTp = num(tr.tp)
        const keepSl = num(tr.sl)
        const targetTp = tpOnly ? (tpMap.get(tr.id) ?? keepTp) : slOnly ? keepTp : (tpMap.get(tr.id) ?? keepTp)

        let targetSl: number | null = tpOnly ? keepSl : null
        if (!tpOnly) {
          const chKey = `${tr.telegram_channel_id ?? signal.channel_id ?? ''}|${tr.symbol}|${slFrom}`
          const cached = slCache.get(chKey)
          if (cached != null) {
            targetSl = cached
          } else {
            targetSl = await resolveTargetSl({
              signal,
              symbol: tr.symbol,
              slFrom,
              tradeSl: tr.sl,
              channelId: tr.telegram_channel_id ?? signal.channel_id,
            })
            slCache.set(chKey, targetSl)
          }
        }

        if (targetSl == null && !tpOnly) {
          skipped++
          continue
        }
        if (!slOnly && !tpOnly && (targetTp == null || !(targetTp > 0))) {
          skipped++
          continue
        }

        if (
          !tpOnly
          && targetSl != null
          && targetSl > 0
          && stopsAlreadyMatchDb(
            { sl: tr.sl, tp: tr.tp },
            { stoploss: targetSl, takeprofit: targetTp ?? 0 },
            0,
            0,
          )
        ) {
          console.log(`  leg ${i + 1}/${legs.length} ticket=${ticket} — SL/TP already match, skip`)
          skipped++
          continue
        }

        const slLabel = targetSl != null ? targetSl : '—'
        const tpLabel = targetTp != null ? targetTp : '—'
        console.log(
          `  leg ${i + 1}/${legs.length} ticket=${ticket} ${tr.symbol}`
          + ` → SL=${slLabel} TP=${tpLabel}${slOnly ? ' (TP unchanged)' : ''}`,
        )

        if (dryRun) continue

        try {
          const modifyArgs: { ticket: number; stoploss?: number; takeprofit?: number } = { ticket }
          if (!tpOnly && targetSl != null && targetSl > 0) modifyArgs.stoploss = targetSl
          if (!slOnly && targetTp != null && targetTp > 0) modifyArgs.takeprofit = targetTp
          if (modifyArgs.stoploss == null && modifyArgs.takeprofit == null) {
            skipped++
            continue
          }

          await client!.orderModify(uuid, modifyArgs)
          const dbPatch: { sl?: number | null; tp?: number | null } = {}
          if (!tpOnly && targetSl != null) dbPatch.sl = targetSl
          if (!slOnly && targetTp != null) dbPatch.tp = targetTp
          if (Object.keys(dbPatch).length > 0) {
            await supabase.from('trades').update(dbPatch).eq('id', tr.id)
          }
          await supabase.from('trade_execution_logs').insert({
            user_id: signal.user_id,
            signal_id: signalId,
            broker_account_id: brokerId,
            action: 'mgmt_modify',
            status: 'success',
            request_payload: {
              ticket,
              action: 'modify',
              target_sl: modifyArgs.stoploss ?? null,
              target_tp: modifyArgs.takeprofit ?? null,
              manual_push: true,
              sl_only: slOnly,
              tp_only: tpOnly,
              sl_from: slFrom,
              trade_id: tr.id,
            } as unknown as Record<string, unknown>,
          })
          modified++
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (isBenignOrderModifyError(msg)) {
            console.log(`    SKIP (benign): ${msg}`)
            skipped++
            continue
          }
          console.error(`    FAILED: ${msg}`)
          failed++
          try {
            await supabase.from('trade_execution_logs').insert({
              user_id: signal.user_id,
              signal_id: signalId,
              broker_account_id: brokerId,
              action: 'mgmt_modify',
              status: 'failed',
              error_message: msg,
              request_payload: { ticket, manual_push: true, trade_id: tr.id } as unknown as Record<string, unknown>,
            })
          } catch { /* best-effort */ }
        }
      }
    }
  } finally {
    if (prevSlOverride == null) delete process.env.SL_OVERRIDE
    else process.env.SL_OVERRIDE = prevSlOverride
  }

  console.log(`\nDone: modified=${modified} failed=${failed} skipped=${skipped}`)
}

async function resolveSignalId(): Promise<string> {
  const pinned = String(process.env.SIGNAL_ID ?? '').trim()
  if (pinned) return pinned

  const { data, error } = await supabase
    .from('signals')
    .select('id')
    .in('status', ['executed', 'parsed'])
    .filter('parsed_data->>sl', 'neq', '')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) throw error
  for (const row of data ?? []) {
    const { data: sig } = await supabase
      .from('signals')
      .select('id,parsed_data')
      .eq('id', row.id)
      .maybeSingle()
    const action = String((sig?.parsed_data as { action?: string } | null)?.action ?? '').toLowerCase()
    const sl = num((sig?.parsed_data as { sl?: unknown } | null)?.sl)
    if ((action === 'buy' || action === 'sell') && sl != null) return row.id
  }
  throw new Error('No entry signal with parsed SL found — set SIGNAL_ID')
}

async function main() {
  const dryRun = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true'
  const slOnly =
    String(process.env.SL_ONLY ?? process.env.PUSH_SL_ONLY ?? '').toLowerCase() === 'true'
  const tpOnly = String(process.env.TP_ONLY ?? '').toLowerCase() === 'true'
  const tradeScope = String(process.env.TRADE_SCOPE ?? 'since').trim().toLowerCase() === 'signal'
    ? 'signal'
    : 'since'

  const fxsocketOnly = String(process.env.FXSOCKET_ONLY ?? '').toLowerCase() === 'true'

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }

  const signalId = await resolveSignalId()
  await runPushSignalStops({
    signalId,
    dryRun,
    slOnly,
    tpOnly,
    slFrom: parseSlFrom(),
    tradeScope,
    sinceIso: process.env.SINCE_ISO?.trim(),
    allChannels: String(process.env.ALL_CHANNELS ?? 'true').toLowerCase() === 'true',
    symbolPrefix: process.env.SYMBOL_PREFIX?.trim(),
    fxsocketOnly,
  })
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
