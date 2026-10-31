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
  sessionId,
  symbolLimits,
  type NormalizedSourcePosition,
} from './copyShared/copyHelpers'

export { normalizeSourcePosition, constrainedCopyVolume }
export type { NormalizedSourcePosition }

type Json = Record<string, unknown>

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

type SourceRow = { id: string; broker_account_id: string; status: string }
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

  constructor(private readonly supabase: SupabaseClient, private readonly options: SocialCopyMonitorOptions = {}) {
    this.workerId = options.workerId ?? `social-copy-${process.pid}`
    this.executionEnabled = options.executionEnabled ?? /^(1|true|yes)$/i.test(process.env.SOCIAL_COPY_EXECUTION_ENABLED ?? '')
    this.allowLive = options.allowLive ?? /^(1|true|yes)$/i.test(process.env.SOCIAL_COPY_ALLOW_LIVE ?? '')
    this.syntheticSimulationEnabled = options.syntheticSimulationEnabled
      ?? /^(1|true|yes)$/i.test(process.env.SOCIAL_COPY_SYNTHETIC_SIMULATION_ENABLED ?? '')
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
        await this.reconcile(row).catch(error => this.failSubscription(row.id, brokerErrorCode(error), error))
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
      .select('id,broker_account_id,status').eq('id', subscription.source_id).single()
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
      await this.failSubscription(subscription.id, 'EXECUTION_DISABLED', new Error('Social copy execution is disabled on this worker'))
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
    const sourcePositions = sourceRaw.map(normalizeSourcePosition).filter((row): row is NormalizedSourcePosition => row != null)
    const destinationOrders = await destinationApi.openedOrders(sessionId(context.destinationBroker))
    const { data: mappings, error } = await this.supabase.from('social_copy_trade_mappings').select('*')
      .eq('subscription_id', subscription.id).in('state', ['opening', 'open', 'closing', 'uncertain', 'error'])
    if (error) throw error
    const bySource = new Map(((mappings ?? []) as MappingRow[]).map(row => [row.source_ticket, row]))

    for (const position of sourcePositions) {
      const mapping = bySource.get(position.ticket)
      if (!mapping) await this.openPosition(subscription, context, destinationApi, destinationOrders, position)
      else await this.syncPosition(subscription, context.destinationBroker, destinationApi, destinationOrders, mapping, position)
    }
    const openTickets = new Set(sourcePositions.map(position => position.ticket))
    for (const raw of sourceRaw) {
      if (normalizeSourcePosition(raw)) continue
      if (!raw || typeof raw !== 'object' || rawOrderTicket(raw as Json) <= 0) continue
      const ticket = String(rawOrderTicket(raw as Json))
      const event = await this.claimEvent(subscription.id, null, ticket, 'unsupported', `unsupported:${ticket}`, {})
      if (event) await this.finishEvent(event, 'skipped', {}, 'UNSUPPORTED_ORDER_TYPE', new Error('Only open market Buy/Sell positions are supported'))
    }
    for (const mapping of bySource.values()) {
      if (!openTickets.has(mapping.source_ticket) && mapping.state !== 'closed') {
        await this.closeMapping(subscription, context.destinationBroker, destinationApi, destinationOrders, mapping)
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
    const volume = await this.requestedVolume(subscription, context, position, api, symbol)
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
      if (readError || !existing || (existing as { status?: string }).status !== 'failed') return null
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
