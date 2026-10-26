/**
 * Orphan-position sweep — broker POSITIONS that carry our order comment but
 * have no `trades` row, so nothing manages them.
 *
 * The entry path already resolves an ambiguous send when it can:
 * `reconcileUnknownSend` (orderLegExecution) adopts a timed-out order when
 * /OpenedOrders proves exactly one match, resends a market order when provably
 * absent, and otherwise stays ambiguous (Sentry `broker_order_ambiguous`) with
 * no later re-check. What had no safety net: an adoption that never happened —
 * inconclusive broker read at that moment, multiple matches, a crash between
 * adoption and insert — leaves a live position with our comment and no
 * database row, forever unmanaged. This sweep is that net, and it also cleans
 * up historical strays.
 *
 * Rules (conservative by design — a wrong insert is worse than a missed orphan):
 *   * Only FILLED positions qualify: resting pendings (range/layering legs,
 *     which keep their trades row until fill) are rejected by
 *     `isLikelyMarketPositionRow`.
 *   * Only parseable TScopier comments qualify; the comment's 8-hex signal
 *     prefix resolves the signal through a UUID RANGE query (a `LIKE` on a
 *     uuid column does not run in Postgres) verified client-side with
 *     `signalIdMatchesPrefix`.
 *   * The position ticket must appear in no trades row for the account
 *     (either ticket column, any status).
 *   * Direction must be readable from the row AND agree with the signal's
 *     side when the signal states one; volume must parse to > 0 — otherwise
 *     alert, never guess.
 *   * If an open row already exists for that signal with a NULL position
 *     ticket, it is resolved against the same snapshot first: matching this
 *     position means tracked, anything else means alert (never a second row).
 *   * Adopted rows copy the broker's own numbers (entry/stop/target/lots) and
 *     both tickets, so every later reader sees an ordinary managed trade.
 *   * Alerts (no signal resolvable etc.) are rate-limited per ticket to one
 *     per 6 hours — `manual_review_required` events are never auto-suppressed
 *     by the business-event cooldown, so the throttle lives here.
 *
 * Cadence: hourly by default — one /OpenedOrders read per active account per
 * hour, an order of magnitude lighter than the reconcile monitor next door.
 * Env: WORKER_ORPHAN_POSITION_SWEEP=false disables; ORPHAN_SWEEP_TICK_MS /
 * ORPHAN_SWEEP_IDLE_MS tune within 5 minutes … 6 hours (these are NOT passed
 * through monitorActiveIntervalMs, which clamps anything explicit to 60s).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  hasWorkOnShard,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { applyShardToQuery } from './monitorIdleGate'
import { brokerRuntimeForAccount, loadBrokerApiByAccountId } from './mtApiByAccount'
import { extractOpenOrderFromBrokerRaw } from './managementBrokerClose'
import { isTscopierComment, parseTscopierComment, signalIdMatchesPrefix } from './tscopierComment'
import { isLikelyMarketPositionRow } from './signalEntryPendingHelpers'
import { livePositionVolume, positiveNumber, resolveCanonicalOpenPosition } from './livePositionIdentity'
import { brokerOrderOpenMs } from './tradeExecutor/helpers'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { writeExecutionLog } from './observability/executionLog'
import { captureBusinessIssue } from './observability/businessEvents'
import { directionOf } from './tradeExecutor/reconcileUnknownSend'

function sweepIntervalMs(envKey: string, fallbackMs: number): number {
  const raw = Number(process.env[envKey])
  if (!Number.isFinite(raw)) return fallbackMs
  return Math.max(5 * 60_000, Math.min(6 * 60 * 60_000, Math.floor(raw)))
}

const ACTIVE_MS = sweepIntervalMs('ORPHAN_SWEEP_TICK_MS', 60 * 60_000)
const IDLE_MS = sweepIntervalMs('ORPHAN_SWEEP_IDLE_MS', 60 * 60_000)
const ACCOUNTS_PER_TICK = 400
/** One alert per orphan ticket per this window (`manual_review_required`
 *  events bypass the business-event cooldown, so the sweep throttles itself). */
const ORPHAN_ALERT_TTL_MS = 6 * 60 * 60_000
const ORPHAN_ALERT_MAX_KEYS = 500

export type OrphanCandidate = {
  ticket: number
  symbol: string
  /** null = the row did not state a side; classify() refuses to guess it. */
  isBuy: boolean | null
  lots: number
  comment: string
  signalPrefix: string
  openPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  openedAt: string
}

function firstPositiveNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const n = positiveNumber(row[key])
    if (n != null) return n
  }
  return null
}

/** Position row → sweep candidate, or null when it is not ours to consider. */
export function positionFromBrokerRow(raw: unknown): OrphanCandidate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  // Resting pendings (range/layering/strict entries) keep their trades row
  // until fill — adopting one as an open position would shadow the real fill
  // insert (and on MT4 block it via the idempotency index).
  if (!isLikelyMarketPositionRow(row)) return null

  const base = extractOpenOrderFromBrokerRaw(raw)
  if (!base) return null
  if (!isTscopierComment(base.comment)) return null
  const parsed = parseTscopierComment(base.comment)
  if (!parsed?.signalIdPrefix) return null

  const ticket = base.ticket > 0
    ? base.ticket
    : firstPositiveNumber(row, ['positionTicket', 'PositionTicket', 'positionId', 'PositionId']) ?? 0
  if (ticket <= 0) return null

  return {
    ticket,
    symbol: base.symbol,
    isBuy: (() => {
      const side = directionOf(row)
      return side == null ? null : side === 'buy'
    })(),
    lots: livePositionVolume(row) ?? 0,
    comment: base.comment,
    signalPrefix: parsed.signalIdPrefix.toLowerCase(),
    openPrice: firstPositiveNumber(row, ['openPrice', 'OpenPrice', 'price', 'Price', 'priceOpen', 'PriceOpen']),
    stopLoss: firstPositiveNumber(row, ['stopLoss', 'StopLoss', 'sl', 'SL']),
    takeProfit: firstPositiveNumber(row, ['takeProfit', 'TakeProfit', 'tp', 'TP']),
    openedAt: brokerRowOpenedAt(row),
  }
}

/** Broker row timestamp as ISO; falls back to now when the reader finds nothing. */
export function brokerRowOpenedAt(row: Record<string, unknown>): string {
  const ms = brokerOrderOpenMs(row)
  return new Date(ms ?? Date.now()).toISOString()
}

/**
 * UUID range for an 8-hex signal-id prefix. Postgres has no `uuid ~~ text`
 * operator, so `LIKE '4bfb255e%'` on `signals.id` fails with 42883 — a range
 * on the uuid type gives the same set: [prefix-0000…, nextprefix-0000…).
 */
export function uuidPrefixRange(prefix8: string): { gte: string; lt: string } | null {
  const p = String(prefix8 ?? '').toLowerCase()
  if (!/^[0-9a-f]{8}$/.test(p)) return null
  if (p === 'ffffffff') return null // no next prefix; callers fall back to lte
  const next = (BigInt(`0x${p}`) + 1n).toString(16).padStart(8, '0')
  return {
    gte: `${p}-0000-0000-0000-000000000000`,
    lt: `${next}-0000-0000-0000-000000000000`,
  }
}

export type OrphanDecision =
  | { kind: 'tracked' }
  | {
    kind: 'adopt'
    signalId: string
    channelId: string | null
    parsedSymbol: string | null
    signalSide: 'buy' | 'sell' | null
  }
  | { kind: 'alert'; reason: string }

export type OrphanSignalMatch = {
  id: string
  channel_id: string | null
  symbol: string | null
  /** parsed_data.action when it is a side ('buy'/'sell'), else null. */
  action: string | null
}

/**
 * Pure decision table for one candidate position.
 *  - tracked: the ticket exists in some trades row → nothing to do;
 *  - adopt:   exactly one matching signal, readable and agreeing direction,
 *             usable volume, compatible symbol;
 *  - alert:   anything else — never guess a row into existence.
 */
export function classifyOrphanPosition(args: {
  candidate: OrphanCandidate
  trackedTickets: ReadonlySet<number>
  signals: OrphanSignalMatch[]
}): OrphanDecision {
  const { candidate, trackedTickets, signals } = args
  if (!candidate.ticket || trackedTickets.has(candidate.ticket)) return { kind: 'tracked' }
  if (candidate.isBuy == null) {
    return { kind: 'alert', reason: 'position row does not state a side' }
  }
  if (!(candidate.lots > 0)) {
    return { kind: 'alert', reason: 'position row has no usable volume' }
  }
  if (signals.length === 0) {
    return { kind: 'alert', reason: `no signal matches prefix ${candidate.signalPrefix}` }
  }
  if (signals.length > 1) {
    return { kind: 'alert', reason: `prefix ${candidate.signalPrefix} matches ${signals.length} signals` }
  }
  const signal = signals[0]!
  if (signal.symbol && !symbolsCompatibleForBasket(signal.symbol, candidate.symbol)) {
    return {
      kind: 'alert',
      reason: `signal symbol ${signal.symbol} is not compatible with position ${candidate.symbol}`,
    }
  }
  const signalSide = signal.action === 'buy' || signal.action === 'sell'
    ? (signal.action as 'buy' | 'sell')
    : null
  if (signalSide && (signalSide === 'buy') !== candidate.isBuy) {
    return {
      kind: 'alert',
      reason: `position side ${candidate.isBuy ? 'buy' : 'sell'} disagrees with signal side ${signalSide}`,
    }
  }
  return {
    kind: 'adopt',
    signalId: signal.id,
    channelId: signal.channel_id,
    parsedSymbol: signal.symbol,
    signalSide,
  }
}

/** Build the trades insert payload (pure — tested directly). */
export function buildAdoptInsertRow(args: {
  userId: string
  brokerAccountId: string
  candidate: OrphanCandidate
  decision: Extract<OrphanDecision, { kind: 'adopt' }>
}): Record<string, unknown> {
  return {
    user_id: args.userId,
    signal_id: args.decision.signalId,
    broker_account_id: args.brokerAccountId,
    telegram_channel_id: args.decision.channelId,
    symbol: args.candidate.symbol,
    direction: args.candidate.isBuy ? 'buy' : 'sell',
    lot_size: args.candidate.lots,
    entry_price: args.candidate.openPrice,
    sl: args.candidate.stopLoss,
    tp: args.candidate.takeProfit,
    status: 'open',
    opened_at: args.candidate.openedAt,
    metaapi_order_id: String(args.candidate.ticket),
    broker_position_ticket: String(args.candidate.ticket),
  }
}

export type OpenNullTicketRow = {
  id: string
  signal_id: string
  broker_account_id: string
  metaapi_order_id: string | null
  broker_position_ticket?: string | null
  symbol?: string | null
  direction?: string | null
  lot_size?: number | null
  entry_price?: number | null
}

/**
 * Supabase result → rows, or null on error. The null contract is what makes
 * the adopt path fail closed: only a successful query (even if empty) may
 * enable an insert.
 */
export function openRowsFromQuery(
  data: unknown,
  error: { message: string } | null,
): OpenNullTicketRow[] | null {
  if (error) return null
  return (data ?? []) as OpenNullTicketRow[]
}

export class OrphanPositionMonitor {
  private loop: MonitorLoopHandle | null = null
  private ticking = false
  private lastOrphanAlertAt = new Map<string, number>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    this.loop = startMonitorLoop({
      name: 'orphanPositionMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => hasWorkOnShard(sb, 'broker_accounts', q => q.eq('is_active', true)),
      tick: () => this.runTick(),
    })
    console.log(`[orphanPositionMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
  }

  stop() {
    this.loop?.stop()
    this.loop = null
  }

  getLoopHandle(): MonitorLoopHandle | null {
    return this.loop
  }

  /** One console + business event per orphan ticket per ORPHAN_ALERT_TTL_MS. */
  private alertThrottled(key: string): boolean {
    const now = Date.now()
    const until = this.lastOrphanAlertAt.get(key) ?? 0
    if (until > now) return true
    if (this.lastOrphanAlertAt.size >= ORPHAN_ALERT_MAX_KEYS) {
      const oldest = this.lastOrphanAlertAt.keys().next().value as string | undefined
      if (oldest !== undefined) this.lastOrphanAlertAt.delete(oldest)
    }
    this.lastOrphanAlertAt.set(key, now + ORPHAN_ALERT_TTL_MS)
    return false
  }

  private async runTick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tick()
    } catch (err) {
      console.warn(`[orphanPositionMonitor] tick failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.ticking = false
    }
  }

  private async tick(): Promise<void> {
    if (String(process.env.WORKER_ORPHAN_POSITION_SWEEP ?? '').toLowerCase() === 'false') return

    const accountsQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('broker_accounts')
        .select('id,user_id,label,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id,platform')
        .eq('is_active', true)
        .or('mtapi_session_id.neq.,fxsocket_account_id.neq.,metaapi_account_id.neq.')
        .limit(ACCOUNTS_PER_TICK),
    )
    if (!accountsQ) return
    const { data, error } = await accountsQ
    if (error) {
      console.warn(`[orphanPositionMonitor] account select failed: ${error.message}`)
      return
    }
    const accounts = (data ?? []) as Array<{
      id: string
      user_id: string
      label: string | null
      provider: string | null
      mtapi_session_id: string | null
      fxsocket_account_id: string | null
      metaapi_account_id: string | null
      platform: string | null
    }>
    if (!accounts.length) return
    if (accounts.length >= ACCOUNTS_PER_TICK) {
      console.warn(
        `[orphanPositionMonitor] account cap reached (${ACCOUNTS_PER_TICK}) —`
        + ' later accounts wait for a future tick; raise ACCOUNTS_PER_TICK if this repeats',
      )
    }

    const runtimes = await loadBrokerApiByAccountId(this.supabase, accounts.map(a => a.id))
    for (const account of accounts) {
      const runtime = brokerRuntimeForAccount(runtimes, account.id)
      if (!runtime) continue

      let orders: unknown[]
      try {
        orders = (await runtime.api.openedOrders(runtime.sessionId)) ?? []
      } catch (err) {
        console.warn(
          `[orphanPositionMonitor] OpenedOrders failed account=${account.label ?? account.id}:`
          + ` ${err instanceof Error ? err.message : String(err)}`,
        )
        continue
      }

      const candidates: OrphanCandidate[] = []
      for (const raw of orders) {
        const candidate = positionFromBrokerRow(raw)
        if (candidate) candidates.push(candidate)
      }
      if (!candidates.length) continue

      // One query per account: is any of these tickets already tracked?
      const tickets = [...new Set(candidates.map(c => c.ticket))]
      const trackedTickets = new Set<number>()
      try {
        const { data: trackedRows, error: trackedErr } = await this.supabase
          .from('trades')
          .select('broker_position_ticket,metaapi_order_id')
          .eq('broker_account_id', account.id)
          .or(
            `broker_position_ticket.in.(${tickets.join(',')}),metaapi_order_id.in.(${tickets.join(',')})`,
          )
        if (trackedErr) {
          console.warn(`[orphanPositionMonitor] tracked-ticket lookup failed account=${account.id}: ${trackedErr.message}`)
          continue
        }
        for (const row of (trackedRows ?? []) as Array<{ broker_position_ticket?: string | null; metaapi_order_id?: string | null }>) {
          for (const value of [row.broker_position_ticket, row.metaapi_order_id]) {
            const n = Number(value)
            if (Number.isFinite(n) && n > 0) trackedTickets.add(n)
          }
        }
      } catch (err) {
        console.warn(`[orphanPositionMonitor] tracked-ticket lookup threw account=${account.id}: ${(err as Error).message}`)
        continue
      }

      // null = the lookup failed (cached so we do not hammer a broken read);
      // candidates sharing that prefix are skipped until the next tick.
      const signalsByPrefix = new Map<string, OrphanSignalMatch[] | null>()
      for (const candidate of candidates) {
        if (trackedTickets.has(candidate.ticket)) continue

        if (!signalsByPrefix.has(candidate.signalPrefix)) {
          signalsByPrefix.set(
            candidate.signalPrefix,
            await this.lookupSignalsByPrefix(account.user_id, candidate.signalPrefix),
          )
        }
        const signals = signalsByPrefix.get(candidate.signalPrefix) ?? null
        if (signals == null) continue // lookup failed — cannot decide; never alert with a false reason

        const decision = classifyOrphanPosition({ candidate, trackedTickets, signals })
        if (decision.kind === 'tracked') continue

        if (decision.kind === 'alert') {
          this.emitOrphanAlert(account, candidate, decision.reason)
          continue
        }

        // An open row may already exist for this signal with a NULL position
        // ticket (MT5 order-vs-position ticket divergence). Resolve those rows
        // against the same snapshot before creating a second one.
        const unresolved = await this.openRowsForSignal(account.id, decision.signalId)
        if (unresolved == null) continue // read failed — cannot prove untracked; never adopt blind
        if (unresolved.length) {
          const resolvesHere = unresolved.some(row => {
            const resolution = resolveCanonicalOpenPosition({ trade: row, openedOrders: orders })
            return resolution.status === 'resolved' && resolution.ticket === candidate.ticket
          })
          if (resolvesHere) continue // tracked, identity just not captured yet
          this.emitOrphanAlert(
            account,
            candidate,
            `open row exists for signal ${decision.signalId} but does not resolve to this position`,
          )
          continue
        }

        await this.adopt(account, candidate, decision)
      }
    }
  }

  /**
   * Resolve the signal by UUID RANGE on the 8-hex prefix (a `LIKE` on a uuid
   * column raises 42883 in Postgres) and verify client-side.
   */
  private async lookupSignalsByPrefix(userId: string, prefix8: string): Promise<OrphanSignalMatch[] | null> {
    const range = uuidPrefixRange(prefix8)
    try {
      let query = this.supabase
        .from('signals')
        .select('id,channel_id,parsed_data')
        .eq('user_id', userId)
        .limit(5)
      query = range
        ? query.gte('id', range.gte).lt('id', range.lt)
        : query.gte('id', `${prefix8}-0000-0000-0000-000000000000`)
          .lte('id', `${prefix8}-ffff-ffff-ffff-ffff`)
      const { data, error } = await query
      if (error) {
        // A read failure is NOT "no signal matches": report null so the caller
        // skips this candidate instead of emitting a misleading alert.
        console.warn(`[orphanPositionMonitor] signal lookup failed prefix=${prefix8}: ${error.message}`)
        return null
      }
      return (data ?? [])
        .filter(row => signalIdMatchesPrefix(String(row.id), prefix8))
        .map(row => {
          const parsed = (row as { parsed_data?: { symbol?: string | null; action?: string | null } | null }).parsed_data
          const action = typeof parsed?.action === 'string' ? parsed.action.toLowerCase() : null
          return {
            id: String(row.id),
            channel_id: (row as { channel_id?: string | null }).channel_id ?? null,
            symbol: typeof parsed?.symbol === 'string' ? parsed.symbol : null,
            action: action === 'buy' || action === 'sell' ? action : null,
          }
        })
    } catch (err) {
      console.warn(`[orphanPositionMonitor] signal lookup threw prefix=${prefix8}: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * Open trades rows for the signal whose position ticket was never captured
   * (contract: see openRowsFromQuery).
   */
  private async openRowsForSignal(
    brokerAccountId: string,
    signalId: string,
  ): Promise<OpenNullTicketRow[] | null> {
    try {
      const { data, error } = await this.supabase
        .from('trades')
        .select('id,signal_id,broker_account_id,metaapi_order_id,broker_position_ticket,symbol,direction,lot_size,entry_price')
        .eq('broker_account_id', brokerAccountId)
        .eq('signal_id', signalId)
        .eq('status', 'open')
        .is('broker_position_ticket', null)
        .limit(20)
      if (error) {
        console.warn(`[orphanPositionMonitor] open-row lookup failed signal=${signalId}: ${error.message} — skipping adopt this tick`)
      }
      return openRowsFromQuery(data, error)
    } catch (err) {
      console.warn(`[orphanPositionMonitor] open-row lookup threw signal=${signalId}: ${(err as Error).message} — skipping adopt this tick`)
      return null
    }
  }

  private emitOrphanAlert(
    account: { id: string; user_id: string; label: string | null },
    candidate: OrphanCandidate,
    reason: string,
  ): void {
    const key = `${account.id}|${candidate.ticket}`
    if (this.alertThrottled(key)) return
    console.warn(
      `[orphanPositionMonitor] UNMANAGED position account=${account.label ?? account.id}`
      + ` ticket=${candidate.ticket} symbol=${candidate.symbol}`
      + ` comment="${candidate.comment}" — ${reason}`,
    )
    captureBusinessIssue({
      category: 'reconciliation',
      event: 'orphan_position_untracked',
      severity: 'error',
      reasonCode: 'ORPHAN_POSITION_UNTRACKED',
      message: 'Broker position carries our comment but cannot be matched to a signal',
      userImpact: 'manual_review_required',
      dedupeKey: key,
      fingerprint: ['orphan_position_untracked', 'ORPHAN_POSITION_UNTRACKED', account.id],
      context: {
        user_id: account.user_id,
        broker_account_id: account.id,
        extra: {
          ticket: candidate.ticket,
          symbol: candidate.symbol,
          comment: candidate.comment,
          reason,
        },
      },
    })
  }

  private async adopt(
    account: { id: string; user_id: string; label: string | null },
    candidate: OrphanCandidate,
    decision: Extract<OrphanDecision, { kind: 'adopt' }>,
  ): Promise<void> {
    const insert = buildAdoptInsertRow({
      userId: account.user_id,
      brokerAccountId: account.id,
      candidate,
      decision,
    })
    try {
      const { error: insertErr } = await this.supabase.from('trades').insert(insert)
      if (insertErr) {
        // The idempotency index (broker_account_id, metaapi_order_id) makes a
        // concurrent adopt a benign duplicate-key failure, not a double row.
        console.warn(`[orphanPositionMonitor] adopt insert failed ticket=${candidate.ticket}: ${insertErr.message}`)
        return
      }
      console.warn(
        `[orphanPositionMonitor] ADOPTED orphan position account=${account.label ?? account.id}`
        + ` ticket=${candidate.ticket} symbol=${candidate.symbol} signal=${decision.signalId}`,
      )
      await writeExecutionLog(this.supabase, {
        user_id: account.user_id,
        signal_id: decision.signalId,
        broker_account_id: account.id,
        action: 'orphan_position_adopted',
        status: 'success',
        request_payload: {
          ticket: candidate.ticket,
          symbol: candidate.symbol,
          comment: candidate.comment,
          lots: candidate.lots,
          sl: candidate.stopLoss,
          tp: candidate.takeProfit,
        } as unknown as Record<string, unknown>,
      })
    } catch (err) {
      console.warn(`[orphanPositionMonitor] adopt threw ticket=${candidate.ticket}: ${(err as Error).message}`)
    }
  }
}
