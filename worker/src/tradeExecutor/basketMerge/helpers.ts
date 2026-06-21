import {
  classifyGhostBasketLegs,
  closeStaleOpenTrades,
  fetchOpenBrokerTicketsStrict,
  GHOST_BASKET_CLOSED_USER_MESSAGE,
  markBasketReconcileDoneForAnchor,
  type BasketOpenLeg
} from '../../basketSlTpReconcile'
import { loadExistingRangeStepIndices } from '../../rangePendingFireGuard'
import { isPostgresDuplicateKeyError } from '../../rangePendingLegPersist'
import { computeBasketMergeLinkContext, type BasketMergeLinkContext } from '../../signalMergeLink'
import { symbolsCompatibleForBasket } from '../../basketModFollowUp'
import { type TradeExecutorContext } from '../context'
import { type BrokerRow, type ParsedSignal, type SignalRow } from '../types'

export async function hasOpenTradeForSymbol(ctx: TradeExecutorContext, brokerId: string, symbol: string): Promise<boolean> {
    try {
      const { count } = await ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('broker_account_id', brokerId)
        .eq('symbol', symbol)
        .eq('status', 'open')
      return (count ?? 0) > 0
    } catch {
      return false
    }
  }

export async function reconcileGhostBasketLegs(ctx: TradeExecutorContext, args: {
    signal: SignalRow
    broker: BrokerRow
    uuid: string
    anchorSignalId: string
    symbol: string
    familyTrades: BasketOpenLeg[]
  }): Promise<{ isGhostBasket: boolean; closedCount: number }> {
    const { signal, broker, uuid, anchorSignalId, symbol, familyTrades } = args
    if (!familyTrades.length) return { isGhostBasket: false, closedCount: 0 }
    const api = ctx.apiFor(broker)
    if (!api) return { isGhostBasket: false, closedCount: 0 }
    const alive = await api.keepSessionAlive(uuid)
    if (!alive) return { isGhostBasket: false, closedCount: 0 }

    let brokerTickets: Set<number>
    try {
      brokerTickets = await fetchOpenBrokerTicketsStrict(api, uuid)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[tradeExecutor] ghost basket check skipped broker=${broker.id} anchor=${anchorSignalId}: ${msg}`,
      )
      return { isGhostBasket: false, closedCount: 0 }
    }

    const { onBroker, ghost } = classifyGhostBasketLegs(familyTrades, brokerTickets)
    if (onBroker.length > 0) return { isGhostBasket: false, closedCount: 0 }
    if (!ghost.length) return { isGhostBasket: false, closedCount: 0 }

    const closedCount = await closeStaleOpenTrades(
      ctx.supabase,
      ghost.map(tr => tr.id),
    )
    await markBasketReconcileDoneForAnchor(ctx.supabase, broker.id, anchorSignalId)

    console.log(
      `[tradeExecutor] stale_basket_reconciled signal=${signal.id} broker=${broker.id}`
      + ` anchor=${anchorSignalId} symbol=${symbol} closed=${closedCount}/${ghost.length}`,
    )

    try {
      await ctx.supabase.from('trade_execution_logs').insert({
        user_id: signal.user_id,
        signal_id: signal.id,
        broker_account_id: broker.id,
        action: 'stale_basket_reconciled',
        status: 'success',
        request_payload: {
          anchor_signal_id: anchorSignalId,
          symbol,
          closed_count: closedCount,
          ghost_leg_count: ghost.length,
          user_message: GHOST_BASKET_CLOSED_USER_MESSAGE,
        } as unknown as Record<string, unknown>,
      })
    } catch { /* best-effort */ }

    return { isGhostBasket: true, closedCount }
  }

export async function parentSignalIdChainContainsAnchor(ctx: TradeExecutorContext, 
    startParentId: string | null | undefined,
    anchorSignalId: string,
  ): Promise<boolean> {
    const anchor = String(anchorSignalId).trim()
    if (!anchor) return false
    let cur: string | null =
      startParentId != null && String(startParentId).trim() ? String(startParentId).trim() : null
    const seen = new Set<string>()
    const maxDepth = 32
    for (let depth = 0; depth < maxDepth && cur; depth++) {
      if (cur === anchor) return true
      if (seen.has(cur)) break
      seen.add(cur)
      try {
        const { data } = await ctx.supabase
          .from('signals')
          .select('parent_signal_id')
          .eq('id', cur)
          .maybeSingle()
        const raw = (data as { parent_signal_id?: string | null } | null)?.parent_signal_id
        cur = raw != null && String(raw).trim() ? String(raw).trim() : null
      } catch {
        break
      }
    }
    return false
  }

export async function resolveBasketAnchorSignalIdForOpenTrades(ctx: TradeExecutorContext, args: {
    userId: string
    brokerAccountIds: string[]
    channelId: string | null
    parentSignalId: string | null
    symbolHint: string | null
  }): Promise<string | null> {
    const { userId, brokerAccountIds, channelId, parentSignalId, symbolHint } = args
    if (!brokerAccountIds.length) return null

    const chainIds: string[] = []
    let cur = parentSignalId != null && String(parentSignalId).trim() ? String(parentSignalId).trim() : null
    const seenWalk = new Set<string>()
    for (let d = 0; d < 32 && cur; d++) {
      if (seenWalk.has(cur)) break
      seenWalk.add(cur)
      chainIds.push(cur)
      try {
        const { data } = await ctx.supabase
          .from('signals')
          .select('parent_signal_id')
          .eq('id', cur)
          .maybeSingle()
        const raw = (data as { parent_signal_id?: string | null } | null)?.parent_signal_id
        cur = raw != null && String(raw).trim() ? String(raw).trim() : null
      } catch {
        break
      }
    }

    if (chainIds.length) {
      const { data: hit } = await ctx.supabase
        .from('trades')
        .select('signal_id')
        .eq('user_id', userId)
        .in('broker_account_id', brokerAccountIds)
        .eq('status', 'open')
        .in('signal_id', chainIds)
        .limit(80)
      const uniq = new Set((hit ?? []).map((r: { signal_id: string }) => r.signal_id))
      if (uniq.size === 1) return [...uniq][0]!
      if (uniq.size > 1) {
        console.warn(
          `[tradeExecutor] resolveBasketAnchor: multiple anchors in parent chain user=${userId} chain=${chainIds.length}`,
        )
        return null
      }
    }

    if (!channelId) return null
    const symUp = symbolHint ? symbolHint.trim().toUpperCase() : ''

    const { data: openRows } = await ctx.supabase
      .from('trades')
      .select('signal_id, symbol')
      .eq('user_id', userId)
      .in('broker_account_id', brokerAccountIds)
      .eq('status', 'open')
      .limit(200)

    let cand = (openRows ?? []) as { signal_id: string; symbol: string }[]
    if (symUp) cand = cand.filter(t => symbolsCompatibleForBasket(symUp, t.symbol))
    const candSigIds = [...new Set(cand.map(t => t.signal_id))]
    if (!candSigIds.length) return null

    const { data: sigRows } = await ctx.supabase
      .from('signals')
      .select('id, channel_id')
      .in('id', candSigIds)
    const inChannel = new Set(
      (sigRows ?? [])
        .filter((s: { id: string; channel_id: string | null }) => s.channel_id === channelId)
        .map((s: { id: string }) => s.id),
    )
    const anchors = [...new Set(cand.filter(t => inChannel.has(t.signal_id)).map(t => t.signal_id))]
    if (anchors.length === 1) return anchors[0]!
    if (anchors.length > 1) {
      console.warn(
        `[tradeExecutor] resolveBasketAnchor: ambiguous channel+symbol open baskets user=${userId} channel=${channelId}`,
      )
    }
    return null
  }

export async function manualDispatchAlreadyMaterialized(ctx: TradeExecutorContext, signalId: string, brokerAccountId: string): Promise<boolean> {
    const [
      { count: rc, error: re },
      { count: sc, error: se },
      { count: tc, error: te },
      { count: lc, error: le },
    ] = await Promise.all([
      ctx.supabase
        .from('range_pending_legs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId),
      ctx.supabase
        .from('signal_entry_pending_orders')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('status', 'broker_pending'),
      ctx.supabase
        .from('trades')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId),
      ctx.supabase
        .from('trade_execution_logs')
        .select('id', { count: 'exact', head: true })
        .eq('signal_id', signalId)
        .eq('broker_account_id', brokerAccountId)
        .eq('status', 'success')
        .eq('action', 'order_send'),
    ])
    if (re) {
      console.warn(
        `[tradeExecutor] range_pending idempotency count failed signal=${signalId} broker=${brokerAccountId}: ${re.message}`,
      )
    }
    if (se) {
      console.warn(
        `[tradeExecutor] signal_entry_pending idempotency count failed signal=${signalId} broker=${brokerAccountId}: ${se.message}`,
      )
    }
    if (te) {
      console.warn(
        `[tradeExecutor] trades idempotency count failed signal=${signalId} broker=${brokerAccountId}: ${te.message}`,
      )
    }
    if (le) {
      console.warn(
        `[tradeExecutor] order_send log idempotency count failed signal=${signalId} broker=${brokerAccountId}: ${le.message}`,
      )
    }
    return ((rc ?? 0) > 0 || (sc ?? 0) > 0 || (tc ?? 0) > 0 || (lc ?? 0) > 0)
  }

export async function persistRangePendingLegRows(ctx: TradeExecutorContext, 
    rows: Record<string, unknown>[],
    context: string,
  ): Promise<{ ok: boolean; lastError?: string }> {
    if (!rows.length) return { ok: true }

    const first = rows[0]!
    const signalId = String(first.signal_id ?? '')
    const brokerId = String(first.broker_account_id ?? '')
    const symbol = String(first.symbol ?? '')
    if (signalId && brokerId && symbol) {
      const existingSteps = await loadExistingRangeStepIndices(
        ctx.supabase,
        signalId,
        brokerId,
        symbol,
      )
      if (existingSteps.size > 0) {
        const before = rows.length
        rows = rows.filter(r => !existingSteps.has(Number(r.step_idx)))
        if (rows.length < before) {
          console.log(
            `[tradeExecutor] skipped ${before - rows.length} range_pending_legs insert(s) — step already exists (${context})`,
          )
        }
      }
    }
    if (!rows.length) return { ok: true }

    let { error } = await ctx.supabase.from('range_pending_legs').upsert(rows, {
      onConflict: 'signal_id,broker_account_id,symbol,step_idx',
      ignoreDuplicates: true,
    })
    if (!error) return { ok: true }
    const msg0 = error.message ?? String(error)
    console.warn(
      `[tradeExecutor] range_pending_legs upsert failed (${context}), trying per-row: ${msg0}`,
    )
    let lastError = msg0
    let anyHardFailure = false
    for (const row of rows) {
      const { error: e } = await ctx.supabase.from('range_pending_legs').insert([row])
      if (!e) continue
      const m = e.message ?? String(e)
      lastError = m
      if (isPostgresDuplicateKeyError(e)) continue
      anyHardFailure = true
      console.warn(
        `[tradeExecutor] range_pending_legs insert failed (${context}) step=${String(row.step_idx)}: ${m}`,
      )
    }
    return { ok: !anyHardFailure, lastError: anyHardFailure ? lastError : undefined }
  }

export async function loadMergeSignalForLinking(ctx: TradeExecutorContext, signal: SignalRow): Promise<SignalRow> {
    try {
      const { data: fullSig } = await ctx.supabase
        .from('signals')
        .select('created_at, reply_to_message_id, telegram_message_id, parent_signal_id, channel_id')
        .eq('id', signal.id)
        .maybeSingle()
      const row = fullSig as {
        created_at?: string
        reply_to_message_id?: string | null
        telegram_message_id?: string | null
        parent_signal_id?: string | null
        channel_id?: string | null
      } | null
      if (!row) return signal
      return {
          ...signal,
          created_at: signal.created_at ?? row.created_at,
          reply_to_message_id: signal.reply_to_message_id ?? row.reply_to_message_id ?? null,
          telegram_message_id: signal.telegram_message_id ?? row.telegram_message_id ?? null,
          parent_signal_id: signal.parent_signal_id ?? row.parent_signal_id ?? null,
          channel_id: signal.channel_id ?? row.channel_id ?? null,
      }
    } catch {
      return signal
    }
  }

export async function resolveBasketMergeLinkContext(ctx: TradeExecutorContext, args: {
    mergeSignal: SignalRow
    anchorSignalId: string
    newestTradeOpenedAt: string
    parsed: ParsedSignal
  }): Promise<BasketMergeLinkContext> {
    const { mergeSignal, anchorSignalId, newestTradeOpenedAt, parsed } = args
    const { data: origSig } = await ctx.supabase
      .from('signals')
      .select('telegram_message_id, channel_id')
      .eq('id', anchorSignalId)
      .maybeSingle()
    const origTg = String(origSig?.telegram_message_id ?? '').trim()
    const anchorChannelId = String((origSig as { channel_id?: string | null } | null)?.channel_id ?? '').trim() || null
    const replyTo = String(mergeSignal.reply_to_message_id ?? '').trim()
    const parentLinksAnchor = String(mergeSignal.parent_signal_id ?? '') === anchorSignalId
    let ancestorChainContainsAnchor = false
    if (replyTo && !parentLinksAnchor) {
      ancestorChainContainsAnchor = await ctx.parentSignalIdChainContainsAnchor(
        mergeSignal.parent_signal_id,
        anchorSignalId,
      )
    }
    const hasSl = typeof parsed.sl === 'number' && Number.isFinite(parsed.sl) && parsed.sl > 0
    const hasTp = Array.isArray(parsed.tp)
      && parsed.tp.some(t => typeof t === 'number' && Number.isFinite(t) && (t as number) > 0)
    const sigTime = mergeSignal.created_at ? new Date(mergeSignal.created_at).getTime() : Date.now()
    return computeBasketMergeLinkContext({
      signalCreatedAtMs: sigTime,
      newestTradeOpenedAtMs: new Date(newestTradeOpenedAt).getTime(),
      replyToTelegramId: replyTo,
      anchorTelegramMessageId: origTg,
      mergeChannelId: String(mergeSignal.channel_id ?? '').trim() || null,
      anchorChannelId,
      parentSignalId: mergeSignal.parent_signal_id,
      anchorSignalId,
      mergeSignalId: mergeSignal.id,
      hasSl,
      hasTp,
      ancestorChainContainsAnchor,
    })
  }
