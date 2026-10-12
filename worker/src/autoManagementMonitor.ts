import type { SupabaseClient } from '@supabase/supabase-js'
import { TRADE_CLOSE_REASON } from './tradeCloseReasons'
import { applyCloseUpdate } from './tradeCloseUpdate'
import {
  clampBreakevenModifyStops,
  computeBreakevenStopLoss,
  isAutoBeTriggerMet,
  isAutoBeTpHitAbsolutePrice,
  isSlAtOrBeyondBreakeven,
  pricesNearlyEqual,
  resolveSlForBreakevenCheck,
  type AutoBeMode,
  type AutoBeType,
} from './autoManagement'
import { isUnresolvableFailure } from './failureClassification'
import { pipCalculator, pipValueForLots } from './pipCalculator'
import { signalPipPrice } from './signalPip'
import {
  normalizeSymbolParams,
  type FxsocketBrokerClient,
  type SymbolParams,
} from './fxsocketClient'
import {
  brokerRuntimeForAccount,
  loadBrokerApiByAccountId,
  type BrokerApiByAccountId,
} from './mtApiByAccount'
import { resolveCurrentLivePosition } from './livePositionIdentity'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { isUserCopierPausedCached } from './copierPause'
import { parseUserOverride, userOverrideHasStopLevels } from './signalOverride'
import { writeExecutionLog } from './observability/executionLog'
interface AutoBeTradeRow {
  id: string
  user_id: string
  signal_id: string | null
  broker_account_id: string | null
  metaapi_order_id: string | null
  broker_position_ticket?: string | null
  symbol: string
  direction: string
  entry_price: number | null
  sl: number | null
  tp: number | null
  lot_size: number | null
  auto_be_mode: string
  auto_be_trigger_value: number | null
  auto_be_tp_index: number | null
  auto_be_type: string | null
  auto_be_offset_pips: number | null
  auto_be_risk_sl: number | null
}

interface PartialLegRow {
  trade_id: string
  tp_idx: number
  trigger_price: number
  status: string
}

const ACTIVE_MS = monitorActiveIntervalMs('AUTO_MANAGEMENT_TICK_MS', 400)
const IDLE_MS = monitorIdleIntervalMs('AUTO_MANAGEMENT_IDLE_MS', 15_000)
const SYMBOL_CACHE_TTL_MS = 5 * 60_000
/** Throttle failed auto_be log rows per trade so a disconnected broker cannot flood trade_execution_logs. */
const FAILURE_LOG_THROTTLE_MS = Math.max(60_000, Number(process.env.AUTO_BE_FAILURE_LOG_THROTTLE_MS ?? 5 * 60_000))
/**
 * Per-trade retry backoff. A trade whose apply keeps failing (e.g. its stored
 * ticket has no live position match) must not be re-driven every 400 ms tick —
 * that floods the broker bridge and starves real order sends. Backoff is
 * exponential with jitter and is cleared as soon as the trade applies or leaves
 * the work set, so healthy trades are never delayed.
 */
const TRANSIENT_BACKOFF_BASE_MS = Math.max(250, Number(process.env.AUTO_BE_TRANSIENT_BACKOFF_MS ?? 1_000))
const TRANSIENT_BACKOFF_MAX_MS = Math.max(
  TRANSIENT_BACKOFF_BASE_MS,
  Number(process.env.AUTO_BE_TRANSIENT_BACKOFF_MAX_MS ?? 15_000),
)
const UNRESOLVABLE_BACKOFF_BASE_MS = Math.max(1_000, Number(process.env.AUTO_BE_FAILURE_BACKOFF_MS ?? 5_000))
const UNRESOLVABLE_BACKOFF_MAX_MS = Math.max(
  UNRESOLVABLE_BACKOFF_BASE_MS,
  Number(process.env.AUTO_BE_FAILURE_BACKOFF_MAX_MS ?? 5 * 60_000),
)
/** Consecutive unresolvable failures before a trade is parked (long backoff). */
const UNRESOLVABLE_QUARANTINE_AFTER = Math.max(3, Number(process.env.AUTO_BE_QUARANTINE_AFTER ?? 6))
const UNRESOLVABLE_QUARANTINE_MS = Math.max(60_000, Number(process.env.AUTO_BE_QUARANTINE_MS ?? 30 * 60_000))

/**
 * A failure a retry cannot fix — the stored ticket does not map to a unique live
 * position. Retrying these at any rate is pointless (only reconciliation can
 * resolve them), so they get a long, escalating backoff. Everything else is
 * treated as transient and retried soon so protective moves are not delayed.
 *
 * Defined in `failureClassification.ts` (shared with `partialTpMonitor`) and
 * re-exported here so existing callers keep working.
 */
export { isUnresolvableFailure }

type SymbolCacheEntry = {
  digits: number
  point: number
  contractSize: number | null
  stopsLevel: number
  freezeLevel: number
  loadedAt: number
}

export class AutoManagementMonitor {
  private loop: MonitorLoopHandle | null = null
  private runtimeByBroker: BrokerApiByAccountId = new Map()
  private ticking = false
  private firstTickLogged = false
  private quietTicks = 0
  private symbolCache = new Map<string, SymbolCacheEntry>()
  private failureLogCooldownUntil = new Map<string, number>()
  /** Per-trade retry state so a permanently-failing trade backs off instead of hot-looping. */
  private failureByTrade = new Map<string, { count: number; nextAt: number }>()
  /** Why the last apply for a trade failed, to pick transient vs unresolvable backoff. */
  private failureClassByTrade = new Map<string, 'transient' | 'unresolvable'>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.loop) return
    this.loop = startMonitorLoop({
      name: 'autoManagementMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      // broker_account_id is required: a trade with no account can never be
      // managed, so it must not keep this monitor permanently active.
      hasWork: sb => hasWorkOnShard(sb, 'trades', q =>
        q.eq('status', 'open').not('auto_be_mode', 'is', null).is('auto_be_applied_at', null)
          .not('broker_account_id', 'is', null),
      ),
      tick: () => this.runTick(),
    })
    console.log(`[autoManagementMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
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
    } finally {
      this.ticking = false
    }
  }

  private markFailureClass(tradeId: string, message: string): 'transient' | 'unresolvable' {
    const cls = isUnresolvableFailure(message) ? 'unresolvable' : 'transient'
    this.failureClassByTrade.set(tradeId, cls)
    return cls
  }

  private registerFailure(tradeId: string, cls: 'transient' | 'unresolvable'): void {
    const prev = this.failureByTrade.get(tradeId)
    const count = Math.min((prev?.count ?? 0) + 1, 30)
    const base = cls === 'unresolvable' ? UNRESOLVABLE_BACKOFF_BASE_MS : TRANSIENT_BACKOFF_BASE_MS
    const max = cls === 'unresolvable' ? UNRESOLVABLE_BACKOFF_MAX_MS : TRANSIENT_BACKOFF_MAX_MS
    let wait = Math.min(max, base * 2 ** (count - 1))
    if (cls === 'unresolvable' && count >= UNRESOLVABLE_QUARANTINE_AFTER) {
      wait = UNRESOLVABLE_QUARANTINE_MS
      if (count === UNRESOLVABLE_QUARANTINE_AFTER) {
        console.warn(
          `[autoManagementMonitor] parking unresolvable trade=${tradeId} after ${count} attempts`
          + ` (needs reconciliation; will retry in ~${Math.round(wait / 60000)}m)`,
        )
      }
    }
    const jitter = wait * (0.5 + Math.random())
    this.failureByTrade.set(tradeId, { count, nextAt: Date.now() + jitter })
  }

  private clearFailure(tradeId: string): void {
    this.failureByTrade.delete(tradeId)
    this.failureClassByTrade.delete(tradeId)
  }

  private async tick(): Promise<void> {
    const tradesQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('trades')
        .select(
          'id,user_id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,entry_price,sl,tp,lot_size,'
          + 'auto_be_mode,auto_be_trigger_value,auto_be_tp_index,auto_be_type,auto_be_offset_pips,auto_be_risk_sl,'
          + 'broker_position_ticket',
        )
        .eq('status', 'open')
        .not('auto_be_mode', 'is', null)
        .is('auto_be_applied_at', null)
        .not('broker_account_id', 'is', null)
        .limit(500),
    )
    if (!tradesQ) return
    const { data, error } = await tradesQ
    if (error) {
      console.error('[autoManagementMonitor] select failed:', error.message)
      return
    }
    const rows = ((data ?? []) as unknown as AutoBeTradeRow[])
      .filter(r => !isUserCopierPausedCached(r.user_id))
    if (!this.firstTickLogged) {
      this.firstTickLogged = true
      console.log(`[autoManagementMonitor] first tick ok auto_be_rows=${rows.length}`)
    }
    if (!rows.length) return

    const overrideBySignal = await this.loadUserOverridesBySignal(
      [...new Set(rows.map(r => r.signal_id).filter((id): id is string => Boolean(id)))],
    )

    const tradeIds = rows.map(r => r.id)
    const partialByTrade = await this.loadPartialLegs(tradeIds)

    const brokerIds = [...new Set(rows.map(r => r.broker_account_id).filter(Boolean))] as string[]
    this.runtimeByBroker = await loadBrokerApiByAccountId(this.supabase, brokerIds)

    const groups = new Map<string, AutoBeTradeRow[]>()
    for (const row of rows) {
      const brokerId = row.broker_account_id ?? ''
      if (!brokerRuntimeForAccount(this.runtimeByBroker, brokerId)) continue
      const key = `${brokerId}:${row.symbol.toUpperCase()}`
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }

    let appliedTotal = 0
    let applyErrTotal = 0
    const tickNow = Date.now()
    // One open-orders snapshot per account per tick (not per trade): the apply
    // decision reads the same live-position data for every trade on the account,
    // so N trades must not mean N identical bridge reads.
    const openedOrdersByAccount = new Map<string, unknown[] | null>()
    for (const [key, group] of groups) {
      const brokerId = key.split(':')[0]!
      const symbol = group[0]?.symbol ?? ''
      let bid: number
      let ask: number
      const runtime = brokerRuntimeForAccount(this.runtimeByBroker, brokerId)
      if (!runtime) continue
      const { api, sessionId: uuid } = runtime
      try {
        const q = await api.quote(uuid, symbol)
        bid = q.bid
        ask = q.ask
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[autoManagementMonitor] /Quote failed for ${symbol} (account=${uuid}): ${msg}`)
        continue
      }

      for (const trade of group) {
        if ((this.failureByTrade.get(trade.id)?.nextAt ?? 0) > tickNow) continue
        if (userOverrideHasStopLevels(overrideBySignal.get(trade.signal_id ?? ''))) {
          continue
        }
        const partials = partialByTrade.get(trade.id) ?? []
        const manual = (runtime.manualSettings ?? {}) as { half_close_percent?: number }
        const halfClosePct = Math.min(
          99,
          Math.max(1, Math.floor(Number(manual.half_close_percent ?? 50) || 50)),
        )
        let ordersSnapshot: unknown[] | null
        if (openedOrdersByAccount.has(uuid)) {
          ordersSnapshot = openedOrdersByAccount.get(uuid)!
        } else {
          try {
            ordersSnapshot = (await api.openedOrders(uuid)) ?? []
          } catch {
            ordersSnapshot = null
          }
          openedOrdersByAccount.set(uuid, ordersSnapshot)
        }
        const ok = await this.maybeApplyBreakeven(
          trade, uuid, api, bid, ask, partials, halfClosePct, ordersSnapshot,
        )
        if (ok === false) {
          this.registerFailure(trade.id, this.failureClassByTrade.get(trade.id) ?? 'transient')
        } else {
          this.clearFailure(trade.id)
        }
        if (ok === true) appliedTotal++
        if (ok === false) applyErrTotal++
      }
    }

    // Drop retry state for trades no longer in the work set so these maps stay
    // bounded over the process lifetime.
    const liveIds = new Set(rows.map(r => r.id))
    for (const key of this.failureByTrade.keys()) if (!liveIds.has(key)) this.failureByTrade.delete(key)
    for (const key of this.failureClassByTrade.keys()) if (!liveIds.has(key)) this.failureClassByTrade.delete(key)
    for (const key of this.failureLogCooldownUntil.keys()) if (!liveIds.has(key)) this.failureLogCooldownUntil.delete(key)

    if (appliedTotal > 0 || applyErrTotal > 0) {
      this.quietTicks = 0
      console.log(
        `[autoManagementMonitor] tick rows=${rows.length} groups=${groups.size} applied=${appliedTotal} errors=${applyErrTotal}`,
      )
    } else if (++this.quietTicks >= 20) {
      this.quietTicks = 0
      console.log(`[autoManagementMonitor] heartbeat rows=${rows.length} groups=${groups.size} (no BE updates this cycle)`)
    }
  }

  private async loadUserOverridesBySignal(
    signalIds: string[],
  ): Promise<Map<string, ReturnType<typeof parseUserOverride>>> {
    const out = new Map<string, ReturnType<typeof parseUserOverride>>()
    if (!signalIds.length) return out
    const { data, error } = await this.supabase
      .from('signals')
      .select('id,user_override')
      .in('id', signalIds)
    if (error) {
      console.warn(`[autoManagementMonitor] user_override select failed: ${error.message}`)
      return out
    }
    for (const row of data ?? []) {
      const id = String((row as { id?: string }).id ?? '')
      if (!id) continue
      out.set(id, parseUserOverride((row as { user_override?: unknown }).user_override))
    }
    return out
  }

  private async loadPartialLegs(tradeIds: string[]): Promise<Map<string, PartialLegRow[]>> {
    const out = new Map<string, PartialLegRow[]>()
    if (!tradeIds.length) return out
    const { data, error } = await this.supabase
      .from('partial_tp_legs')
      .select('trade_id,tp_idx,trigger_price,status')
      .in('trade_id', tradeIds)
    if (error) {
      console.warn(`[autoManagementMonitor] partial_tp_legs select failed: ${error.message}`)
      return out
    }
    for (const row of (data ?? []) as PartialLegRow[]) {
      const list = out.get(row.trade_id) ?? []
      list.push(row)
      out.set(row.trade_id, list)
    }
    return out
  }

  private async maybeApplyBreakeven(
    trade: AutoBeTradeRow,
    uuid: string,
    api: FxsocketBrokerClient,
    bid: number,
    ask: number,
    partials: PartialLegRow[],
    halfClosePercent: number,
    brokerOrders: unknown[] | null,
  ): Promise<boolean | null> {
    const ticketNum = Number(trade.metaapi_order_id)
    if (!Number.isFinite(ticketNum) || ticketNum <= 0) {
      await this.markApplied(trade.id, { clearWatch: true })
      return null
    }

    const entry = Number(trade.entry_price)
    if (!Number.isFinite(entry) || entry <= 0) return null

    const symEntry = await this.getSymbolCache(uuid, trade.symbol, api)
    if (!symEntry) return null

    const pipQuote = pipCalculator(
      trade.symbol,
      symEntry.point,
      symEntry.digits,
      symEntry.contractSize,
    )
    const signalPip = signalPipPrice(trade.symbol)
    const lots = Number(trade.lot_size ?? 0)
    const pipValuePerLot = pipValueForLots(pipQuote, lots > 0 ? lots : 0.01)

    const mode = String(trade.auto_be_mode).toLowerCase() as AutoBeMode
    const triggerValue = Number(trade.auto_be_trigger_value ?? 0)
    const tpIndex = Number(trade.auto_be_tp_index ?? 1)
    const offsetPips = Number(trade.auto_be_offset_pips ?? 0)
    const beType = String(trade.auto_be_type ?? 'sl_only').toLowerCase() as AutoBeType
    const isBuy = String(trade.direction).toLowerCase() === 'buy'

    const partialTpFiredIndices = partials
      .filter(p => p.status === 'fired')
      .map(p => p.tp_idx)
    const partialTpTriggers = partials
      .filter(p => p.status === 'pending' || p.status === 'fired')
      .map(p => ({ tpIdx: p.tp_idx, triggerPrice: Number(p.trigger_price) }))

    const brokerTp = trade.tp != null && Number.isFinite(Number(trade.tp)) && Number(trade.tp) > 0
      ? Number(trade.tp)
      : null

    const riskSl = trade.auto_be_risk_sl != null && Number.isFinite(Number(trade.auto_be_risk_sl))
      ? Number(trade.auto_be_risk_sl)
      : (trade.sl != null && Number.isFinite(Number(trade.sl)) ? Number(trade.sl) : null)

    const beSl = computeBreakevenStopLoss(isBuy, entry, offsetPips, signalPip, symEntry.digits)
    const currentSl = trade.sl != null && Number.isFinite(Number(trade.sl)) ? Number(trade.sl) : null

    let brokerSl: number | null = null
    if (brokerOrders) {
      for (const raw of brokerOrders) {
        const o = raw as Record<string, unknown>
        const t = Number(o.ticket ?? o.Ticket ?? o.order ?? o.Order ?? 0)
        if (t !== ticketNum && t !== Number(trade.broker_position_ticket ?? ticketNum)) continue
        const sl = Number(o.stopLoss ?? o.StopLoss ?? o.sl ?? o.SL ?? 0)
        if (Number.isFinite(sl) && sl > 0) brokerSl = sl
        break
      }
    }

    const effectiveSl = resolveSlForBreakevenCheck(currentSl, brokerSl)
    if (isSlAtOrBeyondBreakeven(isBuy, effectiveSl, beSl, signalPip)) {
      await this.markApplied(trade.id, { sl: effectiveSl ?? beSl })
      return null
    }

    if (!isAutoBeTriggerMet({
      mode,
      triggerValue,
      tpIndex,
      isBuy,
      entryPrice: entry,
      riskSl,
      bid,
      ask,
      pipPrice: signalPip,
      pipValuePerLot,
      partialTpFiredIndices,
      partialTpTriggers,
      brokerTp,
    })) {
      return null
    }

    const tpSanitize = brokerTp ?? 0
    const refPrice = isBuy ? bid : ask
    const clamped = clampBreakevenModifyStops({
      isBuy,
      stoploss: beSl,
      takeprofit: tpSanitize,
      referencePrice: refPrice,
      point: symEntry.point,
      digits: symEntry.digits,
      stopsLevel: symEntry.stopsLevel,
      freezeLevel: symEntry.freezeLevel,
    })
    const modifySl = clamped.stoploss
    // When TP-hit trigger == broker TP (typical predefined single-TP override),
    // clear takeprofit on the BE modify so the trade is not closed at that level.
    let modifyTp = clamped.takeprofit
    if (mode === 'tp_hit' && modifyTp > 0) {
      const hitPrice = isAutoBeTpHitAbsolutePrice(triggerValue, entry, isBuy)
        ? triggerValue
        : (brokerTp != null && partialTpTriggers.length === 0 ? brokerTp : null)
      if (hitPrice != null && pricesNearlyEqual(modifyTp, hitPrice)) {
        modifyTp = 0
      }
    }

    try {
      const resolution = await resolveCurrentLivePosition({
        supabase: this.supabase,
        api,
        sessionId: uuid,
        trade,
        openedOrders: brokerOrders ?? undefined,
      })
      if (resolution.status !== 'resolved') {
        throw new Error(`automatic management reconciliation required: ${resolution.reason}`)
      }
      const effectiveTicket = resolution.ticket
      await api.orderModify(uuid, {
        ticket: effectiveTicket,
        stoploss: modifySl,
        takeprofit: modifyTp,
      })

      let remainingLots = lots
      if (beType === 'sl_and_close_half' && lots > 0.0001) {
        const closeLots = +(lots * (halfClosePercent / 100)).toFixed(2)
        if (closeLots >= 0.01) {
          try {
            await api.orderClose(uuid, { ticket: effectiveTicket, lots: closeLots })
            remainingLots = Math.max(0, +(lots - closeLots).toFixed(2))
          } catch (halfErr) {
            const msg = halfErr instanceof Error ? halfErr.message : String(halfErr)
            console.warn(
              `[autoManagementMonitor] half close failed trade=${trade.id} ticket=${effectiveTicket}: ${msg}`,
            )
          }
        }
      }

      const patch: Record<string, unknown> = {
        sl: modifySl,
        auto_be_applied_at: new Date().toISOString(),
      }
      if (modifyTp !== tpSanitize) {
        patch.tp = modifyTp > 0 ? modifyTp : null
      }
      if (remainingLots < 0.0001) {
        patch.status = 'closed'
        patch.closed_at = new Date().toISOString()
        patch.close_reason = TRADE_CLOSE_REASON.AUTO_MANAGEMENT
        patch.lot_size = 0
      } else if (remainingLots !== lots) {
        patch.lot_size = remainingLots
      }

      await applyCloseUpdate(
        patch,
        p => this.supabase.from('trades').update(p).eq('id', trade.id).eq('status', 'open'),
      )

      this.failureLogCooldownUntil.delete(trade.id)
      await writeExecutionLog(this.supabase, {
        user_id: trade.user_id,
        signal_id: trade.signal_id,
        broker_account_id: trade.broker_account_id,
        action: 'auto_be',
        status: 'success',
        request_payload: {
          ticket: effectiveTicket,
          symbol: trade.symbol,
          direction: trade.direction,
          mode,
          trigger_value: triggerValue,
          new_sl: modifySl,
          be_type: beType,
          half_close: beType === 'sl_and_close_half',
        } as unknown as Record<string, unknown>,
      })

      console.log(
        `[autoManagementMonitor] applied trade=${trade.id} symbol=${trade.symbol} mode=${mode} sl→${modifySl}`,
      )
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const benign = /not\s+found|already\s+closed|invalid\s+ticket|no\s+such\s+order|unknown\s+ticket/i.test(msg)
      if (benign) {
        this.failureLogCooldownUntil.delete(trade.id)
        // A benign "not found / already closed / unknown ticket" cannot be fixed
        // by retrying — the row needs reconciliation — so classify it explicitly
        // as unresolvable (its wording does not match the generic classifier).
        this.failureClassByTrade.set(trade.id, 'unresolvable')
        console.warn(`[autoManagementMonitor] broker identity/close state ambiguous trade=${trade.id}; deferring to reconciliation`)
        return false
      }
      this.markFailureClass(trade.id, msg)
      console.warn(`[autoManagementMonitor] apply failed trade=${trade.id} ticket=${ticketNum}: ${msg}`)
      const now = Date.now()
      if (now >= (this.failureLogCooldownUntil.get(trade.id) ?? 0)) {
        this.failureLogCooldownUntil.set(trade.id, now + FAILURE_LOG_THROTTLE_MS)
        await writeExecutionLog(this.supabase, {
          user_id: trade.user_id,
          signal_id: trade.signal_id,
          broker_account_id: trade.broker_account_id,
          action: 'auto_be',
          status: 'failed',
          request_payload: { ticket: ticketNum, symbol: trade.symbol, attempted_sl: modifySl, mode },
          error_message: msg,
        })
      }
      return false
    }
  }

  private async markApplied(
    tradeId: string,
    opts: { sl?: number | null; clearWatch?: boolean },
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      auto_be_applied_at: new Date().toISOString(),
    }
    if (opts.sl != null && Number.isFinite(opts.sl)) patch.sl = opts.sl
    if (opts.clearWatch) {
      patch.auto_be_mode = null
    }
    await this.supabase.from('trades').update(patch).eq('id', tradeId)
  }

  private async getSymbolCache(
    uuid: string,
    symbol: string,
    api: FxsocketBrokerClient,
  ): Promise<SymbolCacheEntry | null> {
    const key = `${uuid}:${symbol.toUpperCase()}`
    const cached = this.symbolCache.get(key)
    if (cached && Date.now() - cached.loadedAt < SYMBOL_CACHE_TTL_MS) return cached
    try {
      const p: SymbolParams = await api.symbolParams(uuid, symbol)
      const n = normalizeSymbolParams(p)
      const entry: SymbolCacheEntry = {
        digits: n.digits ?? 5,
        point: n.point ?? 0.00001,
        contractSize: Number.isFinite(n.contractSize) && (n.contractSize ?? 0) > 0 ? Number(n.contractSize) : null,
        stopsLevel: Math.max(0, n.stopsLevel ?? 0),
        freezeLevel: Math.max(0, n.freezeLevel ?? 0),
        loadedAt: Date.now(),
      }
      this.symbolCache.set(key, entry)
      return entry
    } catch {
      return null
    }
  }
}
