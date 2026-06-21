import type { SupabaseClient } from '@supabase/supabase-js'
import { hasFxsocketConfigured, normalizeSymbolParams } from './fxsocketClient'
import { pipCalculator } from './pipCalculator'
import type { ParsedSignal } from './manualPlanning/types'
import { apiForFxsocketAccount, loadPlatformByFxsocketId, type PlatformByFxsocketId } from './mtApiByAccount'
import { isUserCopierPausedCached, loadCachedUserCopierPaused } from './copierPause'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from './monitorIdleGate'
import { SIGNAL_RANGE_WAKE_DISPATCH_SOURCE, type SignalRangeEntryWaitRow } from './signalRangeEntryHelpers'
import {
  buildWaitFromParsed,
  cancelWaitWithLog,
  evaluatePreEntryStaleness,
  evaluateWakeEligibility,
  expireWait,
  syncWaitRow,
  waitRowToPlannerWait,
} from './signalRangeEntryService'
import type { TradeExecutor } from './tradeExecutor'
import type { SignalRow } from './tradeExecutor/types'
import { resolveChannelTradingConfig } from './channelTradingConfig'

const ACTIVE_MS = monitorActiveIntervalMs('SIGNAL_RANGE_ENTRY_TICK_MS', 1_000)
const IDLE_MS = monitorIdleIntervalMs('SIGNAL_RANGE_ENTRY_IDLE_MS', 15_000)

/**
 * Polls /Quote for virtual "Trade Signal Range Only" waits and re-dispatches when price
 * is inside the signal zone ± pip tolerance.
 */
export class SignalRangeEntryMonitor {
  private loop: MonitorLoopHandle | null = null
  private platformByUuid: PlatformByFxsocketId = new Map()
  private ticking = false
  private wakeInflight = new Set<string>()

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
    const rows = (data ?? []) as SignalRangeEntryWaitRow[]
    if (!rows.length) return

    this.platformByUuid = await loadPlatformByFxsocketId(
      this.supabase,
      rows.map(r => r.metaapi_account_id),
    )

    const now = Date.now()
    const active: SignalRangeEntryWaitRow[] = []
    for (const row of rows) {
      if (isUserCopierPausedCached(row.user_id) || await loadCachedUserCopierPaused(this.supabase, row.user_id)) {
        await cancelWaitWithLog(this.supabase, {
          waitId: row.id,
          signalId: row.signal_id,
          userId: row.user_id,
          brokerAccountId: row.broker_account_id,
          reason: 'copier_paused',
        })
        continue
      }
      if (row.expires_at && Date.parse(row.expires_at) <= now) {
        await expireWait(this.supabase, {
          waitId: row.id,
          signalId: row.signal_id,
          userId: row.user_id,
          brokerAccountId: row.broker_account_id,
          reason: 'expired_ttl',
          symbol: row.symbol,
        })
        continue
      }
      active.push(row)
    }
    if (!active.length) return

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
        if (this.wakeInflight.has(row.id)) continue

        const { data: signalRow, error: sigErr } = await this.supabase
          .from('signals')
          .select('id,user_id,channel_id,parsed_data,user_override,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id')
          .eq('id', row.signal_id)
          .maybeSingle()
        if (sigErr || !signalRow?.parsed_data || signalRow.status !== 'parsed') continue

        const parsed = signalRow.parsed_data as ParsedSignal
        const broker = this.tradeExecutor.lookupBroker(row.broker_account_id)
        let wait = waitRowToPlannerWait(row)
        if (broker) {
          const manual = resolveChannelTradingConfig(broker, signalRow.channel_id).manual_settings
          const syncResult = await syncWaitRow(this.supabase, {
            signal: signalRow as SignalRow,
            broker,
            uuid: row.metaapi_account_id,
            symbol: row.symbol,
            parsed,
            manual,
            preserveExpiresAt: true,
            logUpdates: true,
          })
          if (!syncResult.ok) continue
          const freshWait = buildWaitFromParsed({
            manual,
            parsed,
            isBuy: String(parsed.action ?? '').toLowerCase() !== 'sell',
          })
          if (freshWait) wait = freshWait
        }
        const stale = evaluatePreEntryStaleness({
          parsed,
          bid,
          ask,
          isBuy: row.is_buy,
        })
        if (stale.stale && stale.reason) {
          await expireWait(this.supabase, {
            waitId: row.id,
            signalId: row.signal_id,
            userId: row.user_id,
            brokerAccountId: row.broker_account_id,
            reason: stale.reason,
            symbol: row.symbol,
            bid,
            ask,
          })
          continue
        }

        if (!evaluateWakeEligibility({ wait, bid, ask, pipSize })) continue

        this.wakeInflight.add(row.id)
        try {
          const dispatched = await this.tradeExecutor.acceptDispatchSignalAwait(
            {
              ...(signalRow as SignalRow),
              dispatch_source: SIGNAL_RANGE_WAKE_DISPATCH_SOURCE,
              wake_broker_account_id: row.broker_account_id,
            },
            {
              source: SIGNAL_RANGE_WAKE_DISPATCH_SOURCE,
              priority: 'high',
              wakeBrokerAccountId: row.broker_account_id,
            },
          )
          if (!dispatched) {
            console.warn(
              `[signalRangeEntryMonitor] wake dispatch rejected signal=${row.signal_id} broker=${row.broker_account_id}`,
            )
          }
        } finally {
          this.wakeInflight.delete(row.id)
        }
      }
    }
  }
}
