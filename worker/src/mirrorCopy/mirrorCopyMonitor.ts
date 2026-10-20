/**
 * Mirror copy monitor.
 *
 * Copies one master broker account's open positions onto its slave accounts for the
 * same user. This is the execution kernel for `broker_copy_links`; it is deliberately
 * separate from social copy (cross-user) and reuses only the pure helpers in
 * copyShared.
 *
 * Safety model:
 *  - On this migration test branch execution and live copying are on by default. Set
 *    MIRROR_COPY_EXECUTION_ENABLED=false (the worker then does not start the loop) or
 *    MIRROR_COPY_ALLOW_LIVE=false (demo only) to switch either off without a code change.
 *    Links themselves start paused and only copy once activated.
 *  - A master account is claimed under a short lease, so two replicas never reconcile the
 *    same master at once.
 *  - The destination account must be in confirmed hedging mode (broker_accounts.margin_mode);
 *    netting or unknown fails closed, because a second position on the same symbol would
 *    merge into the first.
 *  - One copy per source ticket is enforced by the mirror_copy_trade_mappings unique key and
 *    the mirror_copy_execution_events idempotency key. An uncertain open is never retried.
 *  - A source ticket that disappears is only closed once closed history confirms it is gone;
 *    an inconclusive read leaves the copy open rather than silently dropping a live ticket.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerProvider, OrderSendArgs } from '../brokerProvider'
import { authorityFromBrokerRow } from '../brokerWriteAuthority'
import { apiForBrokerAccount } from '../providerResolver'
import { rawOrderTicket } from '../signalEntryPendingHelpers'
import { resolveMtLots } from '../mtTradeFields'
import { parseEnvBool } from '../workerConfig'
import {
  brokerErrorCode,
  commentsMatch,
  constrainedCopyVolume,
  isDemo,
  normalizeSourcePosition,
  sessionId,
  symbolLimits,
  type NormalizedSourcePosition,
} from '../copyShared/copyHelpers'
import { mirrorCopyAccountModeSupported } from './mirrorCopyAccountMode'
import { mirrorCopyStops, planMirrorCopy, type MirrorCopyPlan } from './mirrorCopyPlan'
import { parseMirrorCopySettings, type MirrorCopySettings } from './mirrorCopyTypes'
import { historyContainsClosedPosition, mappingIsOpen, mirrorCopyComment } from './mirrorCopyReconcile'

type Json = Record<string, unknown>

export type MirrorCopyMasterRow = {
  broker_account_id: string
  status: 'pending' | 'active' | 'error'
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
  margin_mode: string | null
}

type LinkRow = {
  id: string
  user_id: string
  source_broker_account_id: string
  destination_broker_account_id: string
  manual_settings: unknown
}

type LinkStateRow = {
  link_id: string
  desired_status: 'active' | 'paused' | 'stopped'
  status: string
  error_code: string | null
}

type MappingRow = {
  id: string
  link_id: string
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

type BrokerContext = { source: BrokerRow; destination: BrokerRow }

const BROKER_COLUMNS =
  'id,user_id,provider,platform,is_active,connection_status,linked_account_type,'
  + 'mtapi_session_id,fxsocket_account_id,metaapi_account_id,ctrader_account_id,'
  + 'writer_epoch,provider_transition_state,margin_mode'

/** Mapping states that mean "the copy is still ours to manage". */
const OPEN_MAPPING_STATES = ['opening', 'open', 'uncertain', 'error']

/** Upper bound on automatic retries of a close/resize event left `uncertain`. */
const MAX_EVENT_ATTEMPTS = 5

export type MirrorCopyMonitorOptions = {
  workerId?: string
  executionEnabled?: boolean
  allowLive?: boolean
  intervalMs?: number
  claimLimit?: number
  historyWindowMs?: number
  uncertainRetryMs?: number
  providerFor?: (row: BrokerRow, write: boolean) => BrokerProvider | null
}

function envFlag(name: string, fallback = false): boolean {
  return parseEnvBool(process.env[name], fallback)
}

/**
 * The mode used by the hedging gate. MT4 has no netting concept and is always hedging;
 * every other platform must have a confirmed stored mode.
 */
function destinationAccountMode(row: BrokerRow): string {
  if (String(row.platform ?? '').trim().toUpperCase() === 'MT4') return 'hedging'
  return String(row.margin_mode ?? 'unknown').trim() || 'unknown'
}

/** Read a positive number from the environment, ignoring NaN/absent values. */
function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export class MirrorCopyMonitor {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly workerId: string
  private readonly executionEnabled: boolean
  private readonly allowLive: boolean
  private readonly intervalMs: number
  private readonly claimLimit: number
  private readonly historyWindowMs: number
  private readonly uncertainRetryMs: number
  private readonly staleClaimMs: number

  constructor(private readonly supabase: SupabaseClient, private readonly options: MirrorCopyMonitorOptions = {}) {
    this.workerId = options.workerId ?? `mirror-copy-${process.env.HOSTNAME ?? 'local'}-${process.pid}`
    // Enabled by default on the migration test branch; set either flag to "false"
    // to disable it without changing code.
    this.executionEnabled = options.executionEnabled ?? envFlag('MIRROR_COPY_EXECUTION_ENABLED', true)
    this.allowLive = options.allowLive ?? envFlag('MIRROR_COPY_ALLOW_LIVE', true)
    this.intervalMs = Math.max(2_000, options.intervalMs ?? envNumber('MIRROR_COPY_RECONCILE_MS', 20_000))
    this.claimLimit = Math.max(1, Math.min(200, options.claimLimit ?? envNumber('MIRROR_COPY_MASTER_CLAIM_LIMIT', 20)))
    this.historyWindowMs = Math.max(60_000, options.historyWindowMs ?? envNumber('MIRROR_COPY_HISTORY_WINDOW_MS', 259_200_000))
    this.uncertainRetryMs = Math.max(0, options.uncertainRetryMs ?? envNumber('MIRROR_COPY_UNCERTAIN_RETRY_MS', 60_000))
    this.staleClaimMs = Math.max(3 * this.intervalMs, 60_000)
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
      const { data, error } = await this.supabase.rpc('claim_mirror_copy_masters', {
        p_worker: this.workerId,
        p_limit: this.claimLimit,
        p_lease_seconds: Math.ceil(this.intervalMs / 1000) + 30,
      })
      if (error) throw error
      for (const master of (data ?? []) as MirrorCopyMasterRow[]) {
        await this.reconcileMaster(master).catch(error => this.failMaster(master.broker_account_id, error))
      }
    } catch (error) {
      console.warn('[mirror-copy] claim failed:', error instanceof Error ? error.message : String(error))
    } finally {
      this.running = false
    }
  }

  private provider(row: BrokerRow, write: boolean): BrokerProvider | null {
    if (this.options.providerFor) return this.options.providerFor(row, write)
    const authority = write ? authorityFromBrokerRow(row) : null
    return apiForBrokerAccount(row.provider, sessionId(row), authority)
  }

  private async reconcileMaster(master: MirrorCopyMasterRow): Promise<void> {
    const masterId = master.broker_account_id
    const { data: links, error } = await this.supabase.from('broker_copy_links')
      .select('id,user_id,source_broker_account_id,destination_broker_account_id,manual_settings')
      .eq('source_broker_account_id', masterId)
    if (error) throw error
    const linkRows = (links ?? []) as LinkRow[]
    if (linkRows.length > 0) {
      const { data: states, error: stateError } = await this.supabase.from('mirror_copy_link_state')
        .select('link_id,desired_status,status,error_code')
        .in('link_id', linkRows.map(row => row.id))
      if (stateError) throw stateError
      const byLink = new Map(((states ?? []) as LinkStateRow[]).map(row => [row.link_id, row]))
      for (const link of linkRows) {
        const state = byLink.get(link.id) ?? { link_id: link.id, desired_status: 'paused' as const, status: 'pending', error_code: null }
        await this.reconcileLink(link, state).catch(error => this.failLink(link.id, brokerErrorCode(error), error))
      }
    }
    await this.patchMaster(masterId, {
      status: 'active', error_code: null, error_detail: null, last_reconciled_at: new Date().toISOString(),
    })
  }

  private async reconcileLink(link: LinkRow, state: LinkStateRow): Promise<void> {
    if (state.desired_status === 'paused') {
      await this.patchLinkState(link.id, {
        status: 'paused', worker_acknowledged_at: new Date().toISOString(), last_reconciled_at: new Date().toISOString(),
        error_code: null, error_detail: null,
      })
      return
    }

    const context = await this.loadContext(link)
    if (link.user_id !== context.source.user_id || link.user_id !== context.destination.user_id) {
      await this.failLink(link.id, 'OWNER_MISMATCH', new Error('Link and broker accounts belong to different users'))
      return
    }

    // Execution stays gated everywhere. A stop, however, must still flatten copies even on
    // an unknown/netting account (closing by ticket is safe there), so it runs before the
    // hedging gate.
    if (!this.executionEnabled) {
      await this.failLink(link.id, 'EXECUTION_DISABLED', new Error('Mirror copy execution is disabled on this worker'))
      return
    }

    if (state.desired_status === 'stopped') {
      // Already fully stopped: nothing to close, and never rewrite stopped_at.
      if (state.status === 'stopped') {
        await this.patchLinkState(link.id, { last_reconciled_at: new Date().toISOString() })
        return
      }
      if (!context.destination.is_active) throw new Error('BROKER_DISCONNECTED')
      if (!sessionId(context.destination)) throw new Error('BROKER_SESSION_UNAVAILABLE')
      if (!isDemo(context.destination) && !this.allowLive) {
        await this.failLink(link.id, 'LIVE_EXECUTION_DISABLED', new Error('Stop requested on a live account; live execution is disabled'))
        return
      }
      await this.closeAll(link, context.destination)
      await this.patchLinkState(link.id, {
        status: 'stopped', stopped_at: new Date().toISOString(), last_reconciled_at: new Date().toISOString(),
      })
      return
    }

    const accountMode = destinationAccountMode(context.destination)
    if (!mirrorCopyAccountModeSupported(accountMode)) {
      await this.patchLinkState(link.id, {
        status: 'unsupported_provider',
        error_code: 'ACCOUNT_MODE_UNSUPPORTED',
        error_detail: `Destination account mode is ${accountMode}; mirror copy requires a confirmed hedging account`,
        worker_acknowledged_at: new Date().toISOString(),
        last_reconciled_at: new Date().toISOString(),
      })
      return
    }

    if (!context.source.is_active || !context.destination.is_active) throw new Error('BROKER_DISCONNECTED')
    if (!sessionId(context.source) || !sessionId(context.destination)) throw new Error('BROKER_SESSION_UNAVAILABLE')
    if ((!isDemo(context.source) || !isDemo(context.destination)) && !this.allowLive) {
      await this.failLink(link.id, 'LIVE_EXECUTION_DISABLED', new Error('Only demo-to-demo mirror copying is enabled'))
      return
    }

    const settings = parseMirrorCopySettings(link.manual_settings)
    if (settings.sizingMode === 'unsupported') {
      await this.failLink(link.id, 'SIZING_MODE_UNSUPPORTED', new Error('The configured sizing mode is not supported by this engine'))
      return
    }

    const sourceApi = this.provider(context.source, false)
    const destinationApi = this.provider(context.destination, true)
    if (!sourceApi || !destinationApi) throw new Error('UNSUPPORTED_PROVIDER')
    if (!await sourceApi.verifyTradingReady(sessionId(context.source))) throw new Error('SOURCE_DISCONNECTED')
    if (!await destinationApi.verifyTradingReady(sessionId(context.destination))) throw new Error('DESTINATION_DISCONNECTED')

    const sourceRaw = await sourceApi.openedOrders(sessionId(context.source))
    const sourcePositions = sourceRaw
      .map(normalizeSourcePosition)
      .filter((row): row is NormalizedSourcePosition => row != null)
    const destinationOrders = await destinationApi.openedOrders(sessionId(context.destination))
    const { data: mappings, error: mappingError } = await this.supabase.from('mirror_copy_trade_mappings').select('*')
      .eq('link_id', link.id).in('state', OPEN_MAPPING_STATES)
    if (mappingError) throw mappingError
    const bySource = new Map(((mappings ?? []) as MappingRow[]).map(row => [row.source_ticket, row]))

    // One bad position must not stop the others (or the close loop below) from being
    // handled. Failures are collected and surfaced once every position is processed.
    const failures: string[] = []
    for (const position of sourcePositions) {
      const mapping = bySource.get(position.ticket)
      try {
        if (mapping) await this.syncPosition(link, settings, context, destinationApi, destinationOrders, mapping, position)
        else await this.openPosition(link, settings, context, destinationApi, destinationOrders, position)
      } catch (error) {
        failures.push(`${position.ticket}:${brokerErrorCode(error)}`)
      }
    }

    for (const raw of sourceRaw) {
      if (normalizeSourcePosition(raw)) continue
      if (!raw || typeof raw !== 'object' || rawOrderTicket(raw as Json) <= 0) continue
      const ticket = String(rawOrderTicket(raw as Json))
      const event = await this.claimEvent(link.id, null, ticket, 'unsupported', `unsupported:${ticket}`, {})
      if (event) await this.finishEvent(event, 'skipped', {}, 'UNSUPPORTED_ORDER_TYPE', new Error('Only open market Buy/Sell positions are supported'))
    }

    const openTickets = new Set(sourcePositions.map(position => position.ticket))
    for (const mapping of bySource.values()) {
      if (openTickets.has(mapping.source_ticket) || !mappingIsOpen(mapping.state)) continue
      try {
        if (!await this.confirmSourceClosed(sourceApi, context, mapping.source_ticket)) {
          await this.recordUnresolvedSource(link.id, mapping)
          continue
        }
        await this.closeMapping(link, context.destination, destinationApi, destinationOrders, mapping)
      } catch (error) {
        failures.push(`close:${mapping.source_ticket}:${brokerErrorCode(error)}`)
      }
    }

    if (failures.length > 0) {
      await this.failLink(link.id, 'RECONCILE_PARTIAL', new Error(`Some positions could not be reconciled: ${failures.join(', ')}`))
      return
    }

    await this.patchLinkState(link.id, {
      status: 'active', worker_acknowledged_at: new Date().toISOString(), last_reconciled_at: new Date().toISOString(),
      error_code: null, error_detail: null,
    })
  }

  private async loadContext(link: LinkRow): Promise<BrokerContext> {
    const [sourceResult, destinationResult] = await Promise.all([
      this.supabase.from('broker_accounts').select(BROKER_COLUMNS).eq('id', link.source_broker_account_id).single(),
      this.supabase.from('broker_accounts').select(BROKER_COLUMNS).eq('id', link.destination_broker_account_id).single(),
    ])
    if (sourceResult.error || !sourceResult.data) throw new Error('SOURCE_UNAVAILABLE')
    if (destinationResult.error || !destinationResult.data) throw new Error('DESTINATION_UNAVAILABLE')
    return {
      source: sourceResult.data as unknown as BrokerRow,
      destination: destinationResult.data as unknown as BrokerRow,
    }
  }

  private async openPosition(
    link: LinkRow,
    settings: MirrorCopySettings,
    context: BrokerContext,
    api: BrokerProvider,
    destinationOrders: unknown[],
    position: NormalizedSourcePosition,
  ): Promise<void> {
    const plan = planMirrorCopy(settings, position)
    if (!plan) return
    const volume = await this.destinationVolume(api, context, plan)
    const comment = mirrorCopyComment(link.id, position.ticket)
    const { data: mappingData, error: mappingError } = await this.supabase.from('mirror_copy_trade_mappings').insert({
      link_id: link.id, source_ticket: position.ticket, source_symbol: position.symbol,
      destination_symbol: plan.symbol, source_side: position.side, source_volume: position.volume,
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
    const event = await this.claimEvent(link.id, mapping.id, position.ticket, 'open', `open:${position.ticket}`, { symbol: plan.symbol, volume })
    if (!event) {
      await this.markMappingUncertain(mapping.id, 'DUPLICATE_OPEN_CLAIM', 'An earlier open attempt must be reconciled manually')
      throw new Error('DUPLICATE_OPEN_CLAIM')
    }
    const args: OrderSendArgs = {
      symbol: plan.symbol, operation: position.side === 'buy' ? 'Buy' : 'Sell', volume,
      stoploss: plan.stopLoss, takeprofit: plan.takeProfit, comment,
    }
    try {
      const result = await api.orderSend(sessionId(context.destination), args)
      const ticket = result.positionTicket ?? result.ticket
      if (!(ticket > 0)) throw new Error('BROKER_TICKET_MISSING')
      await this.finalizeOpen(mapping, ticket)
      await this.finishEvent(event, 'succeeded', { ticket })
    } catch (error) {
      const snapshot = await api.openedOrders(sessionId(context.destination)).catch(() => [] as unknown[])
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

  private async destinationVolume(api: BrokerProvider, context: BrokerContext, plan: MirrorCopyPlan): Promise<number> {
    const limits = symbolLimits(await api.symbolParams(sessionId(context.destination), plan.symbol))
    if (!limits) throw new Error('SYMBOL_LIMITS_UNAVAILABLE')
    const constrained = constrainedCopyVolume(plan.requestedVolume, limits, plan.requestedVolume)
    if (constrained == null) throw new Error('VOLUME_BELOW_MINIMUM')
    return constrained
  }

  private async syncPosition(
    link: LinkRow,
    settings: MirrorCopySettings,
    context: BrokerContext,
    api: BrokerProvider,
    destinationOrders: unknown[],
    mapping: MappingRow,
    position: NormalizedSourcePosition,
  ): Promise<void> {
    const needsRecovery = mapping.state === 'opening' || mapping.state === 'uncertain'
      || (mapping.state === 'error' && !(Number(mapping.destination_ticket) > 0))
    if (needsRecovery) {
      const recovered = destinationOrders.find(row => commentsMatch(row, mapping.broker_comment))
      if (recovered) {
        // The order did reach the broker (e.g. after an abandoned or uncertain attempt):
        // adopt it so it never becomes an unmanaged live position.
        const ticket = rawOrderTicket(recovered as Json)
        await this.finalizeOpen(mapping, ticket)
        mapping.destination_ticket = String(ticket)
        mapping.state = 'open'
      } else if (mapping.state === 'opening') {
        // An 'opening' row with no ticket and no matching order never reached the broker.
        // Record it once as abandoned instead of retrying every tick (a retry could duplicate).
        await this.supabase.from('mirror_copy_trade_mappings').update({
          state: 'error', last_error_code: 'OPEN_ABANDONED',
          last_error_detail: 'Open attempt produced no broker ticket and no matching order',
        }).eq('id', mapping.id)
        return
      } else {
        return
      }
    }
    if (!mapping.destination_ticket) return
    const destinationTicket = Number(mapping.destination_ticket)
    const destinationOrder = destinationOrders.find(row => rawOrderTicket(row as Json) === destinationTicket)
    if (!destinationOrder) {
      // The destination position is gone (closed manually or by another system). Do not
      // compute deltas or send stop changes against a missing ticket; retire the ledger row.
      await this.supabase.from('mirror_copy_trade_mappings').update({
        state: 'closed', closed_at: new Date().toISOString(),
        last_error_code: 'DESTINATION_CLOSED_EXTERNALLY',
        last_error_detail: 'Destination position was not found in open orders',
      }).eq('id', mapping.id)
      return
    }

    const volumeTolerance = Math.max(0.000001, mapping.source_volume * 0.0001)
    if (position.volume > mapping.source_volume + volumeTolerance) {
      throw new Error('SOURCE_VOLUME_INCREASE_UNSUPPORTED')
    }
    if (position.volume < mapping.source_volume - volumeTolerance) {
      // Scale by the stored copy ratio (stable under proportional partial closes), then
      // compare with the broker's *actual* remaining volume. A previous resize can have
      // executed while its event was recorded as uncertain; using the stored volume as the
      // delta base would then over-close the destination.
      const ratio = mapping.destination_volume / mapping.source_volume
      const targetDestinationVolume = ratio * position.volume
      const snapshotVolume = resolveMtLots(destinationOrder as Json, 'trades')
      if (!(snapshotVolume > 0)) throw new Error('DESTINATION_VOLUME_UNAVAILABLE')
      const needsClose = (volume: number) => volume - targetDestinationVolume > Math.max(0.000001, volume * 0.0001)

      if (!needsClose(snapshotVolume)) {
        // The broker already holds the target volume; just bring the ledger back in sync.
        mapping.destination_volume = targetDestinationVolume
        mapping.source_volume = position.volume
        await this.updateMappingVolumes(mapping.id, position.volume, mapping.destination_volume)
      } else {
        // The absolute target is part of the key: a resize that already reached the target
        // produces a different key (and is skipped above), while a failed one can be retried.
        const key = `resize:${position.ticket}:${targetDestinationVolume.toFixed(8)}`
        const event = await this.claimEvent(link.id, mapping.id, position.ticket, 'modify', key, { targetDestinationVolume }, true)
        if (!event) throw new Error('DUPLICATE_MODIFY_CLAIM')
        try {
          // Re-read immediately before sending: another worker may have reclaimed a stale
          // event and reduced the position after this tick's snapshot.
          const fresh = await api.openedOrders(sessionId(context.destination)).catch(() => null)
          const freshOrder = fresh?.find(row => rawOrderTicket(row as Json) === destinationTicket)
          if (fresh && !freshOrder) {
            await this.supabase.from('mirror_copy_trade_mappings').update({
              state: 'closed', closed_at: new Date().toISOString(),
              last_error_code: 'DESTINATION_CLOSED_EXTERNALLY',
              last_error_detail: 'Destination position disappeared before a resize close',
            }).eq('id', mapping.id)
            await this.finishEvent(event, 'succeeded', { recovered: true })
            return
          }
          const brokerVolume = (fresh && freshOrder ? resolveMtLots(freshOrder as Json, 'trades') : 0) || snapshotVolume
          if (!needsClose(brokerVolume)) {
            mapping.destination_volume = targetDestinationVolume
            mapping.source_volume = position.volume
            await this.updateMappingVolumes(mapping.id, position.volume, mapping.destination_volume)
            await this.finishEvent(event, 'succeeded', { recovered: true })
          } else {
            const limits = symbolLimits(await api.symbolParams(sessionId(context.destination), mapping.destination_symbol))
            if (!limits) throw new Error('SYMBOL_LIMITS_UNAVAILABLE')
            const requestedClose = brokerVolume - targetDestinationVolume
            const closeVolume = constrainedCopyVolume(requestedClose, limits, requestedClose)
            if (closeVolume == null || brokerVolume - closeVolume < limits.min - 1e-10) {
              throw new Error('PARTIAL_CLOSE_BELOW_MINIMUM')
            }
            await api.orderClose(sessionId(context.destination), { ticket: destinationTicket, lots: closeVolume })
            mapping.destination_volume = brokerVolume - closeVolume
            mapping.source_volume = position.volume
            await this.updateMappingVolumes(mapping.id, position.volume, mapping.destination_volume)
            await this.finishEvent(event, 'succeeded', { closeVolume })
          }
        } catch (error) {
          await this.finishEvent(event, 'uncertain', {}, brokerErrorCode(error), error)
          throw error
        }
      }
    }

    const target = mirrorCopyStops(settings, position)
    if (mapping.source_stop_loss === position.stopLoss && mapping.source_take_profit === position.takeProfit) return
    const key = `modify:${position.ticket}:${position.stopLoss ?? 0}:${position.takeProfit ?? 0}`
    const event = await this.claimEvent(link.id, mapping.id, position.ticket, 'modify', key, { stopLoss: target.stopLoss, takeProfit: target.takeProfit })
    if (!event) return
    try {
      await api.orderModify(sessionId(context.destination), {
        ticket: Number(mapping.destination_ticket), stoploss: target.stopLoss, takeprofit: target.takeProfit,
      })
      await this.supabase.from('mirror_copy_trade_mappings').update({
        source_stop_loss: position.stopLoss, source_take_profit: position.takeProfit,
      }).eq('id', mapping.id)
      await this.finishEvent(event, 'succeeded', {})
    } catch (error) {
      await this.finishEvent(event, 'failed', {}, brokerErrorCode(error), error)
      throw error
    }
  }

  private async closeAll(link: LinkRow, destination: BrokerRow): Promise<void> {
    const api = this.provider(destination, true)
    if (!api) throw new Error('UNSUPPORTED_PROVIDER')
    const orders = await api.openedOrders(sessionId(destination))
    const { data, error } = await this.supabase.from('mirror_copy_trade_mappings').select('*')
      .eq('link_id', link.id).in('state', OPEN_MAPPING_STATES)
    if (error) throw error
    const failures: string[] = []
    for (const mapping of (data ?? []) as MappingRow[]) {
      try {
        await this.closeMapping(link, destination, api, orders, mapping)
      } catch (closeError) {
        failures.push(`${mapping.source_ticket}:${brokerErrorCode(closeError)}`)
      }
    }
    if (failures.length > 0) throw new Error(`CLOSE_ALL_PARTIAL: ${failures.join(', ')}`)
  }

  private async closeMapping(
    link: LinkRow,
    destination: BrokerRow,
    api: BrokerProvider,
    destinationOrders: unknown[],
    mapping: MappingRow,
  ): Promise<void> {
    let ticket = Number(mapping.destination_ticket)
    if (!(ticket > 0)) {
      const recovered = destinationOrders.find(row => commentsMatch(row, mapping.broker_comment))
      if (!recovered) {
        await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
        return
      }
      ticket = rawOrderTicket(recovered as Json)
      await this.finalizeOpen(mapping, ticket)
    }
    if (!destinationOrders.some(row => rawOrderTicket(row as Json) === ticket)) {
      await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
      return
    }
    const event = await this.claimEvent(link.id, mapping.id, mapping.source_ticket, 'close', `close:${mapping.source_ticket}`, { ticket }, true)
    if (!event) {
      // A previous close attempt may already have opened this key and been recorded as
      // uncertain (or the retry window/attempt cap is exhausted). Re-check the broker: if
      // the position is gone it actually closed, so un-wedge the row; otherwise surface a
      // distinct error so an operator sees a close that is not taking effect.
      const current = await api.openedOrders(sessionId(destination)).catch(() => destinationOrders)
      if (!current.some(row => rawOrderTicket(row as Json) === ticket)) {
        await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
        return
      }
      throw new Error('CLOSE_NOT_CONFIRMED')
    }
    try {
      // Re-read immediately before sending: another worker may have reclaimed a stale
      // event and closed the position after this tick's snapshot.
      const fresh = await api.openedOrders(sessionId(destination)).catch(() => null)
      if (fresh && !fresh.some(row => rawOrderTicket(row as Json) === ticket)) {
        await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
        await this.finishEvent(event, 'succeeded', { recovered: true })
        return
      }
      await api.orderClose(sessionId(destination), { ticket })
      await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
      await this.finishEvent(event, 'succeeded', {})
    } catch (error) {
      const after = await api.openedOrders(sessionId(destination)).catch(() => destinationOrders)
      if (!after.some(row => rawOrderTicket(row as Json) === ticket)) {
        await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'closed', closed_at: new Date().toISOString() }).eq('id', mapping.id)
        await this.finishEvent(event, 'succeeded', { recovered: true })
        return
      }
      await this.finishEvent(event, 'uncertain', {}, brokerErrorCode(error), error)
      throw error
    }
  }

  /**
   * Confirm a source ticket is really closed before closing its copy. A read gap or a
   * provider without history must not be treated as a close: return false so the copy
   * stays open (decision #6 — never silently drop a live source ticket).
   */
  private async confirmSourceClosed(sourceApi: BrokerProvider, context: BrokerContext, ticket: string): Promise<boolean> {
    const to = new Date().toISOString()
    const from = new Date(Date.now() - this.historyWindowMs).toISOString()
    const id = sessionId(context.source)
    const provider = context.source.provider as string | null | undefined
    try {
      if (historyContainsClosedPosition(await sourceApi.closedOrdersHistory(id, from, to), ticket, provider)) return true
      return historyContainsClosedPosition(await sourceApi.historyPositions(id, from, to), ticket, provider)
    } catch {
      return false
    }
  }

  private async recordUnresolvedSource(linkId: string, mapping: MappingRow): Promise<void> {
    const event = await this.claimEvent(linkId, mapping.id, mapping.source_ticket, 'reconcile', `unresolved:${mapping.source_ticket}`, {})
    if (!event) return
    await this.finishEvent(
      event, 'skipped', {}, 'SOURCE_TICKET_UNRESOLVED',
      new Error('Source position is no longer open but is not in closed history; leaving the copy open to avoid dropping a live ticket'),
    )
  }

  private async claimEvent(
    linkId: string,
    mappingId: string | null,
    sourceTicket: string,
    action: string,
    idempotencyKey: string,
    payload: Json,
    allowUncertainRetry = false,
  ): Promise<string | null> {
    const { data, error } = await this.supabase.from('mirror_copy_execution_events').insert({
      link_id: linkId, mapping_id: mappingId, source_ticket: sourceTicket,
      action, idempotency_key: idempotencyKey, request_payload: payload,
    }).select('id').single()
    if (error?.code === '23505') {
      const { data: existing, error: readError } = await this.supabase
        .from('mirror_copy_execution_events')
        .select('id,status,attempt_count,completed_at,updated_at')
        .eq('link_id', linkId)
        .eq('idempotency_key', idempotencyKey)
        .single()
      if (readError || !existing) return null
      const row = existing as {
        id: string
        status?: string
        attempt_count?: number
        completed_at?: string | null
        updated_at?: string | null
      }
      const status = String(row.status ?? '')
      const completedAt = row.completed_at ? Date.parse(row.completed_at) : NaN
      const updatedAt = row.updated_at ? Date.parse(row.updated_at) : NaN
      const uncertainDue = allowUncertainRetry
        && status === 'uncertain'
        && Number.isFinite(completedAt)
        && Date.now() - completedAt >= this.uncertainRetryMs
      // A crash between claiming and completing leaves a row 'claimed' forever. For
      // close/resize only, re-claim it once it is older than a safe lease window.
      const staleClaim = allowUncertainRetry
        && status === 'claimed'
        && Number.isFinite(updatedAt)
        && Date.now() - updatedAt >= this.staleClaimMs
      if (status !== 'failed' && !uncertainDue && !staleClaim) return null
      const attempts = Number(row.attempt_count ?? 1)
      if ((status === 'uncertain' || status === 'claimed') && attempts >= MAX_EVENT_ATTEMPTS) return null
      // Only re-claim if the row is still in the status we read, so two workers cannot both
      // win the retry.
      const { data: reclaimed, error: retryError } = await this.supabase.from('mirror_copy_execution_events').update({
        status: 'claimed', attempt_count: attempts + 1,
        error_code: null, error_detail: null, completed_at: null, request_payload: payload,
      }).eq('id', row.id).eq('status', status).eq('attempt_count', attempts).select('id')
      if (retryError) throw retryError
      if (!reclaimed || (reclaimed as unknown[]).length === 0) return null
      return row.id
    }
    if (error) throw error
    return String((data as { id: string }).id)
  }

  private async finishEvent(id: string, status: string, result: Json, code?: string, error?: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : error == null ? null : String(error)
    const { error: updateError } = await this.supabase.from('mirror_copy_execution_events').update({
      status, result_payload: result, error_code: code ?? null, error_detail: detail, completed_at: new Date().toISOString(),
    }).eq('id', id)
    if (updateError) throw updateError
  }

  private async finalizeOpen(mapping: MappingRow, ticket: number): Promise<void> {
    if (!(ticket > 0)) throw new Error('BROKER_TICKET_MISSING')
    const { error } = await this.supabase.from('mirror_copy_trade_mappings').update({
      destination_ticket: String(ticket), state: 'open', opened_at: new Date().toISOString(), last_error_code: null, last_error_detail: null,
    }).eq('id', mapping.id)
    if (error) throw error
  }

  private async updateMappingVolumes(id: string, sourceVolume: number, destinationVolume: number): Promise<void> {
    const { error } = await this.supabase.from('mirror_copy_trade_mappings').update({
      source_volume: sourceVolume, destination_volume: destinationVolume,
    }).eq('id', id)
    if (error) throw error
  }

  private async markMappingUncertain(id: string, code: string, detail: string): Promise<void> {
    const { error } = await this.supabase.from('mirror_copy_trade_mappings').update({ state: 'uncertain', last_error_code: code, last_error_detail: detail }).eq('id', id)
    if (error) throw error
  }

  private async patchLinkState(linkId: string, patch: Json): Promise<void> {
    const { error } = await this.supabase.from('mirror_copy_link_state').update(patch).eq('link_id', linkId)
    if (error) throw error
  }

  private async failLink(linkId: string, code: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    await this.patchLinkState(linkId, {
      status: 'error', error_code: code, error_detail: detail, last_reconciled_at: new Date().toISOString(),
    }).catch(() => undefined)
  }

  private async patchMaster(masterId: string, patch: Json): Promise<void> {
    // Only clear the lease if we still hold it, so a worker whose lease expired and was
    // re-claimed cannot wipe the new owner's lease out from under it.
    const { error } = await this.supabase.from('mirror_copy_master_state').update({
      ...patch, lease_owner: null, lease_expires_at: null,
    }).eq('broker_account_id', masterId).eq('lease_owner', this.workerId)
    if (error) throw error
  }

  private async failMaster(masterId: string, error: unknown): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error)
    await this.patchMaster(masterId, {
      status: 'error', error_code: brokerErrorCode(error), error_detail: detail, last_reconciled_at: new Date().toISOString(),
    }).catch(() => undefined)
  }
}
