import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerProvider, OrderSendArgs } from './brokerProvider'
import { authorityFromBrokerRow } from './brokerWriteAuthority'
import { apiForBrokerAccount } from './providerResolver'
import { rawOrderTicket } from './signalEntryPendingHelpers'
import {
  COPY_BROKER_COLUMNS,
  LEGACY_COPY_BROKER_COLUMNS,
  missingProviderIdColumn,
} from './copyShared/copyHelpers'
import {
  brokerErrorCode,
  commentsMatch,
  constrainedCopyVolume,
  finite,
  isDemo,
  normalizeSourcePosition,
  normalizeSourcePositions,
  sessionId,
  symbolLimits,
  type NormalizedSourcePosition,
} from './copyShared/copyHelpers'
import { getCalendarEventsCached } from './newsTrading/calendarProvider'
import {
  evaluateSocialCopyOpenFilters,
  type SocialCopyManualSettings,
} from './socialCopyFilters'
import {
  closeSocialCopySourceTrade,
  upsertSocialCopySourceTrade,
} from './socialCopySourceTrades'

export { normalizeSourcePosition, normalizeSourcePositions, constrainedCopyVolume }
export type { NormalizedSourcePosition }

type Json = Record<string, unknown>

/** Positions already opened by social/mirror copy engines — do not re-copy. */
export function isCopyEngineFillComment(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const row = raw as Json
  const comment = String(row.comment ?? row.Comment ?? row.clientOrderId ?? '').trim().toLowerCase()
  return comment.startsWith('sc:') || comment.startsWith('mc:')
}

export type SocialCopySubscriptionRow = {
  id: string
  source_id: string
  destination_broker_account_id: string
  sizing_mode: 'fixed_lot' | 'lot_multiplier' | 'equity_ratio'
  fixed_lot: number | null
  lot_multiplier: number
  max_lot: number
  max_daily_loss: number | null
  requested_account_mode: 'demo' | 'live'
  source_account_mode: 'demo' | 'live' | 'unknown'
  destination_account_mode: 'demo' | 'live' | 'unknown'
  execution_path: 'broker' | 'synthetic_simulation'
  symbol_map: Record<string, string> | null
  manual_settings: SocialCopyManualSettings | null
  status: 'pending' | 'active' | 'paused' | 'stopped' | 'error' | 'emergency_stopped'
  desired_status: 'active' | 'paused' | 'stopped'
  error_code: string | null
}

type BrokerRow = {
  id: string
  user_id: string
  provider: string | null
  platform: string
  is_active: boolean
  connection_status: string | null
  linked_account_type: string | null
  mtapi_session_id: string | null
  fxsocket_account_id: string | null
  metaapi_account_id: string | null
  ctrader_account_id: string | null
  writer_epoch: number | null
  provider_transition_state: string | null
}

type SourceRow = { id: string; broker_account_id: string; status: string; trader_user_id: string | null }
type MappingRow = {
  id: string
  source_ticket: string
  destination_ticket: string | null
  source_symbol: string
  destination_symbol: string
  source_side: 'buy' | 'sell'
  source_volume: number
  destination_volume: number
  source_stop_loss: number | null
  source_take_profit: number | null
  state: string
  broker_comment: string
  opened_at?: string | null
}

export type SocialCopyMonitorOptions = {
  workerId?: string
  executionEnabled?: boolean
  allowLive?: boolean
  syntheticSimulationEnabled?: boolean
  intervalMs?: number
  providerFor?: (row: BrokerRow, write: boolean) => BrokerProvider | null
}

export class SocialCopyMonitor {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly workerId: string
  private readonly executionEnabled: boolean
  private readonly allowLive: boolean
  private readonly syntheticSimulationEnabled: boolean
  private readonly intervalMs: number
  private readonly reconciling = new Set<string>()
  private readonly pokeQueued = new Set<string>()
  private pokeDraining = false

  constructor(private readonly supabase: SupabaseClient, private readonly options: SocialCopyMonitorOptions = {}) {
    this.workerId = options.workerId ?? `social-copy-${process.pid}`
    const migrationPreview = /supmsgcubipmmowrzoub/i.test(process.env.SUPABASE_URL ?? '')
    this.executionEnabled = options.executionEnabled
      ?? (/^(1|true|yes)$/i.test(process.env.SOCIAL_COPY_EXECUTION_ENABLED ?? '') || migrationPreview)
    this.allowLive = options.allowLive ?? /^(1|true|yes)$/i.test(process.env.SOCIAL_COPY_ALLOW_LIVE ?? '')
    this.syntheticSimulationEnabled = options.syntheticSimulationEnabled
      ?? (/^(1|true|yes)$/i.test(process.env.SOCIAL_COPY_SYNTHETIC_SIMULATION_ENABLED ?? '') || migrationPreview)
    this.intervalMs = Math.max(2_000, options.intervalMs ?? Number(process.env.SOCIAL_COPY_RECONCILE_MS ?? 10_000))
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.pokeQueued.clear()
  }

  /**
   * Immediate wake from MTAPI OnOrderUpdate for subscriptions whose published
   * source broker account matches. Falls back to the interval tick if this fails.
   */
  pokeSourceBrokerAccount(brokerAccountId: string): void {
    const id = String(brokerAccountId ?? '').trim()
    if (!id) return
    this.pokeQueued.add(id)
    void this.drainPokes()
  }

  private async drainPokes(): Promise<void> {
    if (this.pokeDraining) return
    this.pokeDraining = true
    try {
      while (this.pokeQueued.size > 0) {
        const ids = [...this.pokeQueued]
        this.pokeQueued.clear()
        for (const brokerAccountId of ids) {
          await this.reconcileSourceBrokerAccount(brokerAccountId).catch(error => {
            console.warn(
              `[social-copy] poke failed source=${brokerAccountId}:`,
              error instanceof Error ? error.message : String(error),
            )
          })
        }
      }
    } finally {
      this.pokeDraining = false
    }
  }

  private async reconcileSourceBrokerAccount(brokerAccountId: string): Promise<void> {
    const { data: sources, error: sourceError } = await this.supabase
      .from('social_copy_sources')
      .select('id')
      .eq('broker_account_id', brokerAccountId)
      .eq('status', 'published')
    if (sourceError) throw sourceError
    const sourceIds = (sources ?? []).map(row => String((row as { id: string }).id))
    if (sourceIds.length === 0) return

    const { data: rows, error } = await this.supabase
      .from('social_copy_subscriptions')
      .select('*')
      .in('source_id', sourceIds)
      .eq('desired_status', 'active')
      .in('status', ['pending', 'active', 'error'])
    if (error) throw error
    for (const row of (rows ?? []) as SocialCopySubscriptionRow[]) {
      await this.reconcileGuarded(row).catch(cause => this.failSubscription(row.id, brokerErrorCode(cause), cause))
    }
  }

  private async reconcileGuarded(row: SocialCopySubscriptionRow): Promise<void> {
    if (this.reconciling.has(row.id)) return
    this.reconciling.add(row.id)
    try {
      await this.reconcile(row)
    } finally {
      this.reconciling.delete(row.id)
    }
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { data, error } = await this.supabase.rpc('claim_social_copy_subscriptions', {
        p_worker: this.workerId, p_limit: 20, p_lease_seconds: Math.ceil(this.intervalMs / 1000) + 20,
      })
      if (error) throw error
      for (const row of (data ?? []) as SocialCopySubscriptionRow[]) {
        await this.reconcileGuarded(row).catch(error => this.failSubscription(row.id, brokerErrorCode(error), error))
      }
    } catch (error) {
      console.warn('[social-copy] claim failed:', error instanceof Error ? error.message : String(error))
    } finally {
      this.running = false
    }
  }

  private provider(row: BrokerRow, write: boolean): BrokerProvider | null {
    if (this.options.providerFor) return this.options.providerFor(row, write)
    const authority = write ? authorityFromBrokerRow(row) : null
    return apiForBrokerAccount(row.provider, sessionId(row), authority)
  }

  private async loadContext(subscription: SocialCopySubscriptionRow): Promise<{
    source: SourceRow; sourceBroker: BrokerRow; destinationBroker: BrokerRow
  }> {
    const sourceResult = await this.supabase.from('social_copy_sources')
      .select('id,broker_account_id,status,trader_user_id').eq('id', subscription.source_id).single()
    if (sourceResult.error || !sourceResult.data) throw new Error('SOURCE_UNAVAILABLE')
    const source = sourceResult.data as SourceRow
    const readBrokerAccounts = (columns: string) => Promise.all([
      this.supabase.from('broker_accounts').select(columns).eq('id', source.broker_account_id).single(),
      this.supabase.from('broker_accounts').select(columns).eq('id', subscription.destination_broker_account_id).single(),
    ])
    let [sourceBroker, destinationBroker] = await readBrokerAccounts(COPY_BROKER_COLUMNS)
    const readError = sourceBroker.error ?? destinationBroker.error
    if (readError && missingProviderIdColumn(readError.message)) {
      ;[sourceBroker, destinationBroker] = await readBrokerAccounts(LEGACY_COPY_BROKER_COLUMNS)
    }
    if (sourceBroker.error || !sourceBroker.data) throw new Error('SOURCE_ACCOUNT_UNAVAILABLE')
    if (destinationBroker.error || !destinationBroker.data) throw new Error('DESTINATION_UNAVAILABLE')
    return {
      source,
      sourceBroker: sourceBroker.data as unknown as BrokerRow,
      destinationBroker: destinationBroker.data as unknown as BrokerRow,
    }
  }

  private async reconcile(subscription: SocialCopySubscriptionRow): Promise<void> {
    if (subscription.desired_status === 'paused') {
      await this.patchSubscription(subscription.id, { status: 'paused', worker_acknowledged_at: new Date().toISOString(), last_reconciled_at: new Date().toISOString(), error_code: null, error_detail: null })
      return
    }
    const context = await this.loadContext(subscription)
    if (subscription.desired_status === 'stopped') {
      if (subscription.execution_path === 'broker') {
        await this.closeAll(subscription, context.destinationBroker)
      }
      const terminal = subscription.error_code === 'EMERGENCY_STOP_REQUESTED' ? 'emergency_stopped' : 'stopped'
      await this.patchSubscription(subscription.id, { status: terminal, stopped_at: new Date().toISOString(), last_reconciled_at: new Date().toISOString() })
      return
    }
    const { data: authorized, error: authorizationError } = await this.supabase.rpc(
      'check_social_copy_subscription_authorization', { p_subscription_id: subscription.id },
    )
    if (authorizationError || authorized !== true) throw new Error('SOCIAL_ACCESS_REVOKED')

    if (!this.executionEnabled) {
      // Leave the subscription runnable for a worker that has execution enabled.
      // Permanently erroring here blocked Migration preview copies whenever any
      // disabled replica claimed the lease.
      console.warn(`[social-copy] execution disabled; skipping ${subscription.id}`)
      await this.patchSubscription(subscription.id, { last_reconciled_at: new Date().toISOString() })
      return
    }
    const syntheticSimulation = subscription.execution_path === 'synthetic_simulation'
    if (syntheticSimulation) {
      if (!this.syntheticSimulationEnabled) {
        await this.failSubscription(subscription.id, 'SYNTHETIC_SIMULATION_DISABLED', new Error('Synthetic social copy simulation is disabled on this worker'))
        return
      }
      const event = await this.claimEvent(
        subscription.id,
        null,
        'synthetic-preview',
        'simulation',
        `simulation:${subscription.id}`,
        {
          source_account_mode: subscription.source_account_mode,
          destination_account_mode: subscription.destination_account_mode,
        },
      )
      if (event) {
        await this.finishEvent(event, 'succeeded', {
          simulated: true,
          broker_orders_created: 0,
        })
      }
      await this.patchSubscription(subscription.id, {
        status: 'active',
        worker_acknowledged_at: new Date().toISOString(),
        last_reconciled_at: new Date().toISOString(),
        error_code: null,
        error_detail: null,
      })
      return
    }
    if (subscription.max_daily_loss != null) {
      await this.failSubscription(subscription.id, 'MAX_DAILY_LOSS_UNAVAILABLE', new Error('Daily-loss enforcement is not available for social copy subscriptions'))
      return
    }
    if (context.source.status !== 'published') throw new Error('SOURCE_NOT_PUBLISHED')
    if (!context.sourceBroker.is_active || !context.destinationBroker.is_active) throw new Error('BROKER_DISCONNECTED')
    if (!sessionId(context.sourceBroker) || !sessionId(context.destinationBroker)) throw new Error('BROKER_SESSION_UNAVAILABLE')
    if ((!isDemo(context.sourceBroker) || !isDemo(context.destinationBroker)) && !this.allowLive) {
      await this.failSubscription(subscription.id, 'LIVE_EXECUTION_DISABLED', new Error('Only demo-to-demo social copying is enabled'))
      return
    }
    if (subscription.requested_account_mode !== subscription.destination_account_mode) {
      await this.failSubscription(subscription.id, 'ACCOUNT_MODE_MISMATCH', new Error('Requested mode does not match the captured destination mode'))
      return
    }
    const sourceApi = this.provider(context.sourceBroker, false)
    const destinationApi = this.provider(context.destinationBroker, true)
    if (!sourceApi || !destinationApi) throw new Error('UNSUPPORTED_PROVIDER')
    if (!await sourceApi.verifyTradingReady(sessionId(context.sourceBroker))) throw new Error('SOURCE_DISCONNECTED')
    if (!await destinationApi.verifyTradingReady(sessionId(context.destinationBroker))) throw new Error('DESTINATION_DISCONNECTED')

    const sourceRaw = await sourceApi.openedOrders(sessionId(context.sourceBroker))
    // Mirror every market position on the published source account. Skip fills
    // already written by social/mirror copy (`sc:` / `mc:` comments) so a
    // published destination is not re-copied as provider intent. Dedupe
    // order/position twin rows so one source fill cannot open two dest copies.
    const sourcePositions = normalizeSourcePositions(
      sourceRaw.filter(row => !isCopyEngineFillComment(row)),
    )
    const destinationOrders = await destinationApi.openedOrders(sessionId(context.destinationBroker))
    const { data: mappings, error } = await this.supabase.from('social_copy_trade_mappings').select('*')
      .eq('subscription_id', subscription.id).in('state', ['opening', 'open', 'closing', 'uncertain', 'error'])
    if (error) throw error
    const bySource = new Map(((mappings ?? []) as MappingRow[]).map(row => [row.source_ticket, row]))

    // Mirror live source positions into `trades` so Copier Logs / Social update
    // with the copy wake, not only the edge cron.
    const traderUserId = String(context.source.trader_user_id ?? context.sourceBroker.user_id ?? '').trim()
    if (traderUserId) {
      for (const position of sourcePositions) {
        await upsertSocialCopySourceTrade(this.supabase, {
          traderUserId,
          brokerAccountId: context.source.broker_account_id,
          position,
        }).catch(cause => {
          console.warn(
            `[social-copy] source trade upsert ${position.ticket} failed:`,
            cause instanceof Error ? cause.message : String(cause),
          )
        })
      }
    }

    // Dead opens (null destination) permanently blocked retries via the unique
    // (subscription_id, source_ticket) key. Clear error/opening rows while the
    // source ticket is still live so openPosition can rematerialize. Leave
    // `uncertain` alone — a broker fill may already exist (comment recovery).
    const liveTickets = new Set(sourcePositions.map(position => position.ticket))
    for (const [ticket, mapping] of [...bySource.entries()]) {
      if (mapping.destination_ticket) continue
      if (mapping.state !== 'error' && mapping.state !== 'opening') continue
      if (!liveTickets.has(ticket)) continue
      await this.supabase.from('social_copy_trade_mappings').delete().eq('id', mapping.id)
      bySource.delete(ticket)
    }

    for (const position of sourcePositions) {
      const mapping = bySource.get(position.ticket)
      try {
        if (!mapping) {
          // Defense in depth when OpenedOrders still yields two tickets for one
          // fill with divergent entry fields: do not open a second dest leg.
          const nearDuplicate = [...bySource.values()].some(row => {
            if (row.state === 'closed' || !row.destination_ticket) return false
            if (row.source_symbol !== position.symbol || row.source_side !== position.side) return false
            if (Math.abs(Number(row.source_volume) - position.volume) > 1e-8) return false
            const openedAt = row.opened_at ? Date.parse(row.opened_at) : NaN
            return Number.isFinite(openedAt) && Date.now() - openedAt < 120_000
          })
          if (nearDuplicate) continue
          await this.openPosition(subscription, context, destinationApi, destinationOrders, position)
        } else {
          await this.syncPosition(subscription, context.destinationBroker, destinationApi, destinationOrders, mapping, position)
        }
      } catch (error) {
        const code = brokerErrorCode(error)
        // Hard account/config failures still suspend; per-ticket broker errors do not.
        if (
          code === 'UNSUPPORTED_SYMBOL'
          || code === 'SYMBOL_LIMITS_UNAVAILABLE'
          || code === 'EQUITY_UNAVAILABLE'
          || code === 'SOURCE_DISCONNECTED'
          || code === 'DESTINATION_DISCONNECTED'
          || code === 'BROKER_DISCONNECTED'
        ) {
          throw error
        }
        console.warn(
          `[social-copy] position ${position.ticket} failed:`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    const openTickets = new Set(sourcePositions.map(position => position.ticket))
    for (const raw of sourceRaw) {
      if (isCopyEngineFillComment(raw)) continue
      if (normalizeSourcePosition(raw)) continue
      if (!raw || typeof raw !== 'object' || rawOrderTicket(raw as Json) <= 0) continue
      const ticket = String(rawOrderTicket(raw as Json))
      const event = await this.claimEvent(subscription.id, null, ticket, 'unsupported', `unsupported:${ticket}`, {})
      if (event) await this.finishEvent(event, 'skipped', {}, 'UNSUPPORTED_ORDER_TYPE', new Error('Only open market Buy/Sell positions are supported'))
    }
    for (const mapping of bySource.values()) {
      if (!openTickets.has(mapping.source_ticket) && mapping.state !== 'closed') {
        try {
          await this.closeMapping(subscription, context.destinationBroker, destinationApi, destinationOrders, mapping)
          if (traderUserId) {
            await closeSocialCopySourceTrade(
              this.supabase,
              context.source.broker_account_id,
              mapping.source_ticket,
            ).catch(cause => {
              console.warn(
                `[social-copy] source trade close ${mapping.source_ticket} failed:`,
                cause instanceof Error ? cause.message : String(cause),
              )
            })
          }
        } catch (error) {
          console.warn(
            `[social-copy] close ${mapping.source_ticket} failed:`,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }
    await this.patchSubscription(subscription.id, {
      status: 'active', worker_acknowledged_at: new Date().toISOString(), last_reconciled_at: new Date().toISOString(),
      error_code: null, error_detail: null,
    })
  }

  private async requestedVolume(subscription: SocialCopySubscriptionRow, context: { sourceBroker: BrokerRow; destinationBroker: BrokerRow }, position: NormalizedSourcePosition, api: BrokerProvider, symbol: string): Promise<number> {
    let requested = subscription.sizing_mode === 'fixed_lot'
      ? Number(subscription.fixed_lot)
      : position.volume * Number(subscription.lot_multiplier)
    if (subscription.sizing_mode === 'equity_ratio') {
      const [sourceSummary, destinationSummary] = await Promise.all([
        this.provider(context.sourceBroker, false)!.accountSummary(sessionId(context.sourceBroker)),
        api.accountSummary(sessionId(context.destinationBroker)),
      ])
      const sourceEquity = finite(sourceSummary.equity)
      const destinationEquity = finite(destinationSummary.equity)
      if (sourceEquity == null || sourceEquity <= 0 || destinationEquity == null || destinationEquity <= 0) throw new Error('EQUITY_UNAVAILABLE')
      requested = position.volume * (destinationEquity / sourceEquity) * Number(subscription.lot_multiplier)
    }
    const limits = symbolLimits(await api.symbolParams(sessionId(context.destinationBroker), symbol))
    if (!limits) throw new Error('SYMBOL_LIMITS_UNAVAILABLE')
    const constrained = constrainedCopyVolume(requested, limits, Number(subscription.max_lot))
    if (constrained == null) throw new Error('VOLUME_BELOW_MINIMUM')
    return constrained
  }

  private async openPosition(subscription: SocialCopySubscriptionRow, context: { sourceBroker: BrokerRow; destinationBroker: BrokerRow }, api: BrokerProvider, destinationOrders: unknown[], position: NormalizedSourcePosition): Promise<void> {
    const symbol = subscription.symbol_map?.[position.symbol] ?? position.symbol
    const newsEvents = await getCalendarEventsCached().catch(() => [])
    const filterSkip = evaluateSocialCopyOpenFilters({
      symbol,
      manualSettings: subscription.manual_settings,
      newsEvents,
    })
    if (filterSkip) {
      const event = await this.claimEvent(
        subscription.id,
        null,
        position.ticket,
        'open',
        `filter-skip:${filterSkip}:${position.ticket}`,
        { symbol, reason: filterSkip },
      )
      if (event) {
        await this.finishEvent(event, 'skipped', { symbol, reason: filterSkip }, filterSkip.toUpperCase(), new Error(`Social copy open skipped: ${filterSkip}`))
      }
      return
    }
    let volume: number
    try {
      volume = await this.requestedVolume(subscription, context, position, api, symbol)
    } catch (error) {
      // Undersized equity-ratio / multiplier opens must not suspend the whole
      // subscription — skip this ticket so later trades can still copy.
      if (brokerErrorCode(error) === 'VOLUME_BELOW_MINIMUM') {
        const event = await this.claimEvent(
          subscription.id,
          null,
          position.ticket,
          'open',
          `volume-skip:${position.ticket}`,
          { symbol, reason: 'VOLUME_BELOW_MINIMUM', sourceVolume: position.volume },
        )
        if (event) {
          await this.finishEvent(
            event,
            'skipped',
            { symbol, reason: 'VOLUME_BELOW_MINIMUM', sourceVolume: position.volume },
            'VOLUME_BELOW_MINIMUM',
            error,
          )
        }
        return
      }
      throw error
    }
    const comment = `sc:${subscription.id.slice(0, 8)}:${position.ticket}`.slice(0, 31)
    const { data: mappingData, error: mappingError } = await this.supabase.from('social_copy_trade_mappings').insert({
      subscription_id: subscription.id, source_ticket: position.ticket, source_symbol: position.symbol,
      destination_symbol: symbol, source_side: position.side, source_volume: position.volume,
      destination_volume: volume, source_stop_loss: position.stopLoss, source_take_profit: position.takeProfit,
      state: 'opening', broker_comment: comment,
    }).select('*').single()
    if (mappingError) {
      if (mappingError.code === '23505') return
      throw mappingError
    }
    const mapping = mappingData as MappingRow
    const existing = destinationOrders.find(row => commentsMatch(row, comment))
    if (existing) {
      await this.finalizeOpen(mapping, rawOrderTicket(existing as Json))
      return
    }
    const event = await this.claimEvent(subscription.id, mapping.id, position.ticket, 'open', `open:${position.ticket}`, { symbol, volume })
    if (!event) {
      await this.markMappingUncertain(mapping.id, 'DUPLICATE_OPEN_CLAIM', 'An earlier open attempt must be reconciled manually')
      throw new Error('DUPLICATE_OPEN_CLAIM')
    }
    const args: OrderSendArgs = {
      symbol, operation: position.side === 'buy' ? 'Buy' : 'Sell', volume,
      stoploss: position.stopLoss, takeprofit: position.takeProfit, comment,
    }
    try {
      const result = await api.orderSend(sessionId(context.destinationBroker), args)
      const ticket = result.positionTicket ?? result.ticket
      if (!(ticket > 0)) throw new Error('BROKER_TICKET_MISSING')
      await this.finalizeOpen(mapping, ticket)
      await this.finishEvent(event, 'succeeded', { ticket })
    } catch (error) {
      const snapshot = await api.openedOrders(sessionId(context.destinationBroker)).catch(() => [] as unknown[])
      const recovered = snapshot.find(row => commentsMatch(row, comment))
      if (recovered) {
        const ticket = rawOrderTicket(recovered as Json)
        await this.finalizeOpen(mapping, ticket)
        await this.finishEvent(event, 'succeeded', { ticket, recovered: true })
        return
      }
      await this.finishEvent(event, 'uncertain', {}, brokerErrorCode(error), error)
      await this.markMappingUncertain(mapping.id, brokerErrorCode(error), 'Open result is uncertain; automatic retry is blocked to prevent a duplicate order')
      throw error
    }
  }

  private async syncPosition(subscription: SocialCopySubscriptionRow, destination: BrokerRow, api: BrokerProvider, destinationOrders: unknown[], mapping: MappingRow, position: NormalizedSourcePosition): Promise<void> {
    if (mapping.state === 'opening' || mapping.state === 'uncertain') {
      const recovered = destinationOrders.find(row => commentsMatch(row, mapping.broker_comment))
      if (recovered) await this.finalizeOpen(mapping, rawOrderTicket(recovered as Json))
      else if (mapping.state === 'uncertain') return
    }
    if (!mapping.destination_ticket) return
    const volumeTolerance = Math.max(0.000001, mapping.source_volume * 0.0001)
    if (position.volume > mapping.source_volume + volumeTolerance) {
      throw new Error('SOURCE_VOLUME_INCREASE_UNSUPPORTED')
    }
    if (position.volume < mapping.source_volume - volumeTolerance) {
      const targetDestinationVolume = mapping.destination_volume * (position.volume / mapping.source_volume)
      const requestedClose = mapping.destination_volume - targetDestinationVolume
      const limits = symbolLimits(await api.symbolParams(sessionId(destination), mapping.destination_symbol))
      if (!limits) throw new Error('SYMBOL_LIMITS_UNAVAILABLE')
      const closeVolume = constrainedCopyVolume(requestedClose, limits, requestedClose)
      if (closeVolume == null || mapping.destination_volume - closeVolume < limits.min - 1e-10) {
        throw new Error('PARTIAL_CLOSE_BELOW_MINIMUM')
      }
      const key = `resize:${position.ticket}:${position.volume}`
      const event = await this.claimEvent(subscription.id, mapping.id, position.ticket, 'modify', key, { closeVolume })
      if (!event) throw new Error('DUPLICATE_MODIFY_CLAIM')
      try {
        await api.orderClose(sessionId(destination), { ticket: Number(mapping.destination_ticket), lots: closeVolume })
        mapping.destination_volume -= closeVolume
        mapping.source_volume = position.volume
        await this.supabase.from('social_copy_trade_mappings').update({
          source_volume: position.volume, destination_volume: mapping.destination_volume,
        }).eq('id', mapping.id)
        await this.finishEvent(event, 'succeeded', { closeVolume })
      } catch (error) {
        await this.finishEvent(event, 'uncertain', {}, brokerErrorCode(error), error)
        throw error
      }
    }

    if (mapping.source_stop_loss === position.stopLoss && mapping.source_take_profit === position.takeProfit) return
    const key = `modify:${position.ticket}:${position.stopLoss ?? 0}:${position.takeProfit ?? 0}`
    const event = await this.claimEvent(subscription.id, mapping.id, position.ticket, 'modify', key, { stopLoss: position.stopLoss, takeProfit: position.takeProfit })
    if (!event) return
    try {
      await api.orderModify(sessionId(destination), { ticket: Number(mapping.destination_ticket), stoploss: position.stopLoss, takeprofit: position.takeProfit })
      await this.supabase.from('social_copy_trade_mappings').update({ source_stop_loss: position.stopLoss, source_take_profit: position.takeProfit }).eq('id', mapping.id)
      await this.finishEvent(event, 'succeeded', {})
    } catch (error) {
      await this.finishEvent(event, 'failed', {}, brokerErrorCode(error), error)
      throw error
    }
  }

  private async closeMapping(subscription: SocialCopySubscriptionRow, destination: BrokerRow, api: BrokerProvider, destinationOrders: unknown[], mapping: MappingRow): Promise<void> {
    let ticket = Number(mapping.destination_ticket)
    if (!(ticket > 0)) {
      const recovered = destinationOrders.find(row => commentsMatch(row, mapping.broker_comment))
      if (!recovered) {
        await this.supabase.from('social_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
        return
      }
      ticket = rawOrderTicket(recovered as Json)
      await this.finalizeOpen(mapping, ticket)
    }
    if (!destinationOrders.some(row => rawOrderTicket(row as Json) === ticket)) {
      await this.supabase.from('social_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
      return
    }
    const event = await this.claimEvent(subscription.id, mapping.id, mapping.source_ticket, 'close', `close:${mapping.source_ticket}`, { ticket })
    if (!event) throw new Error('DUPLICATE_CLOSE_CLAIM')
    try {
      await api.orderClose(sessionId(destination), { ticket })
      await this.supabase.from('social_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
      await this.finishEvent(event, 'succeeded', {})
    } catch (error) {
      const after = await api.openedOrders(sessionId(destination)).catch(() => destinationOrders)
      if (!after.some(row => rawOrderTicket(row as Json) === ticket)) {
        await this.supabase.from('social_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
        await this.finishEvent(event, 'succeeded', { recovered: true })
        return
      }
      await this.finishEvent(event, 'uncertain', {}, brokerErrorCode(error), error)
      throw error
    }
  }

  private async closeAll(subscription: SocialCopySubscriptionRow, destination: BrokerRow): Promise<void> {
    const api = this.provider(destination, true)
    if (!api) throw new Error('UNSUPPORTED_PROVIDER')
    const orders = await api.openedOrders(sessionId(destination))
    const { data, error } = await this.supabase.from('social_copy_trade_mappings').select('*').eq('subscription_id', subscription.id).in('state', ['opening', 'open', 'closing', 'uncertain', 'error'])
    if (error) throw error
    for (const mapping of (data ?? []) as MappingRow[]) await this.closeMapping(subscription, destination, api, orders, mapping)
  }

  private async claimEvent(subscriptionId: string, mappingId: string | null, sourceTicket: string, action: string, idempotencyKey: string, payload: Json): Promise<string | null> {
    const { data, error } = await this.supabase.from('social_copy_execution_events').insert({
      subscription_id: subscriptionId, mapping_id: mappingId, source_ticket: sourceTicket,
      action, idempotency_key: idempotencyKey, request_payload: payload,
    }).select('id').single()
    if (error?.code === '23505') {
      const { data: existing, error: readError } = await this.supabase
        .from('social_copy_execution_events')
        .select('id,status,attempt_count')
        .eq('subscription_id', subscriptionId)
        .eq('idempotency_key', idempotencyKey)
        .single()
      // Rematerialize after a cleared dead mapping: prior open attempts often
      // finished as uncertain (timeout) rather than failed.
      const priorStatus = String((existing as { status?: string } | null)?.status ?? '')
      const retryable = priorStatus === 'failed' || priorStatus === 'uncertain'
      if (readError || !existing || !retryable) return null
      const row = existing as { id: string; attempt_count?: number }
      const { error: retryError } = await this.supabase.from('social_copy_execution_events').update({
        status: 'claimed', attempt_count: Number(row.attempt_count ?? 1) + 1,
        error_code: null, error_detail: null, completed_at: null,
      }).eq('id', row.id)
      if (retryError) throw retryError
      return row.id
    }
    if (error) throw error
    return String((data as { id: string }).id)
  }

  private async finishEvent(id: string, status: string, result: Json, code?: string, error?: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : error == null ? null : String(error)
    const { error: updateError } = await this.supabase.from('social_copy_execution_events').update({
      status, result_payload: result, error_code: code ?? null, error_detail: detail, completed_at: new Date().toISOString(),
    }).eq('id', id)
    if (updateError) throw updateError
  }

  private async finalizeOpen(mapping: MappingRow, ticket: number): Promise<void> {
    if (!(ticket > 0)) throw new Error('BROKER_TICKET_MISSING')
    const { error } = await this.supabase.from('social_copy_trade_mappings').update({
      destination_ticket: String(ticket), state: 'open', opened_at: new Date().toISOString(), last_error_code: null, last_error_detail: null,
    }).eq('id', mapping.id)
    if (error) throw error
  }

  private async markMappingUncertain(id: string, code: string, detail: string): Promise<void> {
    await this.supabase.from('social_copy_trade_mappings').update({ state: 'uncertain', last_error_code: code, last_error_detail: detail }).eq('id', id)
  }

  private async patchSubscription(id: string, patch: Json): Promise<void> {
    const { error } = await this.supabase.from('social_copy_subscriptions').update({ ...patch, lease_owner: null, lease_expires_at: null }).eq('id', id)
    if (error) throw error
  }

  private async failSubscription(id: string, code: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    await this.patchSubscription(id, { status: 'error', error_code: code, error_detail: detail, last_reconciled_at: new Date().toISOString() })
  }
}
