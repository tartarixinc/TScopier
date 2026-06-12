import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import {
  getMetatraderApi,
  hasMetatraderApiConfigured,
  isBrokerDisconnectedMessage,
  MT_SESSION_EXPIRED_HINT,
  mtPlatformFrom,
  MetatraderApiClient,
  MtOperation,
  normalizeSymbolParams,
  OrderSendArgs,
  SymbolParams,
} from '../metatraderapi'
import {
  clampPendingExpiryHours,
  parsedHasExplicitEntryAnchor,
  planManualOrders,
  resolvedParsedEntryPrice,
  resolvedParsedEntryZone,
  signalEntryPriceStrictEnabled,
  SKIP_REASON_SIGNAL_ENTRY_REQUIRED,
  strictSignalEntryQuoteAllowsImmediate,
  lastPositiveParsedTpPrice,
  type ChannelKeywords,
  type ManualSettings,
  type ParsedSignal as PlannerParsedSignal,
  type PlannerPartialTp,
  type PlannerResult,
  type VirtualPendingLeg,
} from '../manualPlanner'
import { normalizeManualSettingsForExecution } from '../manualPlanning/normalizeManualSettings'
import { normalizeChannelTradingConfigsMap, withChannelTradingConfig, channelConfigReadyForExecution, resolveChannelTradingConfig, healChannelTradingConfigsMap } from '../channelTradingConfig'
import {
  fetchBrokerChannelTradingConfigRows,
  mergeChannelTradingConfigsFromTable,
} from '../brokerChannelTradingConfigs'
import { manualDispatchAlreadyMaterialized } from './basketMerge/helpers'
import { claimSignalBrokerDispatch } from './signalBrokerDispatchClaim'
import { findActiveNewsBlackout } from '../newsTrading/blackout'
import { getCalendarEventsCached } from '../newsTrading/calendarProvider'
import { isNewsTradingEnabled } from '../newsTrading/settings'
import { autoManagementTradeSnapshot } from '../autoManagement'
import {
  referencePriceForDirection,
  cweInstructionGroupKey,
  parseCweInstructionGroupKey,
  selectTradesForCweInstruction,
} from '../closeWorseEntries'
import {
  dispatchPriorityForAction,
  isEntryAction,
  isManagementAction,
  parsedAction,
  signalMatchesExecutorMode,
} from '../tradeSignalActions'
import { workerConfig, userBelongsToShard } from '../workerConfig'
import { writeBrokerConnectionStatus } from '../brokerConnectionStatus'
import {
  applyShardToQuery,
  hasWorkOnShard,
  monitorActiveIntervalMs,
  monitorIdleIntervalMs,
  startMonitorLoop,
  type MonitorLoopHandle,
} from '../monitorIdleGate'
import {
  isChannelManagementBlocked,
  isOppositeSignalCloseBlocked,
  isPendingCancelBlocked,
  normalizeChannelMessageFiltersMap,
  type ChannelMessageFiltersMap,
} from '../channelMessageFilters'
import { signalPipPrice } from '../signalPip'
import { trailingTradeRowSnapshot } from '../trailingStop'
import { isPostgresDuplicateKeyError } from '../rangePendingLegPersist'
import { cancelSignalEntryRowAtBroker, type SignalEntryPendingRow } from '../signalEntryPendingHelpers'
import {
  computeBasketMergeLinkContext,
  type BasketMergeLinkContext,
  MERGE_IMPLICIT_CHANNEL_BUNDLE_MS,
} from '../signalMergeLink'
import type { UserSessionManager } from '../sessionManager'
import {
  buildPerLegStopTargets,
  legacyMergeLinkingEnabled,
  mergePlanImmediateOrders,
  resolveLatestOpenBasketAnchor,
  shouldRouteAsBasketParameterRefresh,
  type MergeModifySummary,
} from '../multiTradeMerge'
import { symbolsCompatibleForBasket } from '../basketModFollowUp'
import {
  classifyGhostBasketLegs,
  closeStaleOpenTrades,
  fetchOpenBrokerTickets,
  fetchOpenBrokerTicketsStrict,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
  markBasketReconcileDone,
  markBasketReconcileDoneForAnchor,
  runBasketLegModifies,
  upsertBasketReconcileJob,
  type BasketOpenLeg,
  type BasketSymbolParams,
} from '../basketSlTpReconcile'
import { syncRangePendingLadderOnBasketRefresh } from '../rangePendingLadderSync'
import { loadExistingRangeStepIndices } from '../rangePendingFireGuard'
import { channelMatchesBrokerSignal } from '../brokerChannelFilter'
import { replayParsedSignalsForBroker } from '../brokerSignalReplay'
import { normalizeChannelUuid } from '../channelTradingConfig'
import { normalizeCopyLimitState, type CopyLimitState } from '../copyLimitTypes'
import { takeProfitForLegIndex } from '../manualPlanning/tpBucketDistribution'
import {
  explicitMgmtSymbol,
  isReplyScopedManagement,
  loadOpenTradesForManagement,
  resolveChannelModifyTargets,
  type MgmtTradeRow,
} from '../managementScope'
import {
  applyChannelParamsToVirtualPendingList,
  estimateBasketTotalPlannedLegs,
  loadChannelActiveTradeParamsForSymbol,
  mergeParsedWithChannelParams,
  reapplyChannelParamsToPendingLegs,
  parsedSignalHasExplicitStops,
  shouldMergeChannelParamsForEntry,
  stripInvalidStopsForSide,
  symbolsForChannelParamsPersist,
  upsertChannelActiveTradeParams,
  type ChannelActiveTradeParams,
} from '../channelActiveTradeParams'
import {
  loadRangePendingLegsInMgmtScope,
  pendingLegsToCancelScopes,
  updateRangePendingLegsForManagement,
} from '../managementPendingLegs'
import { parsePipelineTimestamps, pipelineSummaryPayload, type PipelineTimestamps } from '../pipelineTimestamps'
import {
  buildTscopierCommentPrefix,
  resolveChannelLabelForComment,
  sanitizeChannelCommentSlug,
} from '../tradeComment'
import { applyPostFillFollowUp, type PostFillTradeLeg } from '../postFillFollowUp'
import { isBenignOrderModifyError } from '../orderModifyBenign'
import { invalidateChannelParseCache } from '../channelKeywordsCache'
import {
  applySymbolMapping,
  brokerOrderOpenMs,
  clampOrderStops,
  computeCweTp,
  computeLot,
  isBuySideOp,
  isExcluded,
  isMtUuid,
  operationFor,
  parseSymbolToTradeList,
  roundLot,
  triggerPriceFor,
  type Leg,
} from './helpers'
import {
  BROKER_SESSION_HEARTBEAT_MS,
  EXECUTION_LOG_ACTIONS_HANDLED,
  EXECUTOR_MAX_CONCURRENT_SIGNALS,
  EXECUTOR_PARSED_SWEEP_MS,
  EXECUTOR_REPLAY_MAX_AGE_MS,
  EXECUTOR_SWEEP_IDLE_MS,
  PARSED_STATUSES,
  SESSION_PING_MIN_INTERVAL_MS,
  SYMBOL_CACHE_KEEPALIVE_MS,
  SYMBOL_CACHE_STALE_MS,
  SYMBOL_CACHE_TTL_MS,
  SYMBOL_LIST_TTL_MS,
  telegramLiveTradeGateEnabled,
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

export type { SignalRow } from './types'

export class TradeExecutor {
  private sweepLoop: MonitorLoopHandle | null = null
  /** Cancels TSCopier broker pendings past `pending_expiry_hours` (1–24) when env enabled. */
  private brokerPendingSweepTimer: NodeJS.Timeout | null = null
  private sessionHeartbeatTimer: NodeJS.Timeout | null = null
  private sessionHeartbeatInFlight = false
  private sessionHeartbeatSkipped = 0
  private symbolCacheKeepaliveTimer: NodeJS.Timeout | null = null
  private signalsChannel: RealtimeChannel | null = null
  private brokersChannel: RealtimeChannel | null = null
  private channelsChannel: RealtimeChannel | null = null
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
  symbolCache = new Map<string, SymbolCacheEntry>()
  /** Per-broker `/Symbols` cache used to map signal symbols (e.g. BTCUSD) to broker variants (BTCUSDm). */
  symbolListCache = new Map<string, SymbolListCacheEntry>()
  /** Cached channel rows keyed by `telegram_channels.id` — refreshed on demand. */
  channelMetaCache = new Map<string, {
    keywords: ChannelKeywords | null
    commentSlug: string | null
    loadedAt: number
  }>()
  sessionPingAt = new Map<string, number>()
  /** Coalesce concurrent session checks per MT uuid (burst fan-out). */
  sessionCheckInflight = new Map<string, Promise<boolean>>()
  /** Coalesce concurrent /Symbols fetches per MT uuid. */
  symbolListInflight = new Map<string, Promise<SymbolListCacheEntry | null>>()
  /** Coalesce concurrent /SymbolParams fetches per `${uuid}:${symbol}` key. */
  symbolParamsInflight = new Map<string, Promise<SymbolCacheEntry | null>>()
  /** After OrderSend "Not connected", block re-trading until user reconnects. */
  sessionOrderBlocked = new Set<string>()
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
    if (!hasMetatraderApiConfigured()) {
      console.warn('[tradeExecutor] MT4API_BASIC_USER/PASSWORD missing — trade execution disabled.')
    }
  }

  apiFor(broker: BrokerRow): MetatraderApiClient | null {
    return getMetatraderApi(mtPlatformFrom(broker.platform))
  }

  apiForUuid(uuid: string): MetatraderApiClient | null {
    for (const b of this.brokersById.values()) {
      if (b.metaapi_account_id === uuid) return this.apiFor(b)
    }
    console.error(`[tradeExecutor] apiForUuid: unknown broker uuid=${uuid}`)
    return null
  }

  async start() {
    await this.loadBrokers()
    this.subscribeSignals()
    this.subscribeBrokers()
    this.subscribeChannelKeywords()
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
    this.sessionHeartbeatTimer = setInterval(() => {
      void this.runSessionHeartbeatTick()
    }, BROKER_SESSION_HEARTBEAT_MS)
    this.sessionHeartbeatTimer.unref?.()
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
    if (this.channelsChannel) { void this.supabase.removeChannel(this.channelsChannel); this.channelsChannel = null }
  }

  // ── caches ────────────────────────────────────────────────────────────

  private normalizeBrokerRow(row: BrokerRow): BrokerRow {
    const healedConfigs = healChannelTradingConfigsMap(row)
    const normalizedConfigs: Record<string, unknown> = {}
    for (const [channelId, cfg] of Object.entries(healedConfigs)) {
      normalizedConfigs[channelId] = {
        ...cfg,
        manual_settings: normalizeManualSettingsForExecution(cfg.manual_settings) as Record<string, unknown>,
      }
    }
    return {
      ...row,
      manual_settings: normalizeManualSettingsForExecution(row.manual_settings) as Record<string, unknown>,
      channel_trading_configs: normalizedConfigs,
    }
  }

  getSweepLoopHandle(): MonitorLoopHandle | null {
    return this.sweepLoop
  }

  private async loadBrokers() {
    const brokersQ = await applyShardToQuery(
      this.supabase,
      this.supabase.from('broker_accounts').select('*').not('metaapi_account_id', 'is', null),
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
        .select('user_id,timezone')
        .in('user_id', userIds)
      for (const p of profiles ?? []) {
        const uid = String((p as { user_id?: string }).user_id ?? '')
        const tz = String((p as { timezone?: string }).timezone ?? 'UTC').trim() || 'UTC'
        if (uid) this.userTimezoneById.set(uid, tz)
      }
    }
    for (const row of brokerRows) {
      if (!isMtUuid(row.metaapi_account_id)) continue
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
      this.brokersById.set(row.id, normalized)
      if (normalized.is_active) {
        const arr = this.brokersByUser.get(row.user_id) ?? []
        arr.push(normalized)
        this.brokersByUser.set(row.user_id, arr)
        this.trackBrokerActivation(normalized)
      }
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
    return await brokerSymbolCache.sessionHeartbeatTick(this)
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
    const normalized = this.normalizeBrokerRow(row)
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
          this.enqueueSignal(row, { source: 'realtime' })
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
          if (!isMtUuid(row.metaapi_account_id)) {
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
      if (await this.signalAlreadyHandled(row.id)) {
        await this.markSignalExecuted(row.id)
        continue
      }
      this.enqueueSignal(row, { source: 'sweep' })
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
    const source = opts?.source ?? 'dispatch'
    const receivedAt = Date.now()
    const rowWithTs: SignalRow = {
      ...row,
      pipeline_ts: {
        ...(parsePipelineTimestamps(row.pipeline_ts) ?? {}),
        t_dispatch_received: receivedAt,
      },
    }
    // Start broker caches warming the instant we accept dispatch — even before
    // we know which brokers will actually trade this signal. With SWR caches
    // this is sub-ms for warm symbols and starts the broker round-trip
    // immediately for cold ones, so sendOrder's Promise.all is mostly a
    // cache hit by the time it runs.
    this.prewarmForDispatch(rowWithTs)
    const entryFast = this.shouldUseEntryFastPath(rowWithTs)
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
    if (!entryFast) {
      void this.logPipelineStage(rowWithTs, 'dispatch_received', { source, priority: opts?.priority ?? null })
    }

    if (entryFast) {
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
    opts?: { priority?: 'high' | 'normal'; source?: string },
  ): Promise<boolean> {
    if (!PARSED_STATUSES.has(row.status)) return false
    if (!signalMatchesExecutorMode(row.parsed_data, workerConfig.tradeExecutorMode)) {
      return false
    }
    const source = opts?.source ?? 'queue'
    const receivedAt = Date.now()
    const rowWithTs: SignalRow = {
      ...row,
      pipeline_ts: {
        ...(parsePipelineTimestamps(row.pipeline_ts) ?? {}),
        t_dispatch_received: receivedAt,
      },
    }
    this.prewarmForDispatch(rowWithTs)
    const entryFast = this.shouldUseEntryFastPath(rowWithTs)
    if (entryFast) this.kickLiveEntryPrewarm(rowWithTs)

    if (!entryFast) {
      await this.logPipelineStage(rowWithTs, 'dispatch_received', { source, priority: opts?.priority ?? null })
    }

    if (this.inflight.has(row.id)) return true

    await this.handleSignal(rowWithTs, {
      liveDispatch: true,
      dispatchSource: source,
      dispatchReceivedAt: receivedAt,
      lightIdempotency: entryFast,
    })
    return true
  }

  /**
   * In-process fast path (monolith). Live buy/sell bypass the queue when role allows.
   */
  dispatchParsedSignal(row: SignalRow): boolean {
    return this.acceptDispatchSignal(row, {
      priority: dispatchPriorityForAction(parsedAction(row.parsed_data)),
      source: 'in_process',
    })
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
  }): Promise<MergeOutcome> {
    return await basketMerge.tryParameterFollowUpMergeModifyOnly(this, args)
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
    if (!hasMetatraderApiConfigured()) return
    if (String(process.env.WORKER_BROKER_PENDING_EXPIRY_SWEEP ?? '').toLowerCase() !== 'true') return

    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && isMtUuid(b.metaapi_account_id) && (b.copier_mode ?? 'ai') === 'manual',
    )
    if (!brokers.length) return

    const now = Date.now()
    for (const broker of brokers) {
      const manual = (broker.manual_settings ?? {}) as ManualSettings
      const ttlH = clampPendingExpiryHours(manual.pending_expiry_hours)
      if (ttlH <= 0) continue
      const uuid = broker.metaapi_account_id!
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
        const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '')
        const comment = String(o.comment ?? o.Comment ?? '')
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (!operation.includes('Limit') && !operation.includes('Stop')) continue
        if (!comment.startsWith('TSCopier:')) continue
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        const openMs = brokerOrderOpenMs(o)
        if (openMs == null || openMs > cutoff) continue
        try {
          await api.orderClose(uuid, { ticket })
          console.log(
            `[tradeExecutor] TTL sweep closed ticket=${ticket} broker=${broker.id} op=${operation} ttl_hours=${ttlH}`,
          )
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

  async ensureBrokerSession(api: MetatraderApiClient,
    uuid: string,
    broker: BrokerRow,
    opts?: { force?: boolean },): Promise<boolean> {
    return await brokerSymbolCache.ensureBrokerSession(this, api, uuid, broker, opts)
  }

  /** Live entry: CheckConnect only (not AccountSummary+OpenedOrders). Deduped per uuid. */
  async ensureBrokerSessionLiveFast(api: MetatraderApiClient,
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
      b.is_active && isMtUuid(b.metaapi_account_id) && channelMatchesBrokerSignal(b, row.channel_id),
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
    sendOpts?: { liveEntryFast?: boolean; commentPrefix?: string; sameSignalRefresh?: boolean },
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

    const effectiveBroker = withChannelTradingConfig(broker, signal.channel_id) as BrokerRow
    const resolved = resolveChannelTradingConfig(broker, signal.channel_id)
    const entryKey = `${signal.id}:${effectiveBroker.id}`
    const liveFast = sendOpts?.liveEntryFast === true

    if (!liveFast) {
      if (await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)) {
        console.warn(
          `[tradeExecutor] skip already materialized signal=${signal.id} broker=${effectiveBroker.id}`,
        )
        return { openedOrMerged: true }
      }
    }

    if (this.entryBrokerInflight.has(entryKey)) {
      const materialized = liveFast
        ? true
        : await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)
      console.warn(
        `[tradeExecutor] skip duplicate in-flight sendOrder signal=${signal.id} broker=${effectiveBroker.id}`
        + ` materialized=${materialized}`,
      )
      return { openedOrMerged: materialized }
    }
    this.entryBrokerInflight.add(entryKey)
    try {
      const claimed = await claimSignalBrokerDispatch(this.supabase, signal.id, effectiveBroker.id)
      if (!claimed) {
        const materialized = await manualDispatchAlreadyMaterialized(this, signal.id, effectiveBroker.id)
        console.warn(
          `[tradeExecutor] skip duplicate dispatch claim signal=${signal.id} broker=${effectiveBroker.id}`
          + ` materialized=${materialized}`,
        )
        return { openedOrMerged: materialized }
      }

      const ms = resolved.manual_settings as Record<string, unknown>
      console.log(
        `[tradeExecutor] sendOrder signal=${signal.id} broker=${effectiveBroker.id}`
        + ` channel=${signal.channel_id ?? 'none'} source=${resolved.config_source}`
        + ` style=${String(ms.trade_style ?? 'single')} fixed_lot=${String(ms.fixed_lot ?? 'missing')}`,
      )

      const isManual = (effectiveBroker.copier_mode ?? 'ai') === 'manual'
      const manual = (effectiveBroker.manual_settings ?? {}) as ManualSettings
      if (isManual && manual.trade_style === 'multi') {
        return await runRangeEntry(this, { signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0, sendOpts })
      }
      return await runSingleEntry(this, { signal, parsed, op, broker: effectiveBroker, channelKeywords, pipelineT0, sendOpts })
    } finally {
      this.entryBrokerInflight.delete(entryKey)
    }
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

  async applyManagement(signal: SignalRow, parsed: ParsedSignal, brokers: BrokerRow[]): Promise<void> {
    return await managementExecutor.applyManagement(this, signal, parsed, brokers)
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
    byBroker: Map<string, BrokerRow>,): Promise<void> {
    return await managementExecutor.applyCloseWorseEntriesInstruction(this, signal, parsed, rows, byBroker)
  }

  /**
   * One-time cleanup of broker-side BuyLimit/SellLimit orders left over from
   * the pre-virtual-pendings era. Filters by our `TSCopier:` comment prefix so
   * we never touch orders placed by the user manually or other systems.
   *
   * Gated by env flag `WORKER_LEGACY_PENDING_CLEANUP=true`. Safe to leave on
   * indefinitely — it becomes a no-op once the legacy pendings are gone.
   */
  private async cleanupLegacyBrokerPendings(): Promise<void> {
    if (!hasMetatraderApiConfigured()) return
    const brokers = Array.from(this.brokersById.values()).filter(b =>
      b.is_active && isMtUuid(b.metaapi_account_id),
    )
    if (!brokers.length) return
    console.log(`[tradeExecutor] legacy pending cleanup: scanning ${brokers.length} brokers...`)
    let totalClosed = 0
    let totalFailed = 0
    for (const broker of brokers) {
      const uuid = broker.metaapi_account_id!
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
        const operation = String(o.operation ?? o.Operation ?? o.type ?? o.Type ?? '')
        const comment = String(o.comment ?? o.Comment ?? '')
        const ticket = Number(o.ticket ?? o.Ticket ?? o.orderId ?? o.OrderID ?? 0)
        if (!operation.includes('Limit') && !operation.includes('Stop')) continue
        if (!comment.startsWith('TSCopier:')) continue
        if (!Number.isFinite(ticket) || ticket <= 0) continue
        try {
          await api.orderClose(uuid, { ticket })
          totalClosed += 1
          console.log(`[tradeExecutor] legacy cleanup closed ticket=${ticket} broker=${broker.id} op=${operation}`)
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
    api: MetatraderApiClient
    symbol: string
    virtualPendings: VirtualPendingLeg[]
    parsed: ParsedSignal
    plan: PlannerResult
    params: SymbolCacheEntry | null
    strictEntryPrefetch: { bid: number; ask: number } | null
  }): Promise<void> {
    const {
      signal, broker, uuid, api, symbol, virtualPendings, parsed, plan, params, strictEntryPrefetch,
    } = args
    let anchor: number | null = plan.anchor?.value ?? plan.strictEntry?.entryPrice ?? null
    const parsedEntry = resolvedParsedEntryPrice(parsed)
    if (parsedEntry != null && parsedEntry > 0) {
      anchor = parsedEntry
    } else {
      try {
        const q = strictEntryPrefetch ?? await api.quote(uuid, symbol)
        anchor = plan.isBuy === false ? q.bid : q.ask
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
    const nowMs = Date.now()
    const insertRows: Record<string, unknown>[] = []
    for (const v of virtualPendings) {
      const triggerPrice = triggerPriceFor(v, anchor, digits)
      if (zoneHi != null && zoneLo != null && triggerPrice > zoneLo && triggerPrice < zoneHi) {
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
    if (insertRows.length === 0) return
    const persist = await this.persistRangePendingLegRows(
      insertRows,
      `deferred live signal=${signal.id} broker=${broker.id}`,
    )
    if (!persist.ok) {
      console.error(
        `[tradeExecutor] deferred virtual persist failed signal=${signal.id} broker=${broker.id}: ${persist.lastError ?? 'unknown'}`,
      )
    }
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
