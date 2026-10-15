import type { SupabaseClient } from '@supabase/supabase-js'
import {
  brokerRuntimeForAccount,
  loadBrokerApiByAccountId,
} from './mtApiByAccount'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  shardUserIds,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { rawOrderTicket } from './signalEntryPendingHelpers'
import {
  applyBrokerDriftRepairs,
  GhostObservation,
  planBrokerDrift,
  type DriftRow,
  type LiveTicketHit,
} from './tradeBrokerDrift'

/**
 * Slow, reverse-direction sweep: broker reality → our `trades` rows.
 *
 * Runs on its own cadence (not the 30s forward reconcile) because it probes
 * every account of every shard user, including the ones the forward loop never
 * visits — an account whose rows are all closed while the broker still holds
 * positions is invisible to a loop keyed on open rows, which is exactly how
 * five live positions went unmanaged on 2026-10-04.
 *
 * Two properties keep it safe (see `tradeBrokerDrift.ts` for the full rules):
 * probes are read-only and cover **paused accounts too** (a position parked on
 * a paused account must still be seen, or its row would be condemned), and any
 * answer we cannot trust — empty, unparseable, or an errored query — makes the
 * whole tick untrusted and clears the two-pass ghost memory.
 *
 * Note on the wake channel: the monitor work-wake pokes this loop on every
 * trades/signals write, so ticks can arrive seconds apart. Ghost confirmation
 * therefore enforces its own minimum gap (MIN_GHOST_GAP_MS) inside
 * `GhostObservation` rather than relying on the schedule.
 */
const ACTIVE_MS = monitorActiveIntervalMs('BROKER_DRIFT_TICK_MS', 300_000)
const IDLE_MS = monitorIdleIntervalMs('BROKER_DRIFT_IDLE_MS', 900_000)
const ACCOUNT_LIMIT = 500
const ROW_LIMIT = 1_000

type AccountProbe = { id: string; user_id: string | null }

const ROW_COLUMNS = 'id,user_id,broker_account_id,metaapi_order_id,broker_position_ticket,status,signal_id'

function isFilledPosition(order: Record<string, unknown>): boolean {
  const state = String(order.state ?? '').toUpperCase()
  if (state === 'FILLED' || state === 'OPEN_NORMAL') return true
  if (state === 'PLACED') return false
  const type = String(order.orderType ?? order.type ?? '').toUpperCase()
  if (!type) return true
  return !/STOP|LIMIT/.test(type)
}

export class TradeBrokerDriftMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private ghosts = new GhostObservation()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    this.loop = startMonitorLoop({
      name: 'tradeBrokerDriftMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      // The sweeps main job is rows the broker still holds while our table says
      // closed — a state that can have NO open/pending rows at all. Gating on
      // those alone starved exactly the case it exists for, so any shard user
      // with a broker account counts as work too.
      hasWork: async sb => {
        if (await hasWorkOnShard(sb, 'trades', q => q.in('status', ['open', 'pending']))) return true
        const uids = await shardUserIds(sb)
        if (uids === null) return true
        if (uids.length === 0) return false
        const { data } = await sb
          .from('broker_accounts')
          .select('id')
          .in('user_id', uids)
          .limit(1)
        return Boolean(data?.length)
      },
      tick: () => this.runTick(),
    })
    console.log(`[tradeBrokerDriftMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[tradeBrokerDriftMonitor] tick failed: ${msg}`)
      // An untrusted tick must not carry ghost memory into the next one.
      this.ghosts.reset()
    } finally {
      this.ticking = false
    }
  }

  private async tick(): Promise<void> {
    const accountsBase = this.supabase
      .from('broker_accounts')
      .select('id,user_id')
      .not('user_id', 'is', null)
      .order('id')
      .limit(ACCOUNT_LIMIT)
    const shardAccounts = await applyShardToQuery(this.supabase, accountsBase)
    if (!shardAccounts) {
      this.ghosts.reset()
      return
    }
    const { data: accounts, error: accountErr } = await shardAccounts
    if (accountErr) {
      console.warn(`[tradeBrokerDriftMonitor] account load failed: ${accountErr.message}`)
      this.ghosts.reset()
      return
    }
    // Every account of every user — paused ones included. Probing is read-only
    // and never resumes copying; skipping them would condemn rows whose
    // position lives on an account we refused to look at.
    const probes = (accounts ?? []) as AccountProbe[]
    if (!probes.length) {
      this.ghosts.reset()
      return
    }

    const runtimeByBroker = await loadBrokerApiByAccountId(this.supabase, probes.map(p => p.id))
    const accountsByUser = new Map<string, number>()
    for (const probe of probes) {
      const userId = String(probe.user_id ?? '')
      if (!userId) continue
      accountsByUser.set(userId, (accountsByUser.get(userId) ?? 0) + 1)
    }
    const probedOkByUser = new Map<string, number>()

    const live: LiveTicketHit[] = []
    for (const probe of probes) {
      const userId = String(probe.user_id ?? '')
      const runtime = brokerRuntimeForAccount(runtimeByBroker, probe.id)
      if (!runtime || !userId) continue
      let orders: unknown
      try {
        orders = await runtime.api.openedOrders(runtime.sessionId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[tradeBrokerDriftMonitor] OpenedOrders failed broker=${probe.id}: ${msg}`)
        continue
      }
      if (!Array.isArray(orders) || orders.length === 0) {
        // An empty answer is not automatically "no evidence": a flat account
        // answers empty and is perfectly healthy. Ask the session, and when it
        // answers, count the account as probed so the two-pass ghost rule can
        // finally conclude the rows left behind (the last trade on an account
        // can never be reconciled otherwise — closing it is what empties the
        // account).
        try {
          await runtime.api.checkConnect(runtime.sessionId)
          probedOkByUser.set(userId, (probedOkByUser.get(userId) ?? 0) + 1)
        } catch {
          // disconnected: no evidence, as before
        }
        continue
      }
      let parsed = 0
      for (const raw of orders) {
        const order = raw as Record<string, unknown>
        const ticket = rawOrderTicket(order)
        if (!ticket) continue
        parsed += 1
        live.push({
          ticket,
          filled: isFilledPosition(order),
          brokerAccountId: probe.id,
          userId,
        })
      }
      if (parsed === 0) {
        // Non-empty but nothing we can read: the shape is not what this sweep
        // understands, so the probe proves nothing either way.
        console.warn(
          `[tradeBrokerDriftMonitor] unparseable OpenedOrders broker=${probe.id}`
          + ` count=${orders.length} — treating probe as untrusted`,
        )
        continue
      }
      probedOkByUser.set(userId, (probedOkByUser.get(userId) ?? 0) + 1)
    }

    // A user may only produce ghost conclusions when every one of their
    // accounts answered with positions — otherwise "absent" may just mean
    // "we could not look". Limitation: a genuinely flat account looks the
    // same as a disconnected one, so such a user's ghosts stay paused.
    const fullyProbedUsers = new Set<string>()
    for (const [userId, total] of accountsByUser) {
      if (total > 0 && (probedOkByUser.get(userId) ?? 0) >= total) fullyProbedUsers.add(userId)
    }
    const probedUserIds = [...accountsByUser.keys()]

    const rowsById = new Map<string, DriftRow>()
    const liveTickets = [...new Set(live.map(hit => String(hit.ticket)))]

    if (liveTickets.length) {
      const byTicketBase = this.supabase
        .from('trades')
        .select(ROW_COLUMNS)
        .or(`metaapi_order_id.in.(${liveTickets.join(',')}),broker_position_ticket.in.(${liveTickets.join(',')})`)
        .in('user_id', probedUserIds)
        .order('id')
        .limit(ROW_LIMIT)
      const shardByTicket = await applyShardToQuery(this.supabase, byTicketBase)
      if (shardByTicket) {
        const { data, error } = await shardByTicket
        if (error) {
          console.warn(`[tradeBrokerDriftMonitor] ticket row load failed: ${error.message}`)
          this.ghosts.reset()
          return
        }
        for (const row of (data ?? []) as DriftRow[]) rowsById.set(row.id, row)
      }
    }

    const openPendingBase = this.supabase
      .from('trades')
      .select(ROW_COLUMNS)
      .in('status', ['open', 'pending'])
      .in('user_id', probedUserIds)
      .order('id')
      .limit(ROW_LIMIT)
    const shardOpenPending = await applyShardToQuery(this.supabase, openPendingBase)
    if (!shardOpenPending) {
      this.ghosts.reset()
      return
    }
    const { data: openPending, error: openPendingErr } = await shardOpenPending
    if (openPendingErr) {
      console.warn(`[tradeBrokerDriftMonitor] open/pending row load failed: ${openPendingErr.message}`)
      this.ghosts.reset()
      return
    }
    // Open/pending rows everywhere, including the ones no per-account loop can
    // reach because their account link is null.
    for (const row of (openPending ?? []) as DriftRow[]) rowsById.set(row.id, row)

    const plan = planBrokerDrift({
      rows: [...rowsById.values()],
      live,
      fullyProbedUsers,
    })
    const confirmedIds = new Set(
      this.ghosts.confirm(plan.missingOnce.map(row => row.id)),
    )
    const confirmedRows = plan.missingOnce.filter(row => confirmedIds.has(row.id))
    const applied = await applyBrokerDriftRepairs(this.supabase, plan, confirmedRows)

    if (applied.reopened || applied.attached || applied.closed || plan.unknown.length) {
      console.log(
        `[tradeBrokerDriftMonitor] tick reopened=${applied.reopened} attached=${applied.attached}`
        + ` closed=${applied.closed} unknown=${plan.unknown.length}`
        + ` missing_once=${plan.missingOnce.length} awaiting_gap=${confirmedIds.size === 0 ? plan.missingOnce.length : 0}`,
      )
    }
  }
}
