import type { SupabaseClient } from '@supabase/supabase-js'
import { TRADE_CLOSE_REASON } from './tradeCloseReasons'
import { applyCloseUpdate } from './tradeCloseUpdate'
import { captureBusinessIssue } from './observability/businessEvents'
import { purgeRangePendingLegsForBaskets } from './rangePendingLegDelete'

/**
 * Reverse-direction drift between broker reality and our `trades` rows, plus
 * the two row classes the forward loop (`openTradeReconcile`) can never reach.
 *
 * The forward path closes rows the broker stops reporting. This module does
 * the opposite, and covers what the forward path structurally cannot see:
 *
 *  - a position that is still live while our row says `closed` → reopen it
 *  - a live ticket whose row has no broker account link         → attach it
 *  - a live ticket with no row at all                           → report it
 *  - an open/pending row whose ticket is on none of the user's accounts —
 *    including rows no per-account loop can reach (link is null) → close it,
 *    but only after it is missing on two passes at least `MIN_GHOST_GAP_MS`
 *    apart
 *
 * Safety rules, learned from the false-close of 2026-10-04 (five live
 * positions marked closed while a freshly restarted terminal was still
 * loading them):
 *
 *  - acting on a ticket we **can** see (reopen, attach, unknown report) is
 *    safe even from an incomplete view — an incomplete view cannot invent a
 *    live position;
 *  - acting on a ticket we **cannot** see (ghost close) is not, so it needs a
 *    fully-probed user, the row's own account (or every account, when the row
 *    has no link) to have answered, and the same row missing on two passes
 *    separated by at least `MIN_GHOST_GAP_MS` — a warm-up snapshot cannot
 *    survive a four-minute gap;
 *  - a row is only ever compared against the account it belongs to, so a
 *    ticket number that happens to exist on another account of the same user
 *    can neither resurrect nor condemn it.
 *
 * Known limitation: a user only counts as fully probed when *every* one of
 * their accounts returned a non-empty snapshot, so a flat account (which looks
 * identical to a disconnect) keeps that user's ghost closing paused. Safe
 * direction — it withholds closes, never invents them.
 */

/** Minimum spacing between the two passes that allow a ghost close. */
export const MIN_GHOST_GAP_MS = 4 * 60_000

/** How often one unmanaged live position may be reported. */
const UNKNOWN_REPORT_INTERVAL_MS = 30 * 60_000

export type DriftRow = {
  id: string
  user_id?: string | null
  broker_account_id?: string | null
  metaapi_order_id?: string | null
  broker_position_ticket?: string | null
  status: string
  signal_id?: string | null
}

export type LiveTicket = {
  ticket: number
  /** Position (filled) versus a resting order (pending/stop/limit). */
  filled: boolean
}

export type LiveTicketHit = LiveTicket & { brokerAccountId: string; userId: string }

export type DriftPlan = {
  /** Ticket is live on the row's own account and our row says closed. */
  reopen: Array<{ row: DriftRow; status: 'open' | 'pending'; brokerAccountId: string }>
  /** Ticket is live on an account but the row never got the link. */
  attach: Array<{ row: DriftRow; brokerAccountId: string }>
  /** Live at the broker, no row for this user — needs a human. */
  unknown: Array<{ userId: string; ticket: number }>
  /** Row open/pending, ticket not live on the account it belongs to. */
  missingOnce: DriftRow[]
}

function ticketOf(row: DriftRow): number | null {
  const ticket = Number(row.broker_position_ticket ?? row.metaapi_order_id)
  return Number.isFinite(ticket) && ticket > 0 ? ticket : null
}

type UserIndex = {
  /** accountId → ticket → hit */
  accounts: Map<string, Map<number, LiveTicketHit>>
  /** ticket → every account of this user that holds it */
  ticketAccounts: Map<number, Set<string>>
  /** every live ticket of this user, across accounts */
  tickets: Set<number>
}

function buildUserIndex(live: readonly LiveTicketHit[]): Map<string, UserIndex> {
  const byUser = new Map<string, UserIndex>()
  for (const hit of live) {
    let index = byUser.get(hit.userId)
    if (!index) {
      index = { accounts: new Map(), ticketAccounts: new Map(), tickets: new Set() }
      byUser.set(hit.userId, index)
    }
    let byTicket = index.accounts.get(hit.brokerAccountId)
    if (!byTicket) {
      byTicket = new Map()
      index.accounts.set(hit.brokerAccountId, byTicket)
    }
    byTicket.set(hit.ticket, hit)
    let accounts = index.ticketAccounts.get(hit.ticket)
    if (!accounts) {
      accounts = new Set()
      index.ticketAccounts.set(hit.ticket, accounts)
    }
    accounts.add(hit.brokerAccountId)
    index.tickets.add(hit.ticket)
  }
  return byUser
}

/**
 * Decide what to repair from one probe of a user's accounts.
 *
 * `rows` are the candidate rows for those users (matched by live ticket, plus
 * the open/pending rows that may be ghosts). `live` is every ticket the probe
 * actually saw, and `fullyProbedUsers` lists users where every account
 * returned a usable, non-empty snapshot — only those users may produce
 * `missingOnce`.
 */
export function planBrokerDrift(args: {
  rows: DriftRow[]
  live: LiveTicketHit[]
  fullyProbedUsers: ReadonlySet<string>
}): DriftPlan {
  const plan: DriftPlan = { reopen: [], attach: [], unknown: [], missingOnce: [] }
  const liveByUser = buildUserIndex(args.live)

  const rowsByUser = new Map<string, DriftRow[]>()
  for (const row of args.rows) {
    const userId = String(row.user_id ?? '')
    if (!userId) continue // rows without an owner cannot be reasoned about here
    const list = rowsByUser.get(userId) ?? []
    list.push(row)
    rowsByUser.set(userId, list)
  }

  // Users come from both sides: a live ticket with no row must still be
  // reported, and that user may have no rows at all.
  const userIds = new Set([...liveByUser.keys(), ...rowsByUser.keys()])

  for (const userId of userIds) {
    const rows = rowsByUser.get(userId) ?? []
    const index = liveByUser.get(userId)

    if (index) {
      const knownTickets = new Set<number>()
      for (const row of rows) {
        const ticket = ticketOf(row)
        if (ticket !== null) knownTickets.add(ticket)
      }
      for (const ticket of index.tickets) {
        if (!knownTickets.has(ticket)) plan.unknown.push({ userId, ticket })
      }
    }

    for (const row of rows) {
      const ticket = ticketOf(row)
      // A row we cannot verify at the broker is never closed by this path.
      if (ticket === null) continue

      let hit: LiveTicketHit | undefined
      let ambiguous = false
      if (index) {
        if (row.broker_account_id) {
          // Only the row's own account counts: the same ticket number on a
          // different account says nothing about this row.
          hit = index.accounts.get(row.broker_account_id)?.get(ticket)
        } else {
          const accounts = index.ticketAccounts.get(ticket)
          if (accounts && accounts.size === 1) {
            const only = [...accounts][0]!
            hit = index.accounts.get(only)?.get(ticket)
          } else if (accounts && accounts.size > 1) {
            ambiguous = true
          }
        }
      }

      if (hit) {
        if (row.status === 'closed') {
          plan.reopen.push({ row, status: hit.filled ? 'open' : 'pending', brokerAccountId: hit.brokerAccountId })
        }
        if (!row.broker_account_id) {
          plan.attach.push({ row, brokerAccountId: hit.brokerAccountId })
        }
        continue
      }
      // Live somewhere on this user, but not attributable to this row: leave
      // it alone rather than guessing in either direction.
      if (ambiguous) continue

      // Not live on the row's account. Conclusions only from a complete probe.
      if (!args.fullyProbedUsers.has(userId)) continue
      if (row.status !== 'open' && row.status !== 'pending') continue
      plan.missingOnce.push(row)
    }
  }

  return plan
}

/**
 * Two-pass memory for ghost rows: an id must be missing on this pass and on a
 * pass at least `minGapMs` earlier before the caller may close it. A row that
 * reappears clears its entry; a confirmation attempt that is still inside the
 * gap keeps the original timestamp so the gap is never shortened by wake-up
 * pokes from the monitor work-wake channel.
 */
export class GhostObservation {
  private previous = new Map<string, number>()

  confirm(
    missingIds: readonly string[],
    now: number = Date.now(),
    minGapMs: number = MIN_GHOST_GAP_MS,
  ): string[] {
    const confirmed: string[] = []
    const current = new Set(missingIds)
    for (const id of missingIds) {
      const firstSeen = this.previous.get(id)
      if (firstSeen !== undefined && now - firstSeen >= minGapMs) confirmed.push(id)
    }
    for (const id of [...this.previous.keys()]) {
      if (!current.has(id)) this.previous.delete(id)
    }
    for (const id of missingIds) {
      if (!this.previous.has(id)) this.previous.set(id, now)
    }
    return confirmed
  }

  /** Forget everything (used when a tick could not be trusted). */
  reset(): void {
    this.previous.clear()
  }
}

function issue(args: {
  event: string
  reasonCode: string
  message: string
  brokerAccountId?: string | null
  extra?: Record<string, unknown>
}): void {
  captureBusinessIssue({
    category: 'reconciliation',
    event: args.event,
    severity: 'warning',
    reasonCode: args.reasonCode,
    message: args.message,
    userImpact: 'manual_review_required',
    fingerprint: ['broker_drift', args.reasonCode],
    context: {
      broker_account_id: args.brokerAccountId ?? null,
      stage: 'broker_drift',
      operation: 'broker_drift',
      extra: args.extra ?? {},
    },
  })
}

// One report per position per interval: `manual_review_required` events are
// exempt from the global cooldown, so a sweep that runs every few minutes
// would otherwise re-fire on every tick.
const unknownReportedAt = new Map<string, number>()

function shouldReportUnknown(userId: string, ticket: number, now: number): boolean {
  const key = `${userId}|${ticket}`
  const last = unknownReportedAt.get(key)
  if (last !== undefined && now - last < UNKNOWN_REPORT_INTERVAL_MS) return false
  unknownReportedAt.set(key, now)
  if (unknownReportedAt.size > 2_000) {
    for (const [k, at] of unknownReportedAt) {
      if (now - at > UNKNOWN_REPORT_INTERVAL_MS) unknownReportedAt.delete(k)
    }
  }
  return true
}

/**
 * Write the repairs. Every update carries the guard it depends on, so a row
 * that changed between plan and apply is skipped instead of overwritten, and
 * every count is what the database actually changed — not what we asked for.
 */
export async function applyBrokerDriftRepairs(
  supabase: SupabaseClient,
  plan: DriftPlan,
  ghostRows: readonly DriftRow[],
): Promise<{ reopened: number; attached: number; closed: number }> {
  let reopened = 0
  let attached = 0
  let closed = 0

  for (const { row, status, brokerAccountId } of plan.reopen) {
    const { data, error } = await supabase
      .from('trades')
      .update({ status, closed_at: null, close_price: null })
      .eq('id', row.id)
      .eq('status', 'closed')
      .select('id')
    if (error) {
      console.warn(`[tradeBrokerDrift] reopen failed trade=${row.id}: ${error.message}`)
      continue
    }
    if (!data?.length) continue
    reopened += data.length
    console.warn(
      `[tradeBrokerDrift] reopened trade=${row.id} ticket=${row.metaapi_order_id}`
      + ` broker=${row.broker_account_id ?? brokerAccountId} status=${status}`
      + ` (live at broker, row said closed)`,
    )
  }

  for (const { row, brokerAccountId } of plan.attach) {
    const { data, error } = await supabase
      .from('trades')
      .update({ broker_account_id: brokerAccountId })
      .eq('id', row.id)
      .is('broker_account_id', null)
      .select('id')
    if (error) {
      console.warn(`[tradeBrokerDrift] attach failed trade=${row.id}: ${error.message}`)
      continue
    }
    if (!data?.length) continue
    attached += data.length
    console.warn(
      `[tradeBrokerDrift] attached trade=${row.id} ticket=${row.metaapi_order_id}`
      + ` to broker=${brokerAccountId} (position is live, row had no account link)`,
    )
  }

  const now = Date.now()
  for (const { userId, ticket } of plan.unknown) {
    if (!shouldReportUnknown(userId, ticket, now)) continue
    console.warn(`[tradeBrokerDrift] live position has no trade row user=${userId} ticket=${ticket}`)
    issue({
      event: 'unmanaged_live_position',
      reasonCode: 'DRIFT_LIVE_POSITION_NO_TRADE',
      message: 'Broker holds a live position with no trade row for this user',
      extra: { user_id: userId, ticket },
    })
  }

  const ghostIds = ghostRows.map(row => row.id)
  if (ghostIds.length) {
    const { data, error } = await applyCloseUpdate(
      {
        status: 'closed',
        closed_at: new Date().toISOString(),
        close_reason: TRADE_CLOSE_REASON.POSITION_GONE,
      },
      patch => supabase
        .from('trades')
        .update(patch)
        .in('id', ghostIds)
        .in('status', ['open', 'pending'])
        .select('id'),
    )
    if (error) {
      console.warn(`[tradeBrokerDrift] ghost close failed: ${error.message}`)
      return { reopened, attached, closed }
    }
    const closedIds = new Set((data ?? []).map(row => String(row.id)))
    closed = closedIds.size
    if (closed > 0) {
      console.warn(
        `[tradeBrokerDrift] closed ${closed} ghost row(s) not held on any of the user's accounts`
        + ` ids=${[...closedIds].join(',')}`,
      )
      // Closed rows can leave live range-pending legs behind; those legs would
      // fire later and insert new trades for a basket we now consider flat.
      const scopes = ghostRows
        .filter(row => closedIds.has(String(row.id)) && row.signal_id && row.broker_account_id)
        .map(row => ({ signalId: String(row.signal_id), brokerAccountId: String(row.broker_account_id) }))
      if (scopes.length) {
        await purgeRangePendingLegsForBaskets(supabase, scopes, 'basket_flat_reconcile')
      }
    }
  }

  return { reopened, attached, closed }
}
