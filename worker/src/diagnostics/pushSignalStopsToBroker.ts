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
import { hasFxsocketConfigured } from '../fxsocketClient'
import { loadChannelActiveTradeParamsForSymbol } from '../channelActiveTradeParams'
import {
  applyChannelStopsToBaskets,
  groupLegsByBrokerSignal,
  type ChannelStopBroker,
  type ChannelStopLeg,
} from '../channelStopApply'
import { apiForBrokerAccount } from '../providerResolver'
import { brokerSessionUuid } from '../tradeExecutor/helpers'
import {
  authorityFromBrokerRow,
  createSupabaseBrokerWriteAuthorityStore,
  registerBrokerWriteAuthorityStore,
} from '../brokerWriteAuthority'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)
registerBrokerWriteAuthorityStore(createSupabaseBrokerWriteAuthorityStore(supabase))

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
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
  const slOverride = config.slOverride ?? num(process.env.SL_OVERRIDE)

  const sinceIso = config.sinceIso?.trim()
    || process.env.SINCE_ISO?.trim()
    || new Date(new Date(signal.created_at).getTime() - 2 * 60_000).toISOString()

  console.log(`Signal ${signalId}`)
  if (slOnly) {
    console.log(`  mode=SL_ONLY  SL_FROM=${config.slFrom ?? 'channel'}`)
  } else if (tpOnly) {
    console.log(`  mode=TP_ONLY  TPs=${signalTps.join(',')}`)
  } else {
    console.log(`  SL_FROM=${config.slFrom ?? 'channel'}  TPs=${signalTps.join(',')}`)
  }
  console.log(`  channel=${signal.channel_id}  tradeScope=${tradeScope}`)
  if (tradeScope === 'since') console.log(`  since=${sinceIso}`)
  if (fxsocketOnly) console.log('  fxsocketOnly=true')
  console.log(`  dryRun=${dryRun}\n`)

  let tradesQ = supabase
    .from('trades')
    .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,sl,tp,opened_at,entry_price,telegram_channel_id,lot_size')
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
  const rows = (trades ?? []) as ChannelStopLeg[]
  if (!rows.length) {
    console.log(
      tradeScope === 'signal'
        ? 'No open trades on this signal — check SIGNAL_ID / basket anchor'
        : 'No open trades matched — widen SINCE_ISO or check channel_id',
    )
    return
  }

  const brokerIds = [...new Set(rows.map(r => r.broker_account_id))]
  const { data: brokers } = await supabase
    .from('broker_accounts')
    .select('id,label,platform,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id,writer_epoch,provider_transition_state,manual_settings')
    .in('id', brokerIds)
  const brokerById = new Map((brokers ?? []).map(b => [b.id, b as ChannelStopBroker]))

  const result = await applyChannelStopsToBaskets({
    supabase,
    apiFor: broker => {
      const sessionId = brokerSessionUuid(broker)
      if (!sessionId) return null
      return apiForBrokerAccount(broker.provider, sessionId, authorityFromBrokerRow(broker))
    },
    userId: signal.user_id,
    channelId: signal.channel_id,
    signalId,
    brokersById: brokerById,
    rowsByBrokerSignal: groupLegsByBrokerSignal(rows),
    hasNewSl: slOnly || (!tpOnly && (slOverride != null || num(parsed.sl) != null)),
    hasNewTp: tpOnly || (!slOnly && signalTps.length > 0),
    parsedSl: slOverride ?? num(parsed.sl),
    parsedTpLevels: signalTps,
    slOverride,
    slFrom: config.slFrom ?? 'channel',
    slOnly,
    tpOnly,
    dryRun,
    manualPush: true,
    verifyOnBroker: !dryRun,
    fxsocketOnly,
  })

  for (const br of result.brokers) {
    const broker = brokerById.get(br.brokerId)
    console.log(
      `\n${broker?.label ?? br.brokerId} — legs=${br.openLegs}`
      + ` modified=${br.modified} failed=${br.failed} skipped=${br.skipped}`,
    )
  }

  console.log(
    `\nDone: modified=${result.totalModified} failed=${result.totalFailed}`
    + ` skipped=${result.totalSkipped} allSynced=${result.allFullySynced}`,
  )
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
