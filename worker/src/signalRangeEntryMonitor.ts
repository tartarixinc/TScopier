import type { SupabaseClient } from '@supabase/supabase-js'
import { hasFxsocketConfigured, normalizeSymbolParams } from './fxsocketClient'
import { pipCalculator } from './pipCalculator'
import { resolvedParsedEntryZone } from './manualPlanning/parsedEntry'
import type { ParsedSignal } from './manualPlanning/types'
import { apiForFxsocketAccount, loadPlatformByFxsocketId, type PlatformByFxsocketId } from './mtApiByAccount'
import { signalRangeEntryQuoteAllowsImmediate } from './manualPlanner'
import { isUserCopierPausedCached } from './copierPause'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import type { TradeExecutor } from './tradeExecutor'
import type { SignalRow } from './tradeExecutor/types'
import {
  logSignalRangeEntryFired,
  type SignalRangeEntryWaitRow,
  waitRowToPlannerWait,
} from './signalRangeEntryHelpers'

const ACTIVE_MS = monitorActiveIntervalMs('SIGNAL_RANGE_ENTRY_TICK_MS', 2_000)
const IDLE_MS = monitorIdleIntervalMs('SIGNAL_RANGE_ENTRY_IDLE_MS', 60_000)

/**
 * Polls /Quote for virtual "Use signal range" waits and re-dispatches when price
 * reaches the signal level or zone edge ± pip tolerance.
 */
export class SignalRangeEntryMonitor {
  private loop: MonitorLoopHandle | null = null
  private platformByUuid: PlatformByFxsocketId = new Map()
  private ticking = false

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly tradeExecutor: TradeExecutor,
  ) {}

  start() {
    if (this.loop) return
    if (!hasFxsocketConfigured()) {
      console.warn('[signalRangeEntryMonitor] FxSocket not configured — monitor disabled')
      return
    }
    this.loop = startMonitorLoop({
      name: 'signalRangeEntryMonitor',
      supabase: this.supabase,
      activeIntervalMs: ACTIVE_MS,
      idleIntervalMs: IDLE_MS,
      hasWork: sb => hasWorkOnShard(sb, 'signal_range_entry_waits', q =>
        q.eq('status', 'waiting'),
      ),
      tick: () => this.runTick(),
    })
    console.log(`[signalRangeEntryMonitor] started active=${ACTIVE_MS}ms idle=${IDLE_MS}ms`)
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
      await this.tickOnce()
    } finally {
      this.ticking = false
    }
  }

  private async tickOnce(): Promise<void> {
    if (!hasFxsocketConfigured()) return

    const rowsQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('signal_range_entry_waits')
        .select('*')
        .eq('status', 'waiting')
        .order('created_at', { ascending: true })
        .limit(200),
    )
    if (!rowsQ) return
    const { data, error } = await rowsQ
    if (error) {
      console.error('[signalRangeEntryMonitor] select failed:', error.message)
      return
    }
    const rows = ((data ?? []) as SignalRangeEntryWaitRow[])
      .filter(r => !isUserCopierPausedCached(r.user_id))
    if (!rows.length) return

    this.platformByUuid = await loadPlatformByFxsocketId(
      this.supabase,
      rows.map(r => r.metaapi_account_id),
    )

    const now = Date.now()
    const active = rows.filter(r => !r.expires_at || Date.parse(r.expires_at) > now)
    for (const row of rows) {
      if (row.expires_at && Date.parse(row.expires_at) <= now) {
        await this.supabase
          .from('signal_range_entry_waits')
          .update({ status: 'expired', updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'waiting')
      }
    }

    const quoteGroups = new Map<string, SignalRangeEntryWaitRow[]>()
    for (const row of active) {
      const key = `${row.metaapi_account_id}:${row.symbol.toUpperCase()}`
      const list = quoteGroups.get(key) ?? []
      list.push(row)
      quoteGroups.set(key, list)
    }

    for (const [, group] of quoteGroups) {
      const sample = group[0]!
      const api = apiForFxsocketAccount(this.platformByUuid, sample.metaapi_account_id)
      if (!api) continue
      let bid: number
      let ask: number
      let pipSize = 0.00001
      try {
        const q = await api.quote(sample.metaapi_account_id, sample.symbol)
        bid = q.bid
        ask = q.ask
        try {
          const rawParams = await api.symbolParams(sample.metaapi_account_id, sample.symbol)
          const normalized = normalizeSymbolParams(rawParams)
          const point = normalized.point
          const digits = normalized.digits
          if (point != null && Number.isFinite(point) && point > 0) {
            pipSize = pipCalculator(
              sample.symbol,
              point,
              digits ?? 5,
              normalized.contractSize ?? null,
            ).pipPrice
          }
        } catch {
          /* default pipSize */
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[signalRangeEntryMonitor] /Quote failed account=${sample.metaapi_account_id} symbol=${sample.symbol}: ${msg}`,
        )
        continue
      }

      for (const row of group) {
        const wait = waitRowToPlannerWait(row)
        const { data: signalZoneRow } = await this.supabase
          .from('signals')
          .select('parsed_data')
          .eq('id', row.signal_id)
          .maybeSingle()
        const freshZone = signalZoneRow?.parsed_data
          ? resolvedParsedEntryZone(signalZoneRow.parsed_data as ParsedSignal)
          : null
        if (freshZone) {
          wait.zoneLo = freshZone.lo
          wait.zoneHi = freshZone.hi
          if (freshZone.lo !== row.zone_lo || freshZone.hi !== row.zone_hi) {
            await this.supabase
              .from('signal_range_entry_waits')
              .update({
                zone_lo: freshZone.lo,
                zone_hi: freshZone.hi,
                updated_at: new Date().toISOString(),
              })
              .eq('id', row.id)
              .eq('status', 'waiting')
          }
        }
        if (!signalRangeEntryQuoteAllowsImmediate({ wait, bid, ask, pipSize })) continue

        const { data: claimed, error: claimErr } = await this.supabase
          .from('signal_range_entry_waits')
          .update({ status: 'fired', updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('status', 'waiting')
          .select('id')
          .maybeSingle()
        if (claimErr || !claimed) continue

        const { data: signalRow, error: sigErr } = await this.supabase
          .from('signals')
          .select('id,user_id,channel_id,parsed_data,user_override,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
          .eq('id', row.signal_id)
          .maybeSingle()
        if (sigErr || !signalRow || signalRow.status !== 'parsed') continue

        await logSignalRangeEntryFired(
          this.supabase,
          signalRow as SignalRow,
          row.broker_account_id,
          wait,
          row.symbol,
        )

        this.tradeExecutor.acceptDispatchSignal(
          { ...(signalRow as SignalRow), dispatch_source: 'signal_range_wake' },
          { source: 'signal_range_wake', priority: 'high' },
        )
      }
    }
  }
}
