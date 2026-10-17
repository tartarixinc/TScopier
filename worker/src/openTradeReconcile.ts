/**
 * Reconcile DB `trades.status = 'open'` against live broker positions.
 * Closes rows whose ticket no longer appears in /OpenedOrders (TP/SL/manual close).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FxsocketBrokerClient } from './fxsocketClient'
import { closeStaleOpenTrades } from './basketSlTpReconcile'
import { persistCanonicalPositionTicket, resolveCanonicalOpenPosition, snapshotLogins } from './livePositionIdentity'
import { historyTicketCloseMatch, matchClosedHistory } from './openTradeClassification'
import { captureBusinessIssue } from './observability/businessEvents'
import { purgeRangePendingLegsForBaskets, type BasketScope } from './rangePendingLegDelete'

/** How far back to look for a close record when corroborating a ghost close. */
const historyDaysRaw = Number(process.env.OPEN_TRADE_RECONCILE_HISTORY_DAYS ?? 30)
const HISTORY_DAYS = Math.max(1, Number.isFinite(historyDaysRaw) ? historyDaysRaw : 30)

/** Minimum gap between `ABSENT_UNCONFIRMED_BY_HISTORY` events per account. */
const absentAlertCooldownRaw = Number(process.env.OPEN_TRADE_RECONCILE_ALERT_COOLDOWN_MS ?? 30 * 60_000)
const ABSENT_ALERT_COOLDOWN_MS = Math.max(
  60_000,
  Number.isFinite(absentAlertCooldownRaw) ? absentAlertCooldownRaw : 30 * 60_000,
)
const absentAlertLastAt = new Map<string, number>()

/**
 * Corroborate a ghost close with a positive close record. Default on; set
 * `OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY=false` to restore the old
 * absence-only behaviour (not recommended — it can mass-close on a false-empty
 * snapshot from a live session).
 */
function requireClosedHistory(): boolean {
  return process.env.OPEN_TRADE_RECONCILE_REQUIRE_CLOSED_HISTORY !== 'false'
}

function mtDate(d: Date): string {
  return d.toISOString().slice(0, 19)
}

/** Minimum gap between `HISTORY_LOAD_FAILED` events per account. */
const historyLoadAlertCooldownRaw = Number(process.env.OPEN_TRADE_RECONCILE_ALERT_COOLDOWN_MS ?? 30 * 60_000)
const HISTORY_LOAD_ALERT_COOLDOWN_MS = Math.max(
  60_000,
  Number.isFinite(historyLoadAlertCooldownRaw) ? historyLoadAlertCooldownRaw : 30 * 60_000,
)
const historyLoadAlertLastAt = new Map<string, number>()

/** Newest-page cap / page size for the paginated fallback after a failed bulk pull. */
const historyMaxPagesRaw = Number(process.env.OPEN_TRADE_RECONCILE_HISTORY_MAX_PAGES)
const HISTORY_MAX_PAGES = Number.isFinite(historyMaxPagesRaw) && historyMaxPagesRaw > 0
  ? Math.min(10, Math.max(1, Math.floor(historyMaxPagesRaw)))
  : 2
const historyPageSizeRaw = Number(process.env.OPEN_TRADE_RECONCILE_HISTORY_PAGE_SIZE)
const HISTORY_PAGE_SIZE = Number.isFinite(historyPageSizeRaw) && historyPageSizeRaw > 0
  ? Math.min(2000, Math.max(50, Math.floor(historyPageSizeRaw)))
  : 500

/**
 * Narrow the history window to the trades we actually need proof for: a ghost
 * opened today should not pull 30 days of closes (the bulk pull is what
 * intermittently times out on the bridge). One day of margin covers timezone
 * and clock skew; clamped to the configured HISTORY_DAYS floor so a long-stuck
 * row still reaches its close record.
 */
function historyFromForTrades(trades: OpenTradeReconcileRow[]): Date | null {
  let minOpenedMs = Infinity
  for (const trade of trades) {
    // Any row without a usable opened_at would silently widen the min past its
    // possible close record; fall back to the full configured lookback instead
    // (fail-safe: the pull is bigger, never smaller).
    if (!trade.opened_at) return null
    const openedMs = Date.parse(trade.opened_at)
    if (!Number.isFinite(openedMs)) return null
    if (openedMs < minOpenedMs) minOpenedMs = openedMs
  }
  if (!Number.isFinite(minOpenedMs)) return null
  const derived = new Date(minOpenedMs - 86_400_000)
  const floor = new Date(Date.now() - HISTORY_DAYS * 86_400_000)
  return derived > floor ? derived : floor
}

/**
 * Newest-N-pages fallback for a failed bulk history pull: probe page 0 to learn
 * the page count, then fetch only the last HISTORY_MAX_PAGES pages (the bridge
 * paginates ascending, so the newest closes live at the end — the probe page's
 * own rows are the oldest and are discarded when they fall outside the range).
 * Mirrors `closedOrdersHistoryLite`. Close proof is per-ticket and recent, so
 * the newest pages are where it lives; anything older defers exactly as a
 * missing record does today.
 */
async function loadClosedHistoryPaged(
  api: FxsocketBrokerClient,
  accountId: string,
  from: string,
  to: string,
): Promise<unknown[]> {
  const first = await api.orderHistoryPage(accountId, from, to, 0, HISTORY_PAGE_SIZE)
  const start = Math.max(0, first.pagesCount - HISTORY_MAX_PAGES)
  const orders: unknown[] = []
  for (let page = start; page < first.pagesCount; page += 1) {
    const current = page === 0
      ? first
      : await api.orderHistoryPage(accountId, from, to, page, HISTORY_PAGE_SIZE)
    orders.push(...current.orders)
  }
  return orders
}

async function loadClosedHistory(
  api: FxsocketBrokerClient,
  accountId: string,
  forTrades?: OpenTradeReconcileRow[],
): Promise<unknown[]> {
  const to = mtDate(new Date())
  const derivedFrom = forTrades ? historyFromForTrades(forTrades) : null
  const from = derivedFrom ? mtDate(derivedFrom) : mtDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000))
  try {
    return (await api.orderHistory(accountId, from, to)) ?? []
  } catch (bulkErr) {
    const bulkMsg = bulkErr instanceof Error ? bulkErr.message : String(bulkErr)
    console.warn(
      `[openTradeReconcile] closed-history bulk load failed account=${accountId}: ${bulkMsg}`
      + ' — retrying with paginated reads',
    )
    try {
      const paged = await loadClosedHistoryPaged(api, accountId, from, to)
      console.warn(
        `[openTradeReconcile] closed-history paged load ok account=${accountId} rows=${paged.length}`
        + ` maxPages=${HISTORY_MAX_PAGES} pageSize=${HISTORY_PAGE_SIZE}`,
      )
      return paged
    } catch (pagedErr) {
      const pagedMsg = pagedErr instanceof Error ? pagedErr.message : String(pagedErr)
      console.warn(
        `[openTradeReconcile] closed-history load failed account=${accountId}`
        + ` (bulk: ${bulkMsg}; paged: ${pagedMsg})`,
      )
      // Without a distinct signal this failure is invisible until it shows up as
      // downstream ABSENT/GHOST_UNCONFIRMED bursts — which is exactly how the
      // 2026-10-14 "OrderHistory timed out" incident hid from Sentry.
      if (Date.now() - (historyLoadAlertLastAt.get(accountId) ?? 0) >= HISTORY_LOAD_ALERT_COOLDOWN_MS) {
        historyLoadAlertLastAt.set(accountId, Date.now())
        captureBusinessIssue({
          category: 'reconciliation',
          event: 'reconciliation_failed',
          severity: 'warning',
          reasonCode: 'HISTORY_LOAD_FAILED',
          message: 'Closed-history load failed while corroborating ghost closes',
          userImpact: 'delayed',
          fingerprint: ['reconciliation_failed', 'open_trade_reconcile', 'HISTORY_LOAD_FAILED'],
          // Per-account dedupe so businessEvents' global cooldown cannot swallow
          // one account's first failure because another account failed first.
          dedupeKey: accountId,
          context: {
            broker_account_id: accountId,
            stage: 'open_trade_reconcile',
            operation: 'load_closed_history',
            extra: {
              history_from: from,
              history_to: to,
              bulk_error: bulkMsg.slice(0, 120),
              paged_error: pagedMsg.slice(0, 120),
            },
          },
        })
      }
      return []
    }
  }
}

export type OpenTradeReconcileRow = {
  id: string
  signal_id?: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  broker_position_ticket?: string | null
  symbol?: string | null
  direction?: string | null
  lot_size?: number | null
  entry_price?: number | null
  opened_at?: string | null
}

/** A session probe may only authorise a close when it resolves. */
async function sessionIsHealthy(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe()
    return true
  } catch {
    return false
  }
}

/** Open DB legs whose ticket is valid but absent from the broker snapshot. */
export function findGhostOpenTradeIds(
  openTrades: OpenTradeReconcileRow[],
  brokerTickets: Set<number>,
): string[] {
  const ghostIds: string[] = []
  for (const trade of openTrades) {
    const ticket = Number(trade.broker_position_ticket ?? trade.metaapi_order_id)
    if (!Number.isFinite(ticket) || ticket <= 0) continue
    if (!brokerTickets.has(ticket)) ghostIds.push(trade.id)
  }
  return ghostIds
}

function basketScopesForGhosts(openTrades: OpenTradeReconcileRow[], ghostIds: string[]): BasketScope[] {
  const ghostSet = new Set(ghostIds)
  const scopes = new Map<string, BasketScope>()
  for (const trade of openTrades) {
    if (!ghostSet.has(trade.id)) continue
    const signalId = trade.signal_id
    const brokerAccountId = trade.broker_account_id
    if (!signalId || !brokerAccountId) continue
    scopes.set(`${signalId}|${brokerAccountId}`, { signalId, brokerAccountId })
  }
  return [...scopes.values()]
}

export async function reconcileOpenTradesForBroker(
  supabase: SupabaseClient,
  api: FxsocketBrokerClient,
  metaapiAccountId: string,
  openTrades: OpenTradeReconcileRow[],
  probeHealthy?: () => Promise<unknown>,
  provider: string = 'fxsocket',
  expectedLogin?: string | null,
): Promise<number> {
  if (!openTrades.length) return 0
  const firstSnapshot = await api.openedOrders(metaapiAccountId)
  // SAFETY: an empty (but successful) OpenedOrders snapshot usually means the
  // broker session is disconnected — never mass-mark every open row closed.
  // A genuinely flat account answers empty too, so the session itself is
  // asked: only a healthy session may authorise closing the last rows.
  // Without that check the final trade on an account could never be
  // reconciled, because closing it is exactly what makes the account empty
  // (2026-10-04: trade 400406267 sat open in the database while closed at the
  // broker, and Manage Signals showed its signal open forever).
  if (!Array.isArray(firstSnapshot) || firstSnapshot.length === 0) {
    if (probeHealthy && await sessionIsHealthy(probeHealthy)) {
      const emptyAgain = await api.openedOrders(metaapiAccountId)
      if (Array.isArray(emptyAgain) && emptyAgain.length > 0) return 0
      const ghostTrades = openTrades.filter(trade => {
        const ticket = Number(trade.broker_position_ticket ?? trade.metaapi_order_id)
        return Number.isFinite(ticket) && ticket > 0
      })
      if (!ghostTrades.length) return 0

      // An empty-but-successful snapshot is not proof a position is gone: a live
      // session can answer empty for the wrong account / a transient bridge
      // fault, and closing on that would strand a real, unmanaged position.
      // Require a positive close record (ticket or signal comment in history)
      // before closing; anything unconfirmed is deferred to review.
      let closableIds: string[]
      let unconfirmed: OpenTradeReconcileRow[]
      if (requireClosedHistory()) {
        const closedOrders = await loadClosedHistory(api, metaapiAccountId, ghostTrades)
        const closable: string[] = []
        unconfirmed = []
        for (const trade of ghostTrades) {
          if (matchClosedHistory(trade, closedOrders)) closable.push(trade.id)
          else unconfirmed.push(trade)
        }
        closableIds = closable
      } else {
        closableIds = ghostTrades.map(trade => trade.id)
        unconfirmed = []
      }

      let closed = 0
      if (closableIds.length) {
        closed = await closeStaleOpenTrades(supabase, closableIds)
        if (closed > 0) {
          const scopes = basketScopesForGhosts(openTrades, closableIds)
          if (scopes.length) {
            await purgeRangePendingLegsForBaskets(supabase, scopes, 'basket_flat_reconcile')
          }
          console.warn(
            `[openTradeReconcile] session healthy with no open positions — closed ${closed} stale row(s)`
            + ` confirmed in history account=${metaapiAccountId}`,
          )
        }
      }

      if (unconfirmed.length) {
        console.warn(
          `[openTradeReconcile] empty OpenedOrders but ${unconfirmed.length} trade(s) not confirmed in`
          + ` history account=${metaapiAccountId} — deferring (needs review)`,
        )
        captureBusinessIssue({
          category: 'reconciliation',
          event: 'reconciliation_needs_review',
          severity: 'warning',
          reasonCode: 'GHOST_UNCONFIRMED_BY_HISTORY',
          message: 'Flat account snapshot not corroborated by closed history',
          userImpact: 'manual_review_required',
          fingerprint: ['reconciliation_needs_review', 'open_trade_reconcile', 'GHOST_UNCONFIRMED_BY_HISTORY'],
          context: {
            broker_account_id: metaapiAccountId,
            stage: 'open_trade_reconcile',
            operation: 'open_trade_reconcile',
            extra: {
              unconfirmed_trades: unconfirmed.length,
              trade_ids: unconfirmed.slice(0, 10).map(t => t.id),
            },
          },
        })
      }
      return closed
    }
    console.warn(
      `[openTradeReconcile] empty OpenedOrders with ${openTrades.length} tracked open trade(s)`
      + ` account=${metaapiAccountId} — deferring ghost close (suspected disconnect)`,
    )
    return 0
  }

  // Before using this snapshot to decide a row is gone, corroborate that it
  // belongs to the account we asked about. A wrong or rotated bridge session
  // can answer with another login's positions, which look "absent" for ours —
  // that produced false ghost-close warnings (2026-10-07). Non-empty but
  // nobody we know: an untrusted read, so defer.
  if (expectedLogin && provider === 'mtapi') {
    const logins = snapshotLogins(firstSnapshot)
    if (logins.size > 0 && !logins.has(expectedLogin)) {
      console.warn(
        `[openTradeReconcile] OpenOrders snapshot does not belong to this account`
        + ` account=${metaapiAccountId} expectedLogin=${expectedLogin}`
        + ` seenLogins=${[...logins].slice(0, 3).join(',')} — deferring (untrusted read)`,
      )
      return 0
    }
  }

  // The reason is the whole point: 'stored ticket maps to multiple live
  // positions' and 'attributes match multiple live positions' have different
  // fixes, and neither was visible in the log before. Signal-derived symbol
  // text is stripped to a log-safe shape so a crafted symbol cannot forge a
  // line.
  const logAmbiguous = (trade: OpenTradeReconcileRow, reason: string, pass: string): void => {
    console.warn(
      `[openTradeReconcile] identity ambiguous trade=${trade.id}`
      + ` ticket=${trade.metaapi_order_id ?? 'none'}`
      + ` symbol=${String(trade.symbol ?? 'unknown').replace(/[^\w./-]/g, '_')}`
      + ` reason="${reason}" pass=${pass} — deferring close`,
    )
  }

  const presentByTicket = (resolution: ReturnType<typeof resolveCanonicalOpenPosition>): boolean =>
    resolution.status === 'resolved' && resolution.matchedBy !== 'attributes'

  // Pass 1 — persist certain replacements, then collect every row whose ticket
  // is not present by identity. An attribute-only match is not a ticket match;
  // it is treated as absent so the closure proof below gets to decide.
  const unresolved: OpenTradeReconcileRow[] = []
  for (const trade of openTrades) {
    const resolution = resolveCanonicalOpenPosition({ trade, openedOrders: firstSnapshot })
    if (resolution.status === 'resolved') {
      if (resolution.replacement && resolution.matchedBy !== 'attributes') {
        const persisted = await persistCanonicalPositionTicket(supabase, trade, resolution)
        if (!persisted) {
          console.warn(`[openTradeReconcile] replacement ticket CAS lost trade=${trade.id}; deferring`)
        }
      }
      if (presentByTicket(resolution)) continue
      console.warn(
        `[openTradeReconcile] identity attributes-only trade=${trade.id}`
        + ` ticket=${trade.metaapi_order_id ?? 'none'} pass=first — treating as absent`,
      )
    } else if (resolution.status === 'ambiguous') {
      logAmbiguous(trade, resolution.reason, 'first')
    }
    unresolved.push(trade)
  }
  if (!unresolved.length) return 0

  // One non-empty snapshot is not sufficient evidence of closure. Require the
  // same trade to be absent from a second complete snapshot before changing DB state.
  const secondSnapshot = await api.openedOrders(metaapiAccountId)
  if (!Array.isArray(secondSnapshot) || secondSnapshot.length === 0) {
    console.warn(
      `[openTradeReconcile] second OpenedOrders snapshot empty/incomplete account=${metaapiAccountId}; deferring close`,
    )
    return 0
  }

  // The second pass still validates the snapshot, but a row is no longer judged
  // gone by attribute ambiguity: a positive per-ticket close record in history
  // is what authorises the close (B1). Without the record the row is deferred.
  if (expectedLogin && provider === 'mtapi') {
    const secondLogins = snapshotLogins(secondSnapshot)
    if (secondLogins.size > 0 && !secondLogins.has(expectedLogin)) {
      console.warn(
        `[openTradeReconcile] second OpenOrders snapshot does not belong to this account`
        + ` account=${metaapiAccountId} expectedLogin=${expectedLogin} — deferring (untrusted read)`,
      )
      return 0
    }
  }

  let closedOrders: unknown[] | null = null
  const hasCloseProof = async (trade: OpenTradeReconcileRow): Promise<boolean> => {
    if (!requireClosedHistory()) return true
    if (closedOrders == null) closedOrders = await loadClosedHistory(api, metaapiAccountId, unresolved)
    return historyTicketCloseMatch(trade, closedOrders, provider)
  }

  const candidates: Array<{
    trade: OpenTradeReconcileRow
    resolution: ReturnType<typeof resolveCanonicalOpenPosition>
  }> = []
  for (const trade of unresolved) {
    const resolution = resolveCanonicalOpenPosition({ trade, openedOrders: secondSnapshot })
    if (resolution.status === 'resolved') {
      if (resolution.replacement && resolution.matchedBy !== 'attributes') {
        const persisted = await persistCanonicalPositionTicket(supabase, trade, resolution)
        if (!persisted) {
          console.warn(`[openTradeReconcile] replacement ticket CAS lost trade=${trade.id}; deferring`)
        }
      }
      if (presentByTicket(resolution)) continue
    } else if (resolution.status === 'ambiguous') {
      logAmbiguous(trade, resolution.reason, 'second')
    }
    candidates.push({ trade, resolution })
  }
  if (!candidates.length) return 0

  const proofById = new Map<string, boolean>()
  for (const { trade } of candidates) {
    proofById.set(trade.id, await hasCloseProof(trade))
  }
  const { ghostIds, deferred } = selectGhostClosures({
    candidates,
    closeProof: id => proofById.get(id) === true,
    requireProof: requireClosedHistory(),
  })
  for (const item of deferred) {
    console.warn(
      `[openTradeReconcile] absent but not confirmed closed trade=${item.id}`
      + ` reason="${item.reason}" — deferring (needs review)`,
    )
  }
  if (deferred.length && Date.now() - (absentAlertLastAt.get(metaapiAccountId) ?? 0) >= ABSENT_ALERT_COOLDOWN_MS) {
    absentAlertLastAt.set(metaapiAccountId, Date.now())
    captureBusinessIssue({
      category: 'reconciliation',
      event: 'reconciliation_needs_review',
      severity: 'warning',
      reasonCode: 'ABSENT_UNCONFIRMED_BY_HISTORY',
      message: 'Open trade absent from the broker snapshot but not confirmed closed in history',
      userImpact: 'manual_review_required',
      fingerprint: ['reconciliation_needs_review', 'open_trade_reconcile', 'ABSENT_UNCONFIRMED_BY_HISTORY'],
      context: {
        broker_account_id: metaapiAccountId,
        stage: 'open_trade_reconcile',
        operation: 'open_trade_reconcile',
        extra: {
          unconfirmed_trades: deferred.length,
          trade_ids: deferred.slice(0, 10).map(d => d.id),
        },
      },
    })
  }
  if (!ghostIds.length) return 0
  const closed = await closeStaleOpenTrades(supabase, ghostIds)
  if (closed > 0) {
    const scopes = basketScopesForGhosts(openTrades, ghostIds)
    if (scopes.length) {
      await purgeRangePendingLegsForBaskets(supabase, scopes, 'basket_flat_reconcile')
    }
  }
  return closed
}

/**
 * Decide which absent rows may be closed. A row is only closed when history
 * holds a positive per-ticket close record (`closeProof`); otherwise it is
 * deferred for review. Kept pure so the decision is unit-testable.
 */
export function selectGhostClosures(args: {
  candidates: Array<{
    trade: { id: string }
    resolution: { status: string; reason?: string; identityMatch?: boolean }
  }>
  closeProof: (tradeId: string) => boolean
  requireProof: boolean
}): { ghostIds: string[]; deferred: Array<{ id: string; reason: string }> } {
  const ghostIds: string[] = []
  const deferred: Array<{ id: string; reason: string }> = []
  for (const { trade, resolution } of args.candidates) {
    const reason = resolution.status === 'ambiguous'
      ? (resolution.reason ?? 'ambiguous')
      : 'stored ticket has no live position match'
    // A row whose stored ticket maps to several live positions is present, not
    // absent: never close it, whatever history says.
    if (resolution.identityMatch === true) {
      deferred.push({ id: trade.id, reason })
      continue
    }
    if (!args.requireProof) {
      // Legacy absence-only mode: a row the resolver could not pin down
      // (attribute-ambiguous) is never closed here, exactly as before.
      if (resolution.status === 'missing') ghostIds.push(trade.id)
      else deferred.push({ id: trade.id, reason })
      continue
    }
    if (args.closeProof(trade.id)) ghostIds.push(trade.id)
    else deferred.push({ id: trade.id, reason })
  }
  return { ghostIds, deferred }
}
