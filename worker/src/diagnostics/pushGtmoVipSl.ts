/**
 * Push SL only to all open legs on the latest GTMO VIP basket anchor signal.
 *
 * Railway / production (after npm run build):
 *   node -r dotenv/config dist/diagnostics/pushGtmoVipSl.js
 *
 * Local:
 *   cd worker && npm run build && npm run push-gtmo-vip-sl
 *
 * Env:
 *   SL_OVERRIDE=4261   — target SL (default 4261)
 *   USER_ID=           — optional; limit to one copier user
 *   ALL_GTMO_USERS=true — run for every subscriber with open GTMO VIP legs (not just one)
 *   FXSOCKET_ONLY=true — only brokers on fxsocket_account_id (no legacy metaapi_account_id)
 *   DRY_RUN=true       — print plan only, no broker calls
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { runPushSignalStops } from './pushSignalStopsToBroker'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const GTMO_CHANNEL_PATTERN = '%GTMO VIP%'

export async function resolveGtmoVipAnchorSignalId(userId?: string): Promise<{
  signalId: string
  userId: string
  displayName: string
  createdAt: string
  openLegs: number
}> {
  const { data: channels, error: chErr } = await supabase
    .from('telegram_channels')
    .select('id,display_name,user_id')
    .ilike('display_name', GTMO_CHANNEL_PATTERN)

  if (chErr) throw chErr
  const channelRows = (channels ?? []).filter(row => {
    if (!userId) return true
    return String(row.user_id) === userId
  })
  if (!channelRows.length) {
    throw new Error(
      userId
        ? `No GTMO VIP channel for USER_ID=${userId}`
        : 'No telegram_channels row matching "GTMO VIP"',
    )
  }

  const channelIds = channelRows.map(c => c.id)
  const channelNameById = new Map(channelRows.map(c => [c.id, String(c.display_name ?? 'GTMO VIP')]))

  let signalsQ = supabase
    .from('signals')
    .select('id,user_id,created_at,channel_id,parsed_data')
    .in('channel_id', channelIds)
    .order('created_at', { ascending: false })
    .limit(50)

  if (userId) signalsQ = signalsQ.eq('user_id', userId)

  const { data: recentSignals, error: sigErr } = await signalsQ
  if (sigErr) throw sigErr
  if (!recentSignals?.length) {
    throw new Error('No signals on GTMO VIP channel')
  }

  const signalIds = recentSignals.map(s => s.id)
  const { data: openTrades, error: trErr } = await supabase
    .from('trades')
    .select('signal_id')
    .eq('status', 'open')
    .in('signal_id', signalIds)

  if (trErr) throw trErr

  const legCountBySignal = new Map<string, number>()
  for (const row of openTrades ?? []) {
    const sid = String(row.signal_id ?? '')
    if (!sid) continue
    legCountBySignal.set(sid, (legCountBySignal.get(sid) ?? 0) + 1)
  }

  for (const sig of recentSignals) {
    const openLegs = legCountBySignal.get(sig.id) ?? 0
    if (openLegs > 0) {
      return {
        signalId: sig.id,
        userId: sig.user_id,
        displayName: channelNameById.get(sig.channel_id) ?? 'GTMO VIP',
        createdAt: sig.created_at,
        openLegs,
      }
    }
  }

  for (const sig of recentSignals) {
    const action = String((sig.parsed_data as { action?: string } | null)?.action ?? '').toLowerCase()
    if (action === 'buy' || action === 'sell') {
      return {
        signalId: sig.id,
        userId: sig.user_id,
        displayName: channelNameById.get(sig.channel_id) ?? 'GTMO VIP',
        createdAt: sig.created_at,
        openLegs: 0,
      }
    }
  }

  throw new Error('No GTMO VIP entry signal found — set SIGNAL_ID on push-signal-stops instead')
}

/** Distinct copier users with open legs on a GTMO VIP basket anchor signal. */
export async function resolveGtmoVipUserIds(): Promise<string[]> {
  const { data: channels, error: chErr } = await supabase
    .from('telegram_channels')
    .select('id')
    .ilike('display_name', GTMO_CHANNEL_PATTERN)
  if (chErr) throw chErr
  const channelIds = (channels ?? []).map(c => c.id).filter(Boolean)
  if (!channelIds.length) return []

  const { data: signals, error: sigErr } = await supabase
    .from('signals')
    .select('id,user_id')
    .in('channel_id', channelIds)
    .order('created_at', { ascending: false })
    .limit(200)
  if (sigErr) throw sigErr
  const signalIds = (signals ?? []).map(s => s.id)
  if (!signalIds.length) return []

  const { data: trades, error: trErr } = await supabase
    .from('trades')
    .select('signal_id,user_id')
    .eq('status', 'open')
    .in('signal_id', signalIds)
  if (trErr) throw trErr

  const signalUser = new Map((signals ?? []).map(s => [s.id, s.user_id]))
  const users = new Set<string>()
  for (const row of trades ?? []) {
    const uid = String(row.user_id ?? signalUser.get(row.signal_id) ?? '')
    if (uid) users.add(uid)
  }
  return [...users]
}

async function pushGtmoVipSlForUser(args: {
  userId?: string
  dryRun: boolean
  slOverride: number
  fxsocketOnly: boolean
}): Promise<void> {
  const anchor = await resolveGtmoVipAnchorSignalId(args.userId)
  console.log(
    `GTMO VIP anchor signal ${anchor.signalId}`
    + ` (${anchor.displayName}, user=${anchor.userId})`
    + ` created=${anchor.createdAt} open_legs=${anchor.openLegs}`,
  )
  console.log(
    `Pushing SL_ONLY → ${args.slOverride}`
    + `${args.fxsocketOnly ? '  [FxSocket-only brokers]' : ''}`
    + `  dryRun=${args.dryRun}\n`,
  )

  await runPushSignalStops({
    signalId: anchor.signalId,
    dryRun: args.dryRun,
    slOnly: true,
    slOverride: args.slOverride,
    slFrom: 'signal',
    tradeScope: 'signal',
    allChannels: true,
    fxsocketOnly: args.fxsocketOnly,
  })
}

function numEnv(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? '').trim()
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`)
  return n
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')
  }

  const userId = String(process.env.USER_ID ?? '').trim() || undefined
  const allGtmoUsers = String(process.env.ALL_GTMO_USERS ?? '').toLowerCase() === 'true'
  const dryRun = String(process.env.DRY_RUN ?? '').toLowerCase() === 'true'
  const fxsocketOnly = String(process.env.FXSOCKET_ONLY ?? '').toLowerCase() === 'true'
  const slOverride = numEnv('SL_OVERRIDE', 4261)

  if (allGtmoUsers && userId) {
    throw new Error('Use either USER_ID or ALL_GTMO_USERS=true, not both')
  }

  if (allGtmoUsers) {
    const userIds = await resolveGtmoVipUserIds()
    if (!userIds.length) throw new Error('No GTMO VIP subscribers with open legs')
    console.log(`ALL_GTMO_USERS: ${userIds.length} subscriber(s)\n`)
    for (const uid of userIds) {
      console.log(`\n========== user ${uid} ==========\n`)
      await pushGtmoVipSlForUser({ userId: uid, dryRun, slOverride, fxsocketOnly })
    }
    return
  }

  await pushGtmoVipSlForUser({ userId, dryRun, slOverride, fxsocketOnly })
}

if (require.main === module) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
