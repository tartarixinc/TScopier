/**
 * Emergency: push signal SL/TP to live broker positions via OrderModify.
 *
 * Usage:
 *   cd worker && npx ts-node -r dotenv/config src/diagnostics/pushSignalStopsToBroker.ts
 *
 * Env:
 *   SIGNAL_ID          — optional; defaults to latest buy/sell with parsed SL today
 *   SINCE_ISO          — optional; only open trades opened after this (default: signal time - 2m)
 *   DRY_RUN=true       — print plan only, no broker calls
 *   ALL_CHANNELS=true  — apply to all open trades since SINCE (ignore signal channel filter)
 *   SYMBOL_PREFIX      — optional symbol filter (default: signal symbol or XAU)
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import {
  getFxsocketClient,
  hasFxsocketConfigured,
  mtPlatformFrom,
  type FxsocketBrokerClient,
} from '../fxsocketClient'
import { brokerSessionUuid } from '../tradeExecutor/helpers'
import { takeProfitForLegIndex } from '../manualPlanning/tpBucketDistribution'

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
  telegram_channel_id: string | null
}

type BrokerRow = {
  id: string
  label?: string | null
  platform?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  manual_settings?: { tp_lots?: unknown } | null
}

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function tpForLegIndex(tps: number[], legIndex: number): number | null {
  if (!tps.length) return null
  const idx = Math.min(Math.max(0, legIndex), tps.length - 1)
  return tps[idx] ?? tps[tps.length - 1] ?? null
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
  if (!dryRun && !hasFxsocketConfigured()) {
    throw new Error('FXSOCKET_API_KEY not set — cannot call broker')
  }

  const signalId = await resolveSignalId()
  const { data: signal, error: sigErr } = await supabase
    .from('signals')
    .select('id,channel_id,user_id,created_at,parsed_data')
    .eq('id', signalId)
    .maybeSingle()
  if (sigErr || !signal) throw sigErr ?? new Error(`signal not found: ${signalId}`)

  const parsed = (signal.parsed_data ?? {}) as { sl?: unknown; tp?: unknown[]; symbol?: string; action?: string }
  const signalSl = num(parsed.sl)
  const signalTps = (parsed.tp ?? [])
    .map(t => num(t))
    .filter((t): t is number => t != null)
  if (signalSl == null) throw new Error(`signal ${signalId} has no parsed SL`)

  const sinceIso = process.env.SINCE_ISO?.trim()
    || new Date(new Date(signal.created_at).getTime() - 2 * 60_000).toISOString()

  console.log(`Signal ${signalId}`)
  console.log(`  SL=${signalSl}  TPs=${signalTps.join(',') || '(none — using last TP only)'}`)
  console.log(`  channel=${signal.channel_id}  since=${sinceIso}`)
  console.log(`  dryRun=${dryRun}\n`)

  const allChannels = String(process.env.ALL_CHANNELS ?? 'true').toLowerCase() === 'true'
  const symbolPrefix = String(process.env.SYMBOL_PREFIX ?? parsed.symbol ?? 'XAU').trim().toUpperCase()

  let tradesQ = supabase
    .from('trades')
    .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,sl,tp,opened_at,telegram_channel_id')
    .eq('status', 'open')
    .gte('opened_at', sinceIso)
    .not('metaapi_order_id', 'is', null)
    .order('opened_at', { ascending: true })

  if (!allChannels && signal.channel_id) {
    tradesQ = tradesQ.eq('telegram_channel_id', signal.channel_id)
  }
  if (symbolPrefix) {
    tradesQ = tradesQ.ilike('symbol', `${symbolPrefix}%`)
  }

  const { data: trades, error: trErr } = await tradesQ
  if (trErr) throw trErr
  const rows = (trades ?? []) as TradeRow[]
  if (!rows.length) {
    console.log('No open trades matched — widen SINCE_ISO or check channel_id')
    return
  }

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

  for (const brokerId of brokerIds) {
    const broker = brokerById.get(brokerId)
    const uuid = broker ? brokerSessionUuid(broker) : null
    if (!broker || !uuid) {
      console.warn(`SKIP broker ${brokerId}: no FxSocket session id`)
      skipped += rows.filter(r => r.broker_account_id === brokerId).length
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

    const tpLots = (broker.manual_settings as { tp_lots?: Parameters<typeof takeProfitForLegIndex>[0]['tpLots'] } | null)?.tp_lots

    console.log(`\n${broker.label ?? brokerId} (${broker.platform}) — ${legs.length} leg(s)`)

    for (let i = 0; i < legs.length; i++) {
      const tr = legs[i]!
      const ticket = Number(tr.metaapi_order_id)
      if (!Number.isFinite(ticket) || ticket <= 0) {
        skipped++
        continue
      }

      let targetTp = tpForLegIndex(signalTps, i)
      if (targetTp == null && signalTps.length) {
        targetTp = takeProfitForLegIndex({
          legIndex: i,
          openLegCount: legs.length,
          finalTps: signalTps,
          tpLots: tpLots ?? null,
        })
      }
      if (targetTp == null && num(tr.tp) != null) targetTp = num(tr.tp)

      const targetSl = signalSl

      console.log(
        `  leg ${i + 1}/${legs.length} ticket=${ticket} ${tr.symbol}`
        + ` → SL=${targetSl} TP=${targetTp ?? '—'}`,
      )

      if (dryRun) continue

      try {
        await client!.orderModify(uuid, {
          ticket,
          stoploss: targetSl,
          takeprofit: targetTp ?? undefined,
        })
        await supabase
          .from('trades')
          .update({ sl: targetSl, tp: targetTp })
          .eq('id', tr.id)
        await supabase.from('trade_execution_logs').insert({
          user_id: signal.user_id,
          signal_id: signalId,
          broker_account_id: brokerId,
          action: 'mgmt_modify',
          status: 'success',
          request_payload: {
            ticket,
            action: 'modify',
            target_sl: targetSl,
            target_tp: targetTp,
            manual_push: true,
            trade_id: tr.id,
          } as unknown as Record<string, unknown>,
        })
        modified++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
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

  console.log(`\nDone: modified=${modified} failed=${failed} skipped=${skipped}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
