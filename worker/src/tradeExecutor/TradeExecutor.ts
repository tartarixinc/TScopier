import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  hasFxsocketConfigured,
  FxsocketBrokerClient,
  mtPlatformFrom,
  MtOperation,
} from '../fxsocketClient'
import {
  clampPendingExpiryHours,
  resolvedParsedEntryPrice,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerResult,
  type VirtualPendingLeg,
} from '../manualPlanner'
import { normalizeManualSettingsForExecution } from '../manualPlanning/normalizeManualSettings'
import { resolveBrokerTotalBalance } from '../effectiveBrokerBalance'
import { withChannelTradingConfig, channelConfigReadyForExecution, resolveChannelTradingConfig, healChannelTradingConfigsMap, persistHealedChannelConfigs } from '../channelTradingConfig'
import {
  applyBrokerChannelTradingConfigRow,
  fetchBrokerChannelTradingConfigRows,
  mergeChannelTradingConfigsFromTable,
  type BrokerChannelTradingConfigRow,
} from '../brokerChannelTradingConfigs'
import {
  fetchBrokerForChannelWithLightConfigCache,
  LightConfigCache,
} from '../lightConfigCache'
import { manualDispatchAlreadyMaterialized } from './basketMerge/helpers'
import { claimSignalBrokerDispatch, releaseSignalBrokerDispatchClaim, shouldTakeOverStaleClaim } from './signalBrokerDispatchClaim'
import { hasActiveSignalRangeEntryWait, SIGNAL_RANGE_WAKE_DISPATCH_SOURCE } from '../signalRangeEntryHelpers'
import { MESSAGE_REVISION_DISPATCH_SOURCE } from '../signalRevision'
import {
  dispatchPriorityForAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../tradeSignalActions'
import { workerConfig, userBelongsToShard } from '../workerConfig'
import type { MgmtExecOptions, MgmtExecResult } from '../mgmtExecOptions'
import {
  applyShardToQuery,
  hasWorkOnShard,
  startMonitorLoop,
  type MonitorLoopHandle,
} from '../monitorIdleGate'
import { isPendingEntryRow } from '../signalEntryPendingHelpers'
import { isTscopierComment } from '../tscopierComment'
import type { BasketMergeLinkContext } from '../signalMergeLink'
import type { UserSessionManager } from '../sessionManager'
import {
  type MergeModifySummary,
} from '../multiTradeMerge'
import {
  type BasketOpenLeg,
} from '../basketSlTpReconcile'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { replayParsedSignalsForBroker } from '../brokerSignalReplay'
import { listenerLeaseRecoveryTick } from '../listenerSignalReplay'
import { normalizeChannelUuid } from '../channelTradingConfig'
import { normalizeCopyLimitState, type CopyLimitState } from '../copyLimitTypes'
import {
  buildPipelineCorrelation,
  emitPipelineEvent,
  parsePipelineTimestamps,
  setPipelineTimestamp,
} from '../pipelineTimestamps'
import { invalidateChannelParseCache } from '../channelKeywordsCache'
import { buildRangeLayerTriggerMap } from '../manualPlanning/rangeLayerTriggers'
import {
  brokerHasLinkedSession,
  brokerOrderOpenMs,
  brokerSessionUuid,
  roundLot,
  triggerPriceFor,
  virtualPendingTriggerAllowed,
} from './helpers'
import {
  BROKER_SESSION_HEARTBEAT_MS,
  EXECUTOR_PARSED_SWEEP_MS,
  EXECUTOR_REPLAY_MAX_AGE_MS,
  EXECUTOR_SWEEP_IDLE_MS,
  PARSED_STATUSES,
  SYMBOL_CACHE_KEEPALIVE_MS,
  type BrokerRow,
  type MergeOutcome,
  type ParsedSignal,
  type QueuedSignal,
  type RangePendingCancelScope,
  type SendOrderOutcome,
  type SignalRow,
  type SymbolCacheEntry,
  type SymbolListCacheEntry,
} from './types'
import * as brokerSymbolCache from './brokerSymbolCache'
import * as dispatch from './dispatch'
import * as basketMerge from './basketMerge'
import * as managementExecutor from './managementExecutor'
import { runSingleEntry } from './singleEntryExecutor'
import { runRangeEntry } from './rangeTradeExecutor'
import {
  applyCopierPauseProfileUpdate,
  primeCopierPauseCache,
} from '../copierPause'
import { captureDeferredBusinessFailure } from '../observability/deferredBusinessEvents'
import { safeBuildMgmtSweepExhaustionPayload } from '../managementBreakevenDiagnostics'
import { getTradeExecutionMonitor, tradeOutcomeIsSuccess } from '../observability/tradeExecutionMonitor'
import { testFlagEnabled } from '../testFlags'
import { apiForBrokerAccount } from '../providerResolver'

export type { SignalRow } from './types'

/** Parsed-signal sweep guard for management signals: at most one re-dispatch per
 *  MIN_MS and finalize after MAX consecutive failed re-dispatches, so a
 *  dead-ticket retry loop (e.g. `unknown ticket`) cannot hammer the broker on
 *  every sweep tick for the whole replay window. */
const MGMT_SWEEP_REDISPATCH_MIN_MS = Math.max(
  1_000,
  Number(process.env.MGMT_SWEEP_REDISPATCH_MIN_MS ?? 10_000),
)
const MGMT_SWEEP_MAX_REDISPATCHES = Math.max(
  1,
  Math.min(20, Number(process.env.MGMT_SWEEP_MAX_REDISPATCHES ?? 5)),
)

export class TradeExecutor {
  private sweepLoop: MonitorLoopHandle | null = null
  /** Cancels TScopier broker pendings past `pending_expiry_hours` (1–24) when env enabled. */
  private brokerPendingSweepTimer: NodeJS.Timeout | null = null
  private sessionHeartbeatTimer: NodeJS.Timeout | null = null
  private sessionHeartbeatInFlight = false
  private sessionHeartbeatSkipped = 0
  private symbolCacheKeepaliveTimer: NodeJS.Timeout | null = null
  private signalsChannel: RealtimeChannel | null = null
  private brokersChannel: RealtimeChannel | null = null
  private channelTradingConfigsChannel: RealtimeChannel | null = null
  private channelsChannel: RealtimeChannel | null = null
  private userProfilesChannel: RealtimeChannel | null = null
  brokersByUser = new Map<string, BrokerRow[]>()
  brokersById = new Map<string, BrokerRow>()
  inflight = new Set<string>()
  /** Prevents overlapping sendOrder for the same signal+broker (live-fast race). */
  private entryBrokerInflight = new Set<string>()
  queuedIds = new Set<string>()
  highPriorityQueue: QueuedSignal[] = []
  normalPriorityQueue: QueuedSignal[] = []
  queueDrainScheduled = false
  queueDraining = false
  /** Per-signal sweep guard for management signals: last re-dispatch time + count. */
  private mgmtSweepLastDispatch = new Map<string, number>()
  private mgmtSweepDispatchCount = new Map<string, number>()
  symbolCache = new Map<string, SymbolCacheEntry>()
  /** Per-broker `/Symbols` cache used to map signal symbols (e.g. BTCUSD) to broker variants (BTCUSDm). */
  symbolListCache = new Map<string, SymbolListCacheEntry>()
  /** Cached channel rows keyed by `telegram_channels.id` — refreshed on demand. */
  channelMetaCache = new Map<string, {
    keywords: ChannelKeywords | null
    commentSlug: string | null
    loadedAt: number
  }>()
  readonly lightConfigCache = new LightConfigCache()
  sessionPingAt = new Map<string, number>()
  /** Coalesce concurrent session checks per MT uuid (burst fan-out). */
  sessionCheckInflight = new Map<string, Promise<boolean>>()
  /** Coalesce concurrent /Symbols fetches per MT uuid. */
  symbolListInflight = new Map<string, Promise<SymbolListCacheEntry | null>>()
  /** Coalesce concurrent /SymbolParams fetches per `${uuid}:${symbol}` key. */
  symbolParamsInflight = new Map<string, Promise<SymbolCacheEntry | null>>()
  /** After OrderSend "Not connected", block re-trading until user reconnects. */
  sessionOrderBlocked = new Set<string>()
  /** Dedupe concurrent message-revision dispatches (in-process + HTTP push). */
  private processedRevisionEdits = new Map<string, number>()
  /**
   * Per-broker "last reactivated" wall time. Set whenever `is_active` flips
   * to true (including the initial load when the broker is already active).
   * Signals whose `created_at` is older than this timestamp are treated as
   * stale-after-outage and skipped, so the 5-minute sweep can't fire trades
   * that piled up while the broker was disabled.
   */
  brokerActivatedAt = new Map<string, number>()
  userTimezoneById = new Map<string, string>()
  private copyLimitStateCache = new Map<string, { state: CopyLimitState; at: number }>()
  constructor(
    readonly supabase: SupabaseClient,
    readonly sessionManager?: UserSessionManager,
  ) {
    if (!hasFxsocketConfigured()) {
      console.warn('[tradeExecutor] MT4API_BASIC_USER/PASSWORD missing — trade execution disabled.')
    }
  }

  apiFor(broker: BrokerRow): FxsocketBrokerClient | null {
    return apiForBrokerAccount(broker.provider, brokerSessionUuid(broker))
  }

  apiForUuid(uuid: string): FxsocketBrokerClient | null {
    for (const b of this.brokersById.values()) {
      const sessionId = brokerSessionUuid(b)
      if (sessionId === uuid) return this.apiFor(b)
    }
    console.error(`[tradeExecutor] apiForUuid: unknown broker uuid=${uuid}`)
    return null
  }

  async start() {
    await this.loadBrokers()
    this.subscribeSignals()
    this.subscribeBrokers()
    this.subscribeChannelTradingConfigs()
    this.subscribeChannelKeywords()
    this.subscribeUserProfilesCopierPause()
    const replaySince = () =>
      new Date(Date.now() - EXECUTOR_REPLAY_MAX_AGE_MS).toISOString()
    this.sweepLoop = startMonitorLoop({
      name: 'tradeExecutorSweep',
      supabase: this.supabase,
      activeIntervalMs: EXECUTOR_PARSED_SWEEP_MS,
      idleIntervalMs: EXECUTOR_SWEEP_IDLE_MS,
      hasWork: sb =>
        hasWorkOnShard(sb, 'signals', q =>
          q.eq('status', 'parsed').gte('created_at', replaySince()),
        ),
      tick: () => this.sweep(),
    })
    this.brokerPendingSweepTimer = setInterval(() => {
      this.sweepExpiredTscopierBrokerPendings().catch(err =>
        console.error('[tradeExecutor] broker pending TTL sweep failed:', err),
      )
    }, 5 * 60_000)
    this.brokerPendingSweepTimer.unref?.()
    console.log(
      `[tradeExecutor] started mode=${workerConfig.tradeExecutorMode} role=${workerConfig.role}`
      + ` realtime=${workerConfig.tradeExecutorRealtime}`,
    )
    if (String(process.env.WORKER_LEGACY_PENDING_CLEANUP ?? '').toLowerCase() === 'true') {
      this.cleanupLegacyBrokerPendings().catch(err =>
        console.error('[tradeExecutor] legacy pending cleanup failed:', err),
      )
    }
    void this.prewarmBrokerCaches()
    if (workerConfig.runsBrokerSessionHeartbeat) {
      this.sessionHeartbeatTimer = setInterval(() => {
        void this.runSessionHeartbeatTick()
      }, BROKER_SESSION_HEARTBEAT_MS)
      this.sessionHeartbeatTimer.unref?.()
    } else {
      console.log(
        '[tradeExecutor] broker session background heartbeat disabled'
        + ' (FxSocket REST is stateless; set BROKER_SESSION_BACKGROUND_HEARTBEAT=true to re-enable)',
      )
    }
    // Re-fetch every cached symbol list / params entry before its TTL expires
    // so the live-entry hot path always finds a warm cache. Without this,
    // signal symbols outside `symbol_to_trade` fall back to a cold broker
    // round-trip (~1.5s) each time and inflate `send_order_prep_ms`.
    this.symbolCacheKeepaliveTimer = setInterval(() => {
      void this.symbolCacheKeepaliveTick()
    }, SYMBOL_CACHE_KEEPALIVE_MS)
    this.symbolCacheKeepaliveTimer.unref?.()
  }

  stop() {
    this.sweepLoop?.stop()
    this.sweepLoop = null
    if (this.brokerPendingSweepTimer) clearInterval(this.brokerPendingSweepTimer)
    this.brokerPendingSweepTimer = null
    if (this.sessionHeartbeatTimer) clearInterval(this.sessionHeartbeatTimer)
    this.sessionHeartbeatTimer = null
    if (this.symbolCacheKeepaliveTimer) clearInterval(this.symbolCacheKeepaliveTimer)
    this.symbolCacheKeepaliveTimer = null
    if (this.signalsChannel) { void this.supabase.removeChannel(this.signalsChannel); this.signalsChannel = null }
    if (this.brokersChannel) { void this.supabase.removeChannel(this.brokersChannel); this.brokersChannel = null }
    if (this.channelTradingConfigsChannel) {
      void this.supabase.removeChannel(this.channelTradingConfigsChannel)
      this.channelTradingConfigsChannel = null
    }
    if (this.channelsChannel) { void this.supabase.removeChannel(this.channelsChannel); this.channelsChannel = null }
    if (this.userProfilesChannel) {
      void this.supabase.removeChannel(this.userProfilesChannel)
      this.userProfilesChannel = null
    }
  }

  // ── caches ────────────────────────────────────────────────────────────

  private normalizeBrokerRow(row: BrokerRow): BrokerRow {
    const healedConfigs = healChannelTradingConfigsMap(row)
    const accountBalance = resolveBrokerTotalBalance(row) || null
    const normalizedConfigs: Record<string, unknown> = {}
    for (const [channelId, cfg] of Object.entries(healedConfigs)) {
      normalizedConfigs[channelId] = {
        ...cfg,
        manual_settings: normalizeManualSettingsForExecution(cfg.manual_settings, {
          accountBalance,
        }) as Record<string, unknown>,
      }
    }
    const sessionId = brokerSessionUuid(row)
    return {
      ...row,
      metaapi_account_id: sessionId ?? row.metaapi_account_id,
      manual_settings: normalizeManualSettingsForExecution(row.manual_settings, {
        accountBalance,
      }) as Record<string, unknown>,
      channel_trading_configs: normalizedConfigs,
    }
  }

  getSweepLoopHandle(): MonitorLoopHandle | null {
    return this.sweepLoop
  }

  private async loadBrokers() {
    const brokersQ = await applyShardToQuery(
      this.supabase,
      this.supabase.from('broker_accounts').select('*').or('mtapi_session_id.neq.,fxsocket_account_id.neq.,metaapi_account_id.neq.'),
    )
    if (!brokersQ) {
      this.brokersByUser.clear()
      this.brokersById.clear()
      return
    }
    const { data, error } = await brokersQ
    if (error) {
      console.error('[tradeExecutor] loadBrokers failed:', error.message)
      return
    }
    const brokerRows = (data ?? []) as BrokerRow[]
    const brokerIds = brokerRows.map(row => row.id)
    const tableConfigRows = await fetchBrokerChannelTradingConfigRows(this.supabase, brokerIds)
    const configsByBroker = new Map<string, typeof tableConfigRows>()
    for (const cfgRow of tableConfigRows) {
      const list = configsByBroker.get(cfgRow.broker_account_id) ?? []
      list.push(cfgRow)
      configsByBroker.set(cfgRow.broker_account_id, list)
    }
    this.brokersByUser.clear()
    this.brokersById.clear()
    this.brokerActivatedAt.clear()
    this.userTimezoneById.clear()
    const userIds = [...new Set(brokerRows.map(r => r.user_id).filter(Boolean))]
    if (userIds.length) {
      const { data: profiles } = await this.supabase
        .from('user_profiles')
        .select('user_id,timezone,copier_paused')
        .in('user_id', userIds)
      primeCopierPauseCache(profiles ?? [])
      for (const p of profiles ?? []) {
        const uid = String((p as { user_id?: string }).user_id ?? '')
        const tz = String((p as { timezone?: string }).timezone ?? 'UTC').trim() || 'UTC'
        if (uid) this.userTimezoneById.set(uid, tz)
      }
    }
    for (const row of brokerRows) {
      if (!brokerHasLinkedSession(row)) continue
      const tableRows = configsByBroker.get(row.id) ?? []
      const mergedRow = tableRows.length
        ? {
            ...row,
            channel_trading_configs: mergeChannelTradingConfigsFromTable(
              row.channel_trading_configs,
              tableRows,
            ),
          }
        : row
      const normalized = this.normalizeBrokerRow(mergedRow)
      void persistHealedChannelConfigs(
        this.supabase,
        row.user_id,
        row.id,
        mergedRow.channel_trading_configs,
        normalized.channel_trading_configs as Record<string, unknown>,
      )
      this.brokersById.set(row.id, normalized)
      if (normalized.is_active) {
        const arr = this.brokersByUser.get(row.user_id) ?? []
        arr.push(normalized)
        this.brokersByUser.set(row.user_id, arr)
        this.trackBrokerActivation(normalized)
      }
    }
    for (const broker of this.brokersById.values()) {
      const sessionId = brokerSessionUuid(broker)
      const api = this.apiFor(broker)
      if (sessionId && api) api.seedPlatformCache(sessionId, mtPlatformFrom(broker.platform))
    }
    console.log(`[tradeExecutor] cached ${this.brokersById.size} broker accounts across ${this.brokersByUser.size} users`)
    const pingOnStart = String(process.env.BROKER_PING_ON_WORKER_START ?? 'true').toLowerCase()
    if (pingOnStart !== 'false' && pingOnStart !== '0') {
      await this.reconnectCachedBrokers()
    }
  }

  prewarmSymbolsEnabled(): boolean {
    return brokerSymbolCache.prewarmSymbolsEnabled(this)
  }

  async prewarmBrokerCaches(): Promise<void> {
    return await brokerSymbolCache.prewarmBrokerCaches(this)
  }

  async sessionHeartbeatTick(): Promise<void> {
    await brokerSymbolCache.sessionHeartbeatTick(this)
    await listenerLeaseRecoveryTick(this)
  }

  private async runSessionHeartbeatTick(): Promise<void> {
    if (this.sessionHeartbeatInFlight) {
      this.sessionHeartbeatSkipped += 1
      if (this.sessionHeartbeatSkipped <= 3 || this.sessionHeartbeatSkipped % 20 === 0) {
        console.warn(
          `[tradeExecutor] heartbeat tick skipped; previous sweep still running (skipped=${this.sessionHeartbeatSkipped})`,
        )
      }
      return
    }
    this.sessionHeartbeatInFlight = true
    try {
      await this.sessionHeartbeatTick()
    } finally {
      this.sessionHeartbeatInFlight = false
      this.sessionHeartbeatSkipped = 0
    }
  }

  /**
   * Re-fetch every entry currently in `symbolListCache` and `symbolCache` so
   * the next live signal hits a warm cache. Force-bypasses the TTL guard by
   * clearing `loadedAt`; the on-demand fetch will repopulate. Background
   * only — never blocks a signal.
   */
  async symbolCacheKeepaliveTick(): Promise<void> {
    return await brokerSymbolCache.symbolCacheKeepaliveTick(this)
  }

  async reconnectCachedBrokers() {
    return await brokerSymbolCache.reconnectCachedBrokers(this)
  }

  private applyBrokerCacheRow(row: BrokerRow) {
    const preNormalizedConfigs = row.channel_trading_configs
    const normalized = this.normalizeBrokerRow(row)
    void persistHealedChannelConfigs(
      this.supabase,
      row.user_id,
      row.id,
      preNormalizedConfigs,
      normalized.channel_trading_configs as Record<string, unknown>,
    )
    const sessionId = brokerSessionUuid(normalized)
    if (sessionId) this.apiFor(normalized)?.seedPlatformCache(sessionId, mtPlatformFrom(normalized.platform))
    const previous = this.brokersById.get(row.id)
    const wasSessionDown = Boolean(
      previous
      && (
        previous.connection_status === 'error'
        || this.sessionOrderBlocked.has(row.id)
      ),
    )
    this.brokersById.set(row.id, normalized)
    if (normalized.connection_status === 'connected') {
      this.sessionOrderBlocked.delete(row.id)
      if (wasSessionDown) {
        void replayParsedSignalsForBroker(this, normalized)
      }
    }
    this.trackBrokerActivation(normalized, previous)
    const userId = row.user_id
    const list = (this.brokersByUser.get(userId) ?? []).filter(b => b.id !== row.id)
    if (normalized.is_active) list.push(normalized)
    this.brokersByUser.set(userId, list)
    if (previous && previous.user_id !== userId) {
      const prev = (this.brokersByUser.get(previous.user_id) ?? []).filter(b => b.id !== row.id)
      this.brokersByUser.set(previous.user_id, prev)
    }
  }

  private async mergeBrokerRowWithTableConfigs(row: BrokerRow): Promise<BrokerRow> {
    const tableRows = await fetchBrokerChannelTradingConfigRows(this.supabase, [row.id])
    if (!tableRows.length) return row
    return {
      ...row,
      channel_trading_configs: mergeChannelTradingConfigsFromTable(
        row.channel_trading_configs,
        tableRows,
      ),
    }
  }

  private upsertBrokerCache(row: BrokerRow) {
    if (!userBelongsToShard(row.user_id)) return
    void this.mergeBrokerRowWithTableConfigs(row)
      .then(merged => this.applyBrokerCacheRow(merged))
      .catch(err => {
        console.error('[tradeExecutor] upsertBrokerCache table config merge failed:', err)
        this.applyBrokerCacheRow(row)
      })
  }

  private removeBrokerCache(id: string) {
    const row = this.brokersById.get(id)
    if (!row) return
    this.brokersById.delete(id)
    const list = (this.brokersByUser.get(row.user_id) ?? []).filter(b => b.id !== id)
    this.brokersByUser.set(row.user_id, list)
    this.brokerActivatedAt.delete(id)
  }

  lookupBroker(id: string): BrokerRow | undefined {
    return this.brokersById.get(id)
  }

  /**
   * Maintain `brokerActivatedAt` so the executor can reject signals that
   * pre-date a reactivation. Prefers the DB-persisted `last_activated_at`
   * column (set by the `broker_accounts_stamp_activated_at` trigger) so the
   * value survives worker restarts. Falls back to `Date.now()` if the row
   * lacks the field but is currently active.
   */
  private trackBrokerActivation(current: BrokerRow, previous?: BrokerRow): void {
    if (!current.is_active) return
    const dbStampMs = current.last_activated_at
      ? Date.parse(current.last_activated_at)
      : NaN
    if (Number.isFinite(dbStampMs)) {
      this.brokerActivatedAt.set(current.id, dbStampMs)
      return
    }
    // Trigger missing (e.g. older DB): treat any false→true flip as a fresh
    // activation and otherwise leave any existing memory value intact.
    if (previous && previous.is_active === false) {
      this.brokerActivatedAt.set(current.id, Date.now())
    } else if (!this.brokerActivatedAt.has(current.id)) {
      this.brokerActivatedAt.set(current.id, Date.now())
    }
  }

  /** True iff the signal was created AFTER this broker was last reactivated. */
  brokerEligibleForSignal(broker: BrokerRow, signal: SignalRow): boolean {
    return dispatch.brokerEligibleForSignal(this, broker, signal)
  }

  // ── realtime ──────────────────────────────────────────────────────────

  private subscribeSignals() {
    if (!workerConfig.tradeExecutorRealtime) {
      return
    }
    if (this.signalsChannel) return
    this.signalsChannel = this.supabase
      .channel('trade_executor_signals')
      .on(
        'postgres_changes' as never,
        { event: 'UPDATE', schema: 'public', table: 'signals' } as never,
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new as SignalRow | undefined
          if (!row) return
          if (!userBelongsToShard(row.user_id)) return
          if (!PARSED_STATUSES.has(row.status)) return
          this.acceptDispatchSignal(row, { source: 'realtime', priority: 'high' })
        },
      )
      .subscribe()
  }

  private subscribeBrokers() {
    if (this.brokersChannel) return
    this.brokersChannel = this.supabase
      .channel('trade_executor_brokers')
      .on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'broker_accounts' } as never,
        (payload: { eventType?: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const evt = payload.eventType
          if (evt === 'DELETE') {
            const id = (payload.old?.id ?? '') as string
            if (id) this.removeBrokerCache(id)
            return
          }
          const row = payload.new as BrokerRow | undefined
          if (!row) return
          if (!userBelongsToShard(row.user_id)) return
          if (!brokerHasLinkedSession(row)) {
            this.removeBrokerCache(row.id)
            return
          }
          this.upsertBrokerCache(row)
          if (row.is_active) {
            void this.pingBrokerSession(row)
          }
        },
      )
      .subscribe()
  }

  private subscribeUserProfilesCopierPause() {
    if (this.userProfilesChannel) return
    this.userProfilesChannel = this.supabase
      .channel('trade_executor_user_profiles_copier_pause')
      .on(
        'postgres_changes' as never,
        { event: 'UPDATE', schema: 'public', table: 'user_profiles' } as never,
        (payload: { new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const row = payload.new
          if (!row) return
          const userId = String(row.user_id ?? '')
          if (!userId || !userBelongsToShard(userId)) return
          const copierPaused = row.copier_paused === true
          const previousPaused = payload.old?.copier_paused === true
          applyCopierPauseProfileUpdate(userId, copierPaused, previousPaused)
        },
      )
      .subscribe()
  }

  private subscribeChannelTradingConfigs() {
    if (this.channelTradingConfigsChannel) return
    const invalidateConfigRow = (raw: Record<string, unknown> | undefined) => {
      const brokerId = String(raw?.broker_account_id ?? '')
      const channelId = String(raw?.channel_id ?? '')
      if (!brokerId || !channelId) return
      const cachedBroker = this.brokersById.get(brokerId)
      if (cachedBroker?.user_id) {
        this.lightConfigCache.invalidateExact({
          userId: cachedBroker.user_id,
          brokerAccountId: brokerId,
          channelId,
        })
        return
      }
      this.lightConfigCache.invalidateByBrokerChannel(brokerId, channelId)
    }
    this.channelTradingConfigsChannel = this.supabase
      .channel('trade_executor_broker_channel_configs')
      .on(
        'postgres_changes' as never,
        { event: '*', schema: 'public', table: 'broker_channel_trading_configs' } as never,
        (payload: {
          eventType?: string
          new?: Record<string, unknown>
          old?: Record<string, unknown>
        }) => {
          const evt = payload.eventType
          if (evt === 'DELETE') {
            const brokerId = String(payload.old?.broker_account_id ?? '')
            if (!brokerId) return
            invalidateConfigRow(payload.old)
            const cached = this.brokersById.get(brokerId)
            if (!cached) return
            void this.mergeBrokerRowWithTableConfigs(cached)
              .then(merged => this.applyBrokerCacheRow(merged))
              .catch(err => {
                console.error('[tradeExecutor] channel config delete refresh failed:', err)
              })
            return
          }
          if (evt === 'UPDATE') {
            invalidateConfigRow(payload.old)
          }
          const row = payload.new as BrokerChannelTradingConfigRow | undefined
          if (!row?.broker_account_id) return
          invalidateConfigRow(payload.new)
          const cached = this.brokersById.get(row.broker_account_id)
          if (!cached) return
          this.applyBrokerCacheRow(applyBrokerChannelTradingConfigRow(cached, row))
        },
      )
      .subscribe()
  }

  private subscribeChannelKeywords() {
    if (this.channelsChannel) return
    this.channelsChannel = this.supabase
      .channel('trade_executor_channels')
      .on(
        'postgres_changes' as never,
        { event: 'UPDATE', schema: 'public', table: 'telegram_channels' } as never,
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload.new as { id?: string; channel_keywords?: ChannelKeywords | null } | undefined
          if (!row?.id) return
          // Drop cache so the next signal refetches display name + keywords.
          this.channelMetaCache.delete(row.id)
          invalidateChannelParseCache(row.id)
        },
      )
      .subscribe()
  }

  private async sweep() {
    const since = new Date(Date.now() - EXECUTOR_REPLAY_MAX_AGE_MS).toISOString()
    const signalsQ = await applyShardToQuery(
      this.supabase,
      this.supabase
        .from('signals')
        .select(
          'id,user_id,channel_id,parsed_data,status,parent_signal_id,is_modification,created_at,telegram_message_id,reply_to_message_id',
        )
        .eq('status', 'parsed')
        .gte('created_at', since)
        .limit(50),
    )
    if (!signalsQ) return
    const { data } = await signalsQ
    for (const row of (data ?? []) as SignalRow[]) {
      if (this.inflight.has(row.id)) continue
      if (await hasActiveSignalRangeEntryWait(this.supabase, row.id)) continue
      if (await this.signalAlreadyHandled(row.id)) {
        await this.markSignalExecuted(row.id)
        continue
      }
      const action = parsedAction(row.parsed_data)
      if (isManagementAction(action) && !this.mgmtSweepAllowed(row.id)) continue
      this.acceptDispatchSignal(row, {
        source: 'sweep',
        priority: dispatchPriorityForAction(action),
      })
    }
  }

  /**
   * Sweep re-dispatch guard for parsed management signals: a failed mgmt action
   * leaves the signal 'parsed' for the reconcile fallback, so without a cap the
   * sweep re-dispatches it every tick (~3-4s) against a dead broker ticket
   * (e.g. `unknown ticket`) for the whole replay window. Allow at most one
   * re-dispatch per MGMT_SWEEP_REDISPATCH_MIN_MS and finalize after
   * MGMT_SWEEP_MAX_REDISPATCHES consecutive failures.
   */
  private mgmtSweepAllowed(signalId: string): boolean {
    const now = Date.now()
    const last = this.mgmtSweepLastDispatch.get(signalId) ?? 0
    if (now - last < MGMT_SWEEP_REDISPATCH_MIN_MS) return false
    const count = this.mgmtSweepDispatchCount.get(signalId) ?? 0
    if (count >= MGMT_SWEEP_MAX_REDISPATCHES) {
      void this.finalizeStuckMgmtSignal(signalId)
      this.mgmtSweepLastDispatch.delete(signalId)
      this.mgmtSweepDispatchCount.delete(signalId)
      return false
    }
    this.mgmtSweepLastDispatch.set(signalId, now)
    this.mgmtSweepDispatchCount.set(signalId, count + 1)
    return true
  }

  /** Finalize a management signal the sweep gave up on (stays 'parsed' forever otherwise). */
  private async finalizeStuckMgmtSignal(signalId: string): Promise<void> {
    try {
      let userId: string | null = null
      let sourceLogs: Array<{ request_payload?: unknown }> = []
      try {
        const { data: signalRow } = await this.supabase
          .from('signals')
          .select('user_id')
          .eq('id', signalId)
          .maybeSingle()
        userId = typeof signalRow?.user_id === 'string' ? signalRow.user_id : null

        const { data: logs } = await this.supabase
          .from('trade_execution_logs')
          .select('request_payload')
          .eq('signal_id', signalId)
          .in('action', ['mgmt_breakeven', 'mgmt_partial_breakeven'])
          .eq('status', 'failed')
          .order('created_at', { ascending: false })
          .limit(20)
        sourceLogs = Array.isArray(logs) ? logs as Array<{ request_payload?: unknown }> : []
      } catch {
        // Diagnostic lookup is best-effort; sweep finalization must still proceed.
      }
      const exhaustionPayload = safeBuildMgmtSweepExhaustionPayload({ sourceLogs })
      await this.supabase
        .from('signals')
        .update({ status: 'executed', skip_reason: 'mgmt_sweep_max_redispatch' })
        .eq('id', signalId)
        .eq('status', 'parsed')
      if (userId) {
        try {
          await this.supabase.from('trade_execution_logs').insert({
            user_id: userId,
            signal_id: signalId,
            broker_account_id: null,
            action: 'mgmt_sweep_max_redispatch',
            status: 'skipped',
            request_payload: exhaustionPayload as unknown as Record<string, unknown>,
          })
        } catch {
          console.warn('[tradeExecutor] management breakeven sweep diagnostic insert skipped')
        }
      }
    } catch {
      // best-effort
    }
  }

  /**
   * HTTP push from listener (split deploy) or in-process callback after parse.
   */
  acceptDispatchSignal(
    row: SignalRow,
    opts?: { priority?: 'high' | 'normal'; source?: string },
  ): boolean {
    if (!PARSED_STATUSES.has(row.status)) return false
    if (!signalMatchesExecutorMode(row.parsed_data, workerConfig.tradeExecutorMode)) {
      return false
    }
    const source = opts?.source ?? row.dispatch_source ?? 'dispatch'
    if (this.isDuplicateRevisionDispatch(row, source)) return true
    const receivedAt = Date.now()
    const pipeline_ts = setPipelineTimestamp(
      parsePipelineTimestamps(row.pipeline_ts) ?? {},
      'queue_consumed_at',
      receivedAt,
    )
    const rowWithTs: SignalRow = {
      ...row,
      pipeline_ts,
    }
    emitPipelineEvent({
      event: 'execution_input_received',
      correlation: buildPipelineCorrelation({
        userId: row.user_id,
        signalId: row.id,
        channelId: row.channel_id,
        telegramMessageId: row.telegram_message_id,
        dispatchSource: source,
      }),
      timestamps: pipeline_ts,
      outcome: 'accepted',
      path: source,
      extra: { priority: opts?.priority ?? null },
    })
    // Start broker caches warming the instant we accept dispatch — even before
    // we know which brokers will actually trade this signal. With SWR caches
    // this is sub-ms for warm symbols and starts the broker round-trip
    // immediately for cold ones, so sendOrder's Promise.all is mostly a
    // cache hit by the time it runs.
    this.prewarmForDispatch(rowWithTs)
    const entryFast = this.shouldUseEntryFastPath(rowWithTs)
    const mgmtFast = dispatch.shouldUseMgmtFastPath(rowWithTs, source)
    const useFastPath = entryFast || mgmtFast
    if (entryFast) this.kickLiveEntryPrewarm(rowWithTs)
    const listenerTs = parsePipelineTimestamps(rowWithTs.pipeline_ts)
    if (
      source === 'listener_push'
      && !listenerTs?.t_listener_received
    ) {
      console.warn(
        `[tradeExecutor] listener_push missing pipeline_ts listener stamps signal=${row.id}`
        + ' — redeploy listener service (LISTENER_INLINE_PARSE + pipeline_ts on dispatch)',
      )
    }
    if (!useFastPath) {
      void this.logPipelineStage(rowWithTs, 'dispatch_received', { source, priority: opts?.priority ?? null })
    }

    if (useFastPath) {
      if (this.inflight.has(row.id) || this.queuedIds.has(row.id)) return true
      void this.handleSignal(rowWithTs, {
        liveDispatch: true,
        dispatchSource: source,
        dispatchReceivedAt: receivedAt,
        lightIdempotency: true,
      })
      return true
    }

    this.enqueueSignal(rowWithTs, {
      liveDispatch: true,
      priority: opts?.priority,
      source,
      dispatchReceivedAt: receivedAt,
    })
    return true
  }

  /**
   * Redis Streams consumer path: await execution before XACK (at-least-once safety).
   * Bypasses the in-process priority queue — the stream is the queue.
   */
  async acceptDispatchSignalAwait(
    row: SignalRow,
    opts?: { priority?: 'high' | 'normal'; source?: string; wakeBrokerAccountId?: string },
  ): Promise<boolean> {
    if (!PARSED_STATUSES.has(row.status)) return false
    if (!signalMatchesExecutorMode(row.parsed_data, workerConfig.tradeExecutorMode)) {
      return false
    }
    const source = opts?.source ?? row.dispatch_source ?? 'queue'
    if (this.isDuplicateRevisionDispatch(row, source)) return true
    const isRangeWake = source === SIGNAL_RANGE_WAKE_DISPATCH_SOURCE
    const receivedAt = Date.now()
    const pipeline_ts = setPipelineTimestamp(
      parsePipelineTimestamps(row.pipeline_ts) ?? {},
      'queue_consumed_at',
      receivedAt,
    )
    const rowWithTs: SignalRow = {
      ...row,
      pipeline_ts,
    }
    emitPipelineEvent({
      event: 'execution_input_received',
      correlation: buildPipelineCorrelation({
        userId: row.user_id,
        signalId: row.id,
        channelId: row.channel_id,
        telegramMessageId: row.telegram_message_id,
        dispatchSource: source,
        brokerAccountId: opts?.wakeBrokerAccountId ?? row.wake_broker_account_id,
      }),
      timestamps: pipeline_ts,
      outcome: 'accepted',
      path: source,
      extra: { priority: opts?.priority ?? null },
    })
    this.prewarmForDispatch(rowWithTs)
    const entryFast = isRangeWake || this.shouldUseEntryFastPath(rowWithTs)
    const mgmtFast = dispatch.shouldUseMgmtFastPath(rowWithTs, source)
    const useFastPath = entryFast || mgmtFast
    if (entryFast) this.kickLiveEntryPrewarm(rowWithTs)

    if (!useFastPath) {
      await this.logPipelineStage(rowWithTs, 'dispatch_received', { source, priority: opts?.priority ?? null })
    }

    if (this.inflight.has(row.id)) {
      if (source === MESSAGE_REVISION_DISPATCH_SOURCE) {
        await dispatch.waitForSignalInflightClear(
          this,
          row.id,
          dispatch.revisionInflightWaitMs(rowWithTs, source),
        )
      } else if (!isRangeWake) {
        return true
      } else {
        await dispatch.waitForSignalInflightClear(this, row.id, 15_000)
      }
    }

    await this.handleSignal(rowWithTs, {
      liveDispatch: true,
      dispatchSource: source,
      dispatchReceivedAt: receivedAt,
      lightIdempotency: useFastPath || isRangeWake,
      wakeBrokerAccountId: opts?.wakeBrokerAccountId ?? row.wake_broker_account_id,
    })
    return true
  }

  /**
   * In-process fast path (monolith). Live buy/sell bypass the queue when role allows.
   */
  dispatchParsedSignal(row: SignalRow): boolean {
    return this.acceptDispatchSignal(row, {
      priority: dispatchPriorityForAction(parsedAction(row.parsed_data)),
      source: row.dispatch_source ?? 'in_process',
    })
  }

  private isDuplicateRevisionDispatch(row: SignalRow, source: string): boolean {
    const revisionSource = source === MESSAGE_REVISION_DISPATCH_SOURCE
      || row.dispatch_source === MESSAGE_REVISION_DISPATCH_SOURCE
    if (!revisionSource) return false
    const edit = row.telegram_edit_date_seen
    if (edit == null || edit <= 0) return false
    const key = `${row.id}|${Math.floor(edit)}`
    const now = Date.now()
    const seenAt = this.processedRevisionEdits.get(key)
    if (seenAt != null && now - seenAt < 120_000) return true
    this.processedRevisionEdits.set(key, now)
    if (this.processedRevisionEdits.size > 2000) {
      for (const [k, at] of this.processedRevisionEdits) {
        if (now - at > 120_000) this.processedRevisionEdits.delete(k)
      }
    }
    return false
  }

  shouldUseMgmtFastPath(row: SignalRow, source?: string): boolean {
    return dispatch.shouldUseMgmtFastPath(row, source)
  }

  shouldUseEntryFastPath(row: SignalRow): boolean {
    return dispatch.shouldUseEntryFastPath(this, row)
  }

  enqueueSignal(row: SignalRow,
    opts?: {
      liveDispatch?: boolean
      priority?: 'high' | 'normal'
      source?: string
      dispatchReceivedAt?: number
    },): void {
    return dispatch.enqueueSignal(this, row, opts)
  }

  scheduleQueueDrain(): void {
    return dispatch.scheduleQueueDrain(this)
  }

  dequeueQueuedSignal(): QueuedSignal | null {
    return dispatch.dequeueQueuedSignal(this)
  }

  async drainSignalQueues(): Promise<void> {
    return await dispatch.drainSignalQueues(this)
  }

  async logPipelineStage(signal: SignalRow,
    action: string,
    payload: Record<string, unknown>,): Promise<void> {
    return await dispatch.logPipelineStage(this, signal, action, payload)
  }

  /** Visible in Channel Worker when trade dispatch is skipped (no silent failures). */
  async logDispatchSkipped(signal: SignalRow,
    skipReason: string,
    extra?: Record<string, unknown>,): Promise<void> {
    return await dispatch.logDispatchSkipped(this, signal, skipReason, extra)
  }

  logPipelineSummaryBackground(signal: SignalRow,
    extra?: Record<string, unknown>,): void {
    return dispatch.logPipelineSummaryBackground(this, signal, extra)
  }

  async markSignalExecuted(signalId: string): Promise<void> {
    return await dispatch.markSignalExecuted(this, signalId)
  }

  /**
   * Live entry idempotency: must include virtual range ladder state, not only trades.
   * A re-dispatch while legs are still `pending` would insert duplicate rungs (fired
   * rows no longer block the partial unique index) and machine-gun market orders.
   */
  async signalLiveDispatchAlreadyHandled(signalId: string): Promise<boolean> {
    return await dispatch.signalLiveDispatchAlreadyHandled(this, signalId)
  }

  /** True when this signal row already drove execution (trades, virtuals, or success logs). */
  async signalAlreadyHandled(signalId: string): Promise<boolean> {
    return await dispatch.signalAlreadyHandled(this, signalId)
  }

  signalTooOldForReplay(row: SignalRow): boolean {
    return dispatch.signalTooOldForReplay(this, row)
  }

  // ── execution ─────────────────────────────────────────────────────────

  claimSignalExecution(signalId: string): boolean {
    return dispatch.claimSignalExecution(this, signalId)
  }

  async handleSignal(row: SignalRow,
    opts?: {
      liveDispatch?: boolean
      lightIdempotency?: boolean
      dispatchSource?: string
      dispatchReceivedAt?: number
      wakeBrokerAccountId?: string
    },) {
    return await dispatch.handleSignal(this, row, opts)
  }

  async getChannelMeta(channelId: string | null): Promise<{
    keywords: ChannelKeywords | null
    commentSlug: string | null
  }> {
    return await dispatch.getChannelMeta(this, channelId)
  }

  async hasOpenTradeForSymbol(brokerId: string, symbol: string): Promise<boolean> {
    return await basketMerge.hasOpenTradeForSymbol(this, brokerId, symbol)
  }

  /**
   * When DB shows open legs but /OpenedOrders has none of their tickets, close stale rows
   * so merge/modify paths do not block new OrderSend.
   */
  async reconcileGhostBasketLegs(args: {
    signal: SignalRow
    broker: BrokerRow
    uuid: string
    anchorSignalId: string
    symbol: string
    familyTrades: BasketOpenLeg[]
  }): Promise<{ isGhostBasket: boolean; closedCount: number }> {
    return await basketMerge.reconcileGhostBasketLegs(this, args)
  }

  /**
   * Walk `signals.parent_signal_id` from the merge row's immediate parent upward.
   * True if `anchorSignalId` appears (multi-hop Telegram reply threads where
   * `parent_signal_id` points at an intermediate signal, not the basket anchor).
   */
  async parentSignalIdChainContainsAnchor(startParentId: string | null | undefined,
    anchorSignalId: string,): Promise<boolean> {
    return await basketMerge.parentSignalIdChainContainsAnchor(this, startParentId, anchorSignalId)
  }

  /**
   * Resolve which `signals.id` owns open `trades` for management and implicit merge.
   * Walks `parent_signal_id` upward first; falls back to same-channel + symbol disambiguation.
   */
  async resolveBasketAnchorSignalIdForOpenTrades(args: {
    userId: string
    brokerAccountIds: string[]
    channelId: string | null
    parentSignalId: string | null
    symbolHint: string | null
  }): Promise<string | null> {
    return await basketMerge.resolveBasketAnchorSignalIdForOpenTrades(this, args)
  }

  async manualDispatchAlreadyMaterialized(signalId: string, brokerAccountId: string): Promise<boolean> {
    return await basketMerge.manualDispatchAlreadyMaterialized(this, signalId, brokerAccountId)
  }

  async cancelSignalEntryBrokerRowsForScope(scope: RangePendingCancelScope,
    userId: string,
    logSignalId: string,
    reason: string,): Promise<void> {
    return await basketMerge.cancelSignalEntryBrokerRowsForScope(this, scope, userId, logSignalId, reason)
  }

  async cancelRangePendingLegsForScopes(userId: string,
    logSignalId: string,
    scopes: RangePendingCancelScope[],
    reason: string,): Promise<void> {
    return await basketMerge.cancelRangePendingLegsForScopes(this, userId, logSignalId, scopes, reason)
  }

  /**
   * Persist virtual ladder rows. Batch `upsert` can fail against a partial unique
   * index if PostgREST's conflict target does not match Postgres; fall back to
   * per-row `insert` and treat duplicate-key as success (idempotent retries).
   */
  async persistRangePendingLegRows(rows: Record<string, unknown>[],
    context: string,): Promise<{ ok: boolean; lastError?: string }> {
    return await basketMerge.persistRangePendingLegRows(this, rows, context)
  }

  /**
   * Manual mode: when enabled, close every open trade on this symbol that faces
   * the opposite way from the **channel** buy/sell (before reverse / planner flip).
   */
  async closeOppositeDirectionTrades(signal: SignalRow,
    parsed: ParsedSignal,
    broker: BrokerRow,
    symbol: string,): Promise<void> {
    return await basketMerge.closeOppositeDirectionTrades(this, signal, parsed, broker, symbol)
  }

  /** Realtime payloads may omit reply/parent fields — load authoritative signal row for merge linking. */
  async loadMergeSignalForLinking(signal: SignalRow): Promise<SignalRow> {
    return await basketMerge.loadMergeSignalForLinking(this, signal)
  }

  async resolveBasketMergeLinkContext(args: {
    mergeSignal: SignalRow
    anchorSignalId: string
    newestTradeOpenedAt: string
    parsed: ParsedSignal
  }): Promise<BasketMergeLinkContext> {
    return await basketMerge.resolveBasketMergeLinkContext(this, args)
  }

  /**
   * Parameter follow-up (SL/TP on a linked prior entry): refresh the latest open basket.
   * Fresh one-shot entries with SL/TP skip this path and use OrderSend.
   */
  async tryParameterFollowUpMergeModifyOnly(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
    sameSignalRefresh?: boolean
    liveMgmtFast?: boolean
  }): Promise<MergeOutcome> {
    return await basketMerge.tryParameterFollowUpMergeModifyOnly(this, args)
  }

  async tryTeaserCompletionMerge(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
  }): Promise<MergeOutcome> {
    return await basketMerge.tryTeaserCompletionMerge(this, args)
  }

  /**
   * After parallel multi immediates, re-apply per-leg TPs (Targets %) in case the
   * broker accepted orders but normalized every leg to the same TP.
   */
  async syncMultiBasketLegTakeProfits(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    plan: PlannerResult
    symbol: string
    uuid: string
    params: SymbolCacheEntry | null
    manual: ManualSettings
    direction: 'buy' | 'sell'
  }): Promise<void> {
    return await basketMerge.syncMultiBasketLegTakeProfits(this, args)
  }

  /**
   * OrderModify every open leg in the basket + refresh range ladder rows. No OrderSend.
   */
  async applyBasketSlTpRefresh(args: {
    signal: SignalRow
    parsed: ParsedSignal
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
    anchorSignalId: string
    direction: 'buy' | 'sell'
    logAction: 'merge_routed_modify_only' | 'signal_merge_into_open_trade'
    sameSignalRefresh?: boolean
    liveMgmtFast?: boolean
    mergeLinkMeta?: Record<string, unknown>
  }): Promise<{ success: boolean; summary: MergeModifySummary }> {
    return await basketMerge.applyBasketSlTpRefresh(this, args)
  }

  /**
   * When `add_new_trades_to_existing` is on, apply a same-direction follow-up
   * (Telegram reply to the anchor entry, reply to a thread whose parent chain
   * reaches the anchor, or time window with direct `parent_signal_id` → anchor)
   * as SL/TP refresh on all open legs of the basket (`signal_id` family).
   */
  async tryMergeSignalIntoExistingOpenTrade(args: {
    signal: SignalRow
    parsed: ParsedSignal
    op: MtOperation
    broker: BrokerRow
    channelKeywords: ChannelKeywords | null
    baseLot: number
    params: SymbolCacheEntry | null
    symbol: string
    uuid: string
    strictEntryPrefetch: { bid: number; ask: number } | null
    commentPrefix: string
  }): Promise<MergeOutcome> {
    return await basketMerge.tryMergeSignalIntoExistingOpenTrade(this, args)
  }

  private async sweepExpiredTscopierBrokerPendings(): Promise<void> {
    if (!hasFxsocketConfigured()) return
    if (String(process.env.WORKER_BROKER_PENDING_EXPIRY_SWEEP ?? '').toLowerCase() !== 'true') return

    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && brokerHasLinkedSession(b) && (b.copier_mode ?? 'ai') === 'manual',
    )
    if (!brokers.length) return

    const now = Date.now()
    for (const broker of brokers) {
      const manual = (broker.manual_settings ?? {}) as ManualSettings
      const ttlH = clampPendingExpiryHours(manual.pending_expiry_hours)
      if (ttlH <= 0) continue
      const uuid = brokerSessionUuid(broker)!
      const api = this.apiFor(broker)
      if (!api) continue
      let orders: unknown[]
      try {
        orders = await api.openedOrders(uuid)
      } catch (err) {
        console.warn(`[tradeExecutor] TTL sweep /OpenedOrders failed broker=${broker.id}: ${(err as Error).message}`)
        continue
      }
      const cutoff = now - ttlH * 3600_000
      for (const raw of orders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const comment = String(o.comment ?? o.Comment ?? '')
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        // Only resting pendings — never market positions (string "Sell" / numeric 1).
        if (!isPendingEntryRow(o)) continue
        if (!isTscopierComment(comment)) continue
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        const openMs = brokerOrderOpenMs(o)
        if (openMs == null || openMs > cutoff) continue
        const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '')
        try {
          await api.orderClose(uuid, { ticket })
          console.log(
            `[tradeExecutor] TTL sweep closed ticket=${ticket} broker=${broker.id} op=${operation} ttl_hours=${ttlH}`,
          )
          try {
            await this.supabase.from('trade_execution_logs').insert({
              user_id: broker.user_id,
              broker_account_id: broker.id,
              action: 'pending_ttl_sweep_close',
              status: 'success',
              request_payload: { ticket, operation, ttl_hours: ttlH } as unknown as Record<string, unknown>,
            })
          } catch { /* best-effort */ }
        } catch (err) {
          console.warn(`[tradeExecutor] TTL sweep close failed ticket=${ticket} broker=${broker.id}: ${(err as Error).message}`)
        }
      }
    }
  }

  async markBrokerSessionDown(broker: BrokerRow, uuid: string, reason: string): Promise<void> {
    return await brokerSymbolCache.markBrokerSessionDown(this, broker, uuid, reason)
  }

  async pingBrokerSession(row: BrokerRow): Promise<void> {
    return await brokerSymbolCache.pingBrokerSession(this, row)
  }

  async ensureBrokerSession(api: FxsocketBrokerClient,
    uuid: string,
    broker: BrokerRow,
    opts?: { force?: boolean },): Promise<boolean> {
    return await brokerSymbolCache.ensureBrokerSession(this, api, uuid, broker, opts)
  }

  /** Live entry: CheckConnect only (not AccountSummary+OpenedOrders). Deduped per uuid. */
  async ensureBrokerSessionLiveFast(api: FxsocketBrokerClient,
    uuid: string,
    broker: BrokerRow,): Promise<boolean> {
    return await brokerSymbolCache.ensureBrokerSessionLiveFast(this, api, uuid, broker)
  }

  /**
   * Synchronous warm-cache check used to decide whether to block on prewarm.
   * Returns true only when every broker has a recent session ping AND both
   * the broker's symbol list and the requested symbol's params are cached.
   * Inflight-but-not-yet-resolved entries count as cold so we still kick
   * off prewarm (in the background).
   */
  brokersWarmForLiveEntry(brokers: BrokerRow[], signalSymbol: string): boolean {
    return brokerSymbolCache.brokersWarmForLiveEntry(this, brokers, signalSymbol)
  }

  /**
   * Fire-and-forget warm-up issued the instant a dispatch is accepted.
   * Touches `getSymbolParams` / `getSymbolList` for every broker that could
   * possibly handle the signal so by the time `sendOrder` runs the broker
   * round-trip is already in flight (or done). With SWR caches this is a
   * no-op for warm symbols.
   *
   * Scalability: bounded by `brokersByUser[userId].length`, which is the user's
   * own connected MT count. It does NOT scale with the total number of users
   * or channels in the system — every signal touches only its own user's
   * brokers.
   */
  prewarmForDispatch(row: SignalRow): void {
    return brokerSymbolCache.prewarmForDispatch(this, row)
  }

  /** Session + symbol cache warmup for channel-matched brokers on the live fast path. */
  private kickLiveEntryPrewarm(row: SignalRow): void {
    const parsed = row.parsed_data as PlannerParsedSignal | null
    const signalSymbol = parsed?.symbol?.trim()
    if (!signalSymbol) return
    const warmBrokers = (this.brokersByUser.get(row.user_id) ?? []).filter(b =>
      b.is_active && brokerHasLinkedSession(b) && channelMatchesBrokerSignal(b, row.channel_id),
    )
    if (warmBrokers.length > 0) {
      void this.prewarmBrokersForLiveEntry(warmBrokers, signalSymbol)
    }
  }

  /** Warm session + symbol caches once per live signal before OrderSend. */
  async prewarmBrokersForLiveEntry(brokers: BrokerRow[], signalSymbol: string): Promise<void> {
    return await brokerSymbolCache.prewarmBrokersForLiveEntry(this, brokers, signalSymbol)
  }

  async sendOrder(
    signal: SignalRow,
    parsed: ParsedSignal,
    op: MtOperation,
    broker: BrokerRow,
    channelKeywords: ChannelKeywords | null,
    pipelineT0?: number,
    sendOpts?: {
      liveEntryFast?: boolean
      liveMgmtFast?: boolean
      commentSlug?: string | null
      commentPrefix?: string
      sameSignalRefresh?: boolean
      /** When true, entry may refresh SL/TP but must not place new market/pending orders. */
      blockNewEntry?: boolean
    },
  ): Promise<SendOrderOutcome>  {
    const configReady = channelConfigReadyForExecution(broker, signal.channel_id)
    if (!configReady.ready) {
      console.warn(
        `[tradeExecutor] sendOrder blocked signal=${signal.id} broker=${broker.id}`
        + ` channel=${signal.channel_id ?? 'none'} reason=${configReady.reason}`,
      )
      await this.logSendSkipped(signal, broker, configReady.reason, {
        channel_id: signal.channel_id ?? null,
      })
      return { openedOrMerged: false, finalizeSkipReason: configReady.reason }
    }

    let executionBroker = broker
    if (signal.channel_id) {
      // Production safety boundary: this light cache may wrap only the stable
      // broker_channel_trading_configs refresh. Claims, idempotency,
      // broker readiness, prices, order state, and kill switches stay live
      // below this point and must not be added to the cache.
      const fresh = await fetchBrokerForChannelWithLightConfigCache(
        this.lightConfigCache,
        this.supabase,
        broker,
        signal.channel_id,
      )
      if (fresh.channel_trading_configs !== broker.channel_trading_configs) {
        this.applyBrokerCacheRow(fresh)
        executionBroker = this.brokersById.get(broker.id) ?? fresh
      }
    }

    const effectiveBroker = withChannelTradingConfig(executionBroker, signal.channel_id) as BrokerRow
    const resolved = resolveChannelTradingConfig(executionBroker, signal.channel_id)
    const entryKey = `${signal.id}:${effectiveBroker.id}`
    const liveFast = sendOpts?.liveEntryFast === true

    const isRevisionRefresh = sendOpts?.sameSignalRefresh === true

    const isRangeWake = signal.dispatch_source === SIGNAL_RANGE_WAKE_DISPATCH_SOURCE

    // Message revisions must wait for an in-flight first entry, then never open a
    // second market/pending basket (live-fast previously skipped this probe).
    if (this.entryBrokerInflight.has(entryKey)) {
      if (isRevisionRefresh) {
        const deadline = Date.now() + 60_000
        while (this.entryBrokerInflight.has(entryKey) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } else {
        const materialized = await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)
        console.warn(
          `[tradeExecutor] skip duplicate in-flight sendOrder signal=${signal.id} broker=${effectiveBroker.id}`
          + ` materialized=${materialized}`,
        )
        emitPipelineEvent({
          event: 'execution_duplicate_prevented',
          correlation: buildPipelineCorrelation({
            userId: signal.user_id,
            signalId: signal.id,
            channelId: signal.channel_id,
            telegramMessageId: signal.telegram_message_id,
            brokerAccountId: effectiveBroker.id,
            dispatchSource: signal.dispatch_source,
          }),
          timestamps: signal.pipeline_ts,
          outcome: 'inflight',
          path: liveFast ? 'live_fast' : 'queued',
          extra: { materialized },
        })
        return { openedOrMerged: materialized }
      }
    }

    let alreadyMaterialized = false
    if (!liveFast || isRevisionRefresh) {
      alreadyMaterialized = await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)
      if (alreadyMaterialized && !isRevisionRefresh) {
        console.warn(
          `[tradeExecutor] skip already materialized signal=${signal.id} broker=${effectiveBroker.id}`,
        )
        return { openedOrMerged: true }
      }
    }

    const blockNewEntry = sendOpts?.blockNewEntry === true
      || (isRevisionRefresh && alreadyMaterialized)
    const effectiveSendOpts = blockNewEntry
      ? { ...sendOpts, sameSignalRefresh: true, blockNewEntry: true }
      : sendOpts

    this.entryBrokerInflight.add(entryKey)
    try {
      // SL/TP-only revision path must not take/require the entry claim.
      if (!blockNewEntry) {
        if (isRangeWake) {
          await releaseSignalBrokerDispatchClaim(this.supabase, signal.id, effectiveBroker.id)
        }
        setPipelineTimestamp(signal.pipeline_ts ?? (signal.pipeline_ts = {}), 'execution_claim_started_at', Date.now())
        let claimed = await claimSignalBrokerDispatch(
          this.supabase,
          signal.id,
          effectiveBroker.id,
          signal.user_id,
        )
        if (!claimed) {
          // Another worker won entry. Revisions may still refresh SL/TP once materialized.
          if (isRevisionRefresh) {
            const pollDeadline = Date.now() + 5_000
            while (Date.now() < pollDeadline) {
              if (await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)) {
                console.warn(
                  `[tradeExecutor] message revision claim lost — SL/TP only signal=${signal.id} broker=${effectiveBroker.id}`,
                )
                const revisionOnlyOpts = { ...sendOpts, sameSignalRefresh: true, blockNewEntry: true }
                const isManual = (effectiveBroker.copier_mode ?? 'ai') === 'manual'
                const manual = (effectiveBroker.manual_settings ?? {}) as ManualSettings
                if (isManual && manual.trade_style === 'multi') {
                  return await this.executeAndRecord(
                    () => runRangeEntry(this, {
                      signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0,
                      sendOpts: revisionOnlyOpts,
                    }),
                    effectiveBroker.id,
                  )
                }
                return await this.executeAndRecord(
                  () => runSingleEntry(this, {
                    signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0,
                    sendOpts: revisionOnlyOpts,
                  }),
                  effectiveBroker.id,
                )
              }
              await new Promise(resolve => setTimeout(resolve, 100))
            }
            // Nothing materialized: the original claim holder skipped without
            // opening (or crashed mid-dispatch). The edited signal must still be
            // able to execute — release the stale claim and take it over, unless
            // this worker still has the first entry running.
            if (shouldTakeOverStaleClaim({
              isRevisionRefresh: true,
              materialized: false,
              entryInFlight: this.entryBrokerInflight.has(entryKey),
            })) {
              await releaseSignalBrokerDispatchClaim(this.supabase, signal.id, effectiveBroker.id)
              claimed = await claimSignalBrokerDispatch(
                this.supabase,
                signal.id,
                effectiveBroker.id,
                signal.user_id,
              )
              if (claimed) {
                console.warn(
                  `[tradeExecutor] message revision took over stale dispatch claim signal=${signal.id} broker=${effectiveBroker.id}`,
                )
              }
            }
          }
          if (!claimed) {
            const materialized = await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)
            console.warn(
              `[tradeExecutor] skip duplicate dispatch claim signal=${signal.id} broker=${effectiveBroker.id}`
              + ` materialized=${materialized}`,
            )
            emitPipelineEvent({
              event: 'execution_claim_lost',
              correlation: buildPipelineCorrelation({
                userId: signal.user_id,
                signalId: signal.id,
                channelId: signal.channel_id,
                telegramMessageId: signal.telegram_message_id,
                brokerAccountId: effectiveBroker.id,
                dispatchSource: signal.dispatch_source,
              }),
              timestamps: signal.pipeline_ts,
              outcome: 'lost',
              path: liveFast ? 'live_fast' : 'queued',
              extra: { materialized },
            })
            return { openedOrMerged: materialized }
          }
        }
        setPipelineTimestamp(signal.pipeline_ts, 'execution_claim_acquired_at', Date.now())
        emitPipelineEvent({
          event: 'execution_claimed',
          correlation: buildPipelineCorrelation({
            userId: signal.user_id,
            signalId: signal.id,
            channelId: signal.channel_id,
            telegramMessageId: signal.telegram_message_id,
            brokerAccountId: effectiveBroker.id,
            dispatchSource: signal.dispatch_source,
          }),
          timestamps: signal.pipeline_ts,
          outcome: 'claimed',
          path: liveFast ? 'live_fast' : 'queued',
        })
      } else {
        console.warn(
          `[tradeExecutor] message revision block new entry signal=${signal.id} broker=${effectiveBroker.id}`,
        )
      }

      const ms = resolved.manual_settings as Record<string, unknown>
      console.log(
        `[tradeExecutor] sendOrder signal=${signal.id} broker=${effectiveBroker.id}`
        + ` channel=${signal.channel_id ?? 'none'} source=${resolved.config_source}`
        + ` style=${String(ms.trade_style ?? 'single')} fixed_lot=${String(ms.fixed_lot ?? 'missing')}`
        + ` range_trading=${ms.range_trading === true}`,
      )

      const isManual = (effectiveBroker.copier_mode ?? 'ai') === 'manual'
      const manual = (effectiveBroker.manual_settings ?? {}) as ManualSettings
      if (isManual && manual.trade_style === 'multi') {
        return await this.executeAndRecord(
          () => runRangeEntry(this, {
            signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0,
            sendOpts: effectiveSendOpts,
          }),
          effectiveBroker.id,
        )
      }
      return await this.executeAndRecord(
        () => runSingleEntry(this, {
          signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0,
          sendOpts: effectiveSendOpts,
        }),
        effectiveBroker.id,
      )
    } finally {
      this.entryBrokerInflight.delete(entryKey)
    }
  }

  /**
   * Runs a single/range entry execution and records the outcome (or a thrown
   * exception) to the trade-pipeline monitor, then returns the original outcome
   * or rethrows. Thrown exceptions are recorded as failures so a systemic
   * crash-loop outage is visible rather than masking the failure rate.
   */
  private async executeAndRecord(
    run: () => Promise<SendOrderOutcome>,
    brokerId: string,
  ): Promise<SendOrderOutcome> {
    try {
      const outcome = await run()
      this.recordTradeExecutionOutcome(brokerId, outcome)
      return outcome
    } catch (err) {
      getTradeExecutionMonitor().recordExecution(
        false,
        brokerId,
        err instanceof Error ? (err.name || 'EXECUTION_ERROR') : 'EXECUTION_ERROR',
      )
      throw err
    }
  }

  private recordTradeExecutionOutcome(brokerId: string, outcome: SendOrderOutcome): void {
    const forcedFailure = testFlagEnabled(process.env, 'TRADE_PIPELINE_TEST_FORCE_FAILURE')
    const succeeded = !forcedFailure && tradeOutcomeIsSuccess(outcome)
    getTradeExecutionMonitor().recordExecution(
      succeeded,
      brokerId,
      forcedFailure ? 'TEST_FORCED_TRADE_FAILURE' : outcome.failureReason,
    )
  }

  async logSendSkipped(signal: SignalRow,
    broker: BrokerRow,
    reason: string,
    extra: Record<string, unknown>,): Promise<void> {
    return await managementExecutor.logSendSkipped(this, signal, broker, reason, extra)
  }

  async skipMgmtSignal(signalId: string, reason: string): Promise<void> {
    return await managementExecutor.skipMgmtSignal(this, signalId, reason)
  }

  async applyManagement(
    signal: SignalRow,
    parsed: ParsedSignal,
    brokers: BrokerRow[],
    mgmtOpts?: MgmtExecOptions,
  ): Promise<MgmtExecResult> {
    return await managementExecutor.applyManagement(this, signal, parsed, brokers, mgmtOpts)
  }

  /**
   * Telegram "Close worse entries": close open basket legs whose entry is within
   * `close_worse_entries_pips` of the live quote at instruction time.
   */
  async applyCloseWorseEntriesInstruction(signal: SignalRow,
    parsed: ParsedSignal,
    rows: Array<{
      id: string
      broker_account_id: string
      metaapi_order_id: string | null
      symbol: string
      direction: string
      lot_size: number
      status: string
      entry_price: number | null
      cwe_close_price?: number | null
    }>,
    byBroker: Map<string, BrokerRow>,
    mgmtOpts?: MgmtExecOptions,
  ): Promise<MgmtExecResult> {
    return await managementExecutor.applyCloseWorseEntriesInstruction(this, signal, parsed, rows, byBroker, mgmtOpts)
  }

  /**
   * One-time cleanup of broker-side BuyLimit/SellLimit orders left over from
   * the pre-virtual-pendings era. Filters by our `TScopier:` comment prefix so
   * we never touch orders placed by the user manually or other systems.
   *
   * Gated by env flag `WORKER_LEGACY_PENDING_CLEANUP=true`. Safe to leave on
   * indefinitely — it becomes a no-op once the legacy pendings are gone.
   */
  private async cleanupLegacyBrokerPendings(): Promise<void> {
    if (!hasFxsocketConfigured()) return
    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && brokerHasLinkedSession(b),
    )
    if (!brokers.length) return
    console.log(`[tradeExecutor] legacy pending cleanup: scanning ${brokers.length} brokers...`)
    let totalClosed = 0
    let totalFailed = 0
    for (const broker of brokers) {
      const uuid = brokerSessionUuid(broker)!
      const api = this.apiFor(broker)
      if (!api) continue
      let orders: unknown[]
      try {
        orders = await api.openedOrders(uuid)
      } catch (err) {
        console.warn(`[tradeExecutor] legacy cleanup /OpenedOrders failed broker=${broker.id}: ${(err as Error).message}`)
        continue
      }
      for (const raw of orders ?? []) {
        if (!raw || typeof raw !== 'object') continue
        const o = raw as Record<string, unknown>
        const comment = String(o.comment ?? o.Comment ?? '')
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (!isPendingEntryRow(o)) continue
        if (!isTscopierComment(comment)) continue
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '')
        try {
          await api.orderClose(uuid, { ticket })
          totalClosed += 1
          console.log(`[tradeExecutor] legacy cleanup closed ticket=${ticket} broker=${broker.id} op=${operation}`)
          try {
            await this.supabase.from('trade_execution_logs').insert({
              user_id: broker.user_id,
              broker_account_id: broker.id,
              action: 'legacy_pending_cleanup_close',
              status: 'success',
              request_payload: { ticket, operation } as unknown as Record<string, unknown>,
            })
          } catch { /* best-effort */ }
        } catch (err) {
          totalFailed += 1
          console.warn(`[tradeExecutor] legacy cleanup close failed ticket=${ticket} broker=${broker.id}: ${(err as Error).message}`)
        }
      }
    }
    console.log(`[tradeExecutor] legacy pending cleanup done: closed=${totalClosed} failed=${totalFailed}`)
  }

  async getSymbolParams(uuid: string, symbol: string): Promise<SymbolCacheEntry | null> {
    return await brokerSymbolCache.getSymbolParams(this, uuid, symbol)
  }

  /**
   * Force-refresh a single symbol params entry. Coalesces concurrent callers
   * (background refreshers + live-path lookups) via `symbolParamsInflight` so
   * we never duplicate broker API calls for the same `(uuid, symbol)` pair.
   */
  async refreshSymbolParams(uuid: string,
    symbol: string,
    key?: string,): Promise<SymbolCacheEntry | null> {
    return await brokerSymbolCache.refreshSymbolParams(this, uuid, symbol, key)
  }

  /**
   * Load (and cache) the broker's full symbol list. Returns null if unavailable.
   * Stale-while-revalidate: live path returns the cached value immediately if
   * present and kicks off a background refresh when stale.
   */
  async getSymbolList(uuid: string): Promise<SymbolListCacheEntry | null> {
    return await brokerSymbolCache.getSymbolList(this, uuid)
  }

  async fetchSymbolList(uuid: string): Promise<SymbolListCacheEntry | null> {
    return await brokerSymbolCache.fetchSymbolList(this, uuid)
  }

  resolveBrokerSymbolFromInventory(
    inventory: SymbolListCacheEntry,
    requested: string,
    opts?: { userDecorated?: boolean },
  ): string {
    return brokerSymbolCache.resolveBrokerSymbolFromInventory(this, inventory, requested, opts)
  }

  async resolveBrokerSymbolForLiveEntry(
    uuid: string,
    requested: string,
    opts?: { userDecorated?: boolean },
  ): Promise<string> {
    return await brokerSymbolCache.resolveBrokerSymbolForLiveEntry(this, uuid, requested, opts)
  }

  async deferredVirtualPendingMaterialize(args: {
    signal: SignalRow
    broker: BrokerRow
    uuid: string
    api: FxsocketBrokerClient
    symbol: string
    virtualPendings: VirtualPendingLeg[]
    parsed: ParsedSignal
    plan: PlannerResult
    params: SymbolCacheEntry | null
    strictEntryPrefetch: { bid: number; ask: number } | null
    fillAnchor?: number | null
  }): Promise<void> {
    const {
      signal, broker, uuid, api, symbol, virtualPendings, parsed, plan, params, strictEntryPrefetch,
      fillAnchor,
    } = args
    let anchor: number | null = fillAnchor != null && fillAnchor > 0 ? fillAnchor : null
    let anchorSource: 'signal' | 'quote' | 'fill' | 'unknown' = anchor != null ? 'fill' : 'unknown'
    const parsedEntry = resolvedParsedEntryPrice(parsed)
    if (anchor == null && parsedEntry != null && parsedEntry > 0) {
      anchor = parsedEntry
      anchorSource = 'signal'
    }
    if (anchor == null) {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
        anchorSource = 'quote'
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[tradeExecutor] deferred virtual /Quote failed signal=${signal.id} broker=${broker.id}: ${msg}`,
        )
        return
      }
    }
    if (anchor == null || !Number.isFinite(anchor) || anchor <= 0) {
      console.warn(
        `[tradeExecutor] deferred virtual: no anchor signal=${signal.id} broker=${broker.id}`,
      )
      return
    }

    const digits = Math.max(0, Math.min(8, Number(params?.digits) || 5))
    const safe = Math.max(Number(params?.stopsLevel) || 0, Number(params?.freezeLevel) || 0)
    const zoneHi = safe > 0 ? anchor + (safe + 2) * (params?.point ?? 0) : null
    const zoneLo = safe > 0 ? anchor - (safe + 2) * (params?.point ?? 0) : null
    const signalRangeBoundary = plan.rangeLayering?.signalRangeBoundary ?? null
    const signalZoneLo = plan.rangeLayering?.signalZoneLo ?? null
    const signalZoneHi = plan.rangeLayering?.signalZoneHi ?? null
    const useSignalEntryRange = plan.rangeLayering?.useSignalEntryRange === true
    const triggerMap = buildRangeLayerTriggerMap({
      virtualPendings,
      anchor,
      digits,
      rangeLayering: plan.rangeLayering ?? null,
      pip: plan.pip ?? undefined,
    })
    const nowMs = Date.now()
    const insertRows: Record<string, unknown>[] = []
    for (const v of virtualPendings) {
      const triggerPrice = triggerMap.get(v.stepIdx) ?? triggerPriceFor(v, anchor, digits)
      if (!virtualPendingTriggerAllowed({
        triggerPrice,
        signalRangeBoundary,
        isBuy: v.isBuy,
        stopsZoneLo: zoneLo,
        stopsZoneHi: zoneHi,
        signalZoneLo,
        signalZoneHi,
        useSignalEntryRange,
      })) {
        continue
      }
      const expiresAt = v.expiryHours && v.expiryHours > 0
        ? new Date(nowMs + v.expiryHours * 60 * 60 * 1000).toISOString()
        : null
      insertRows.push({
        signal_id: signal.id,
        user_id: signal.user_id,
        broker_account_id: broker.id,
        metaapi_account_id: uuid,
        symbol,
        step_idx: v.stepIdx,
        is_buy: v.isBuy,
        volume: roundLot(v.volume, params),
        anchor_price: anchor,
        trigger_price: triggerPrice,
        stoploss: v.stoploss,
        takeprofit: v.takeprofit,
        slippage: v.slippage,
        comment: v.comment,
        expert_id: v.expertID ?? null,
        expires_at: expiresAt,
        status: 'pending',
        cwe_close_price: v.cweClosePrice ?? null,
      })
    }
    if (insertRows.length === 0) {
      console.warn(
        `[tradeExecutor] deferred virtual: all ${virtualPendings.length} legs filtered`
        + ` signal=${signal.id} broker=${broker.id} anchor=${anchor} anchor_source=${anchorSource}`,
      )
      return
    }
    const persist = await this.persistRangePendingLegRows(
      insertRows,
      `deferred live signal=${signal.id} broker=${broker.id}`,
    )
    if (!persist.ok) {
      console.error(
        `[tradeExecutor] deferred virtual persist failed signal=${signal.id} broker=${broker.id}: ${persist.lastError ?? 'unknown'}`,
      )
      captureDeferredBusinessFailure({
        category: 'layering',
        event: 'layering_materialization_failed',
        severity: 'error',
        reasonCode: 'DEFERRED_VIRTUAL_MATERIALIZATION_PERSIST_FAILED',
        message: 'Deferred virtual pending rows could not be persisted',
        userImpact: 'partial',
        operation: 'deferred_virtual_pending_materialize',
        err: persist.lastError ?? 'unknown',
        context: {
          user_id: signal.user_id,
          signal_id: signal.id,
          channel_id: signal.channel_id,
          broker_account_id: broker.id,
          symbol,
          side: plan.isBuy === false ? 'sell' : 'buy',
          execution_mechanism: 'virtual_pending_monitor',
          layering_mode: plan.rangeLayering?.rangeLayeringType ?? 'virtual_pending',
          extra: {
            targeted_count: insertRows.length,
            successful_count: 0,
            failed_count: insertRows.length,
            anchor_source: anchorSource,
          },
        },
      })
      return
    }
    console.log(
      `[tradeExecutor] deferred virtual pendings inserted=${insertRows.length} signal=${signal.id} broker=${broker.id} symbol=${symbol} anchor=${anchor} (${anchorSource})`,
    )
    try {
      await this.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'virtual_pending_inserted',
        status: 'success',
        request_payload: {
          rows: insertRows.length,
          anchor,
          anchorSource,
          symbol,
          stepIdxs: insertRows.map(r => r.step_idx),
          triggers: insertRows.map(r => r.trigger_price),
          range_layering: plan.rangeLayering ?? null,
          basket_leg_cap: plan.rangeLayering?.basketLegCap
            ?? (
              (plan.rangeLayering?.plannedImmediateLegs ?? 0)
              + (plan.rangeLayering?.activePendingLegs ?? insertRows.length)
            ),
          planned_immediate_legs: plan.rangeLayering?.plannedImmediateLegs ?? null,
          planned_range_legs: plan.rangeLayering?.activePendingLegs ?? insertRows.length,
          deferred: true,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* logging is best-effort */ }
  }

  /**
   * Map a generic symbol (e.g. 'BTCUSD') to the exact instrument name the broker
   * exposes (e.g. 'BTCUSDm', 'BTCUSD.r', 'BTCUSD_i'). Strategy:
   *   1. Honour an explicit manual mapping when one exists for this symbol.
   *   2. Fall back to fuzzy matching against `/Symbols` using common broker suffixes
   *      and prefix/suffix substitution. Picks the shortest match (closest variant).
   */
  async resolveBrokerSymbol(
    uuid: string,
    requested: string,
    opts?: { userDecorated?: boolean },
  ): Promise<string> {
    return await brokerSymbolCache.resolveBrokerSymbol(this, uuid, requested, opts)
  }

  async fetchCopyLimitState(brokerId: string, channelId: string): Promise<CopyLimitState> {
    const key = `${brokerId}:${normalizeChannelUuid(channelId) ?? channelId}`
    const hit = this.copyLimitStateCache.get(key)
    if (hit && Date.now() - hit.at < 20_000) return hit.state

    const channelKey = normalizeChannelUuid(channelId)
    if (!channelKey) return { paused_period_keys: [], periods: {} }

    const { data, error } = await this.supabase
      .from('broker_channel_trading_configs')
      .select('copy_limit_state')
      .eq('broker_account_id', brokerId)
      .eq('channel_id', channelKey)
      .maybeSingle()

    if (error) {
      console.warn(`[tradeExecutor] fetchCopyLimitState failed: ${error.message}`)
    }
    const state = normalizeCopyLimitState(
      (data as { copy_limit_state?: unknown } | null)?.copy_limit_state,
    )
    this.copyLimitStateCache.set(key, { state, at: Date.now() })
    return state
  }
}
