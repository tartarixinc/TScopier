/**
 * Always-on TradingView webhook ingest (Railway trade HTTP).
 * Ports the edge tradingview-webhook background path so alerts skip Deno cold start.
 */

import { createHash, randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseTradingViewAlert } from './tradingViewAlert'
import {
  pushParsedSignalToTradeWorker,
  type TradeSignalPushPayload,
} from './tradeSignalPush'
import type { TradeExecutor } from './tradeExecutor'
import type { SignalRow } from './tradeExecutor'
import { userBelongsToShard } from './workerConfig'

const RATE_LIMIT_PER_MINUTE = 60

export type TradingViewWebhookRow = {
  id: string
  user_id: string
  channel_id: string
  name: string
  is_active: boolean
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function tradingViewClientIp(headers: Record<string, string | string[] | undefined>): string {
  const forwarded = headers['x-forwarded-for']
  const raw = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ?? headers['x-real-ip'] ?? '')
  const first = Array.isArray(raw) ? raw[0] : raw
  return String(first ?? '').split(',')[0]?.trim() ?? ''
}

export function tradingViewWebhookIpAllowed(clientIp: string): boolean {
  const allow = (process.env.TRADINGVIEW_WEBHOOK_IPS ?? '').trim()
  if (!allow) return true
  if (!clientIp) return false
  return allow.split(',').map(s => s.trim()).filter(Boolean).includes(clientIp)
}

/** Extract token from `/webhooks/tradingview/:token` (null for `_warm` or missing). */
export function tradingViewPathToken(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 3) return null
  if (parts[0] !== 'webhooks' || parts[1] !== 'tradingview') return null
  const last = parts[parts.length - 1] ?? ''
  if (!last || last === '_warm') return null
  return last
}

async function recordDelivery(
  supabase: SupabaseClient,
  webhook: TradingViewWebhookRow,
  status: 'accepted' | 'skipped' | 'error' | 'duplicate',
  idempotencyKey: string,
  skipReason: string | null,
  signalId: string | null,
): Promise<'inserted' | 'duplicate'> {
  const { error } = await supabase.from('tradingview_webhook_deliveries').insert({
    webhook_id: webhook.id,
    user_id: webhook.user_id,
    signal_id: signalId,
    status,
    skip_reason: skipReason,
    idempotency_key: idempotencyKey,
  })
  if (!error) return 'inserted'
  if (error.code === '23505') return 'duplicate'
  console.warn(`[tradingViewIngest] delivery insert failed webhook=${webhook.id}: ${error.message}`)
  return 'inserted'
}

function dispatchAcceptedSignal(
  webhook: TradingViewWebhookRow,
  signal: {
    id: string
    parsed_data: Record<string, unknown>
    status: string
    telegram_message_id: string
    created_at: string
    raw_message: string
  },
  tradeExecutor: TradeExecutor | null,
): void {
  const action = String(signal.parsed_data.action ?? '')
  const priority = action === 'close' ? 'high' as const : 'normal' as const
  const row: TradeSignalPushPayload = {
    id: signal.id,
    user_id: webhook.user_id,
    channel_id: webhook.channel_id,
    parsed_data: signal.parsed_data as unknown as TradeSignalPushPayload['parsed_data'],
    status: signal.status,
    parent_signal_id: null,
    is_modification: false,
    telegram_message_id: signal.telegram_message_id,
    reply_to_message_id: null,
    created_at: signal.created_at,
    dispatch_source: 'tradingview_webhook',
  }

  if (tradeExecutor && userBelongsToShard(webhook.user_id)) {
    const signalRow = {
      ...row,
      source_kind: 'tradingview',
      source_display_name: webhook.name?.trim() || 'TradingView',
    } as unknown as SignalRow
    const accepted = tradeExecutor.acceptDispatchSignal(signalRow, {
      priority,
      source: 'tradingview_webhook',
    })
    if (accepted) return
  }

  pushParsedSignalToTradeWorker(row, { source: 'tradingview_webhook' })
}

async function persistAcceptedAlert(
  supabase: SupabaseClient,
  webhook: TradingViewWebhookRow,
  raw: string,
  parsed: Extract<ReturnType<typeof parseTradingViewAlert>, { ok: true }>,
  idempotencyKey: string,
  tradeExecutor: TradeExecutor | null,
): Promise<void> {
  const since = new Date(Date.now() - 60_000).toISOString()
  const { count } = await supabase
    .from('tradingview_webhook_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('webhook_id', webhook.id)
    .gte('created_at', since)
  if ((count ?? 0) >= RATE_LIMIT_PER_MINUTE) {
    console.warn(`[tradingViewIngest] rate limited webhook=${webhook.id}`)
    return
  }

  const { data: existing } = await supabase
    .from('tradingview_webhook_deliveries')
    .select('id')
    .eq('webhook_id', webhook.id)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle()
  if (existing) return

  const createdAt = new Date().toISOString()
  const signalId = randomUUID()
  const alert = parsed.alert
  const imperativeCue = (alert.action === 'buy' || alert.action === 'sell')
    ? `${alert.symbol} ${alert.action.toUpperCase()} NOW`
    : ''
  const rawMessage = (imperativeCue ? `${imperativeCue}\n${raw}` : raw).slice(0, 8_000)
  const parsedData = {
    ...parsed.alert.parsed,
    ...(imperativeCue ? { raw_instruction: imperativeCue } : {}),
    signal_source: 'tradingview',
  }

  const { error: signalErr } = await supabase.from('signals').insert({
    id: signalId,
    user_id: webhook.user_id,
    channel_id: webhook.channel_id,
    source_kind: 'tradingview',
    source_display_name: webhook.name?.trim() || 'TradingView',
    raw_message: rawMessage,
    parsed_data: parsedData,
    status: 'parsed',
    skip_reason: null,
    telegram_message_id: idempotencyKey,
    is_modification: false,
    created_at: createdAt,
  })
  if (signalErr) {
    if (signalErr.code === '23505') return
    console.warn(`[tradingViewIngest] signal insert failed webhook=${webhook.id}: ${signalErr.message}`)
    await recordDelivery(supabase, webhook, 'error', idempotencyKey, 'signal_insert_failed', null)
    return
  }

  const recorded = await recordDelivery(supabase, webhook, 'accepted', idempotencyKey, null, signalId)
  if (recorded === 'duplicate') return

  dispatchAcceptedSignal(webhook, {
    id: signalId,
    parsed_data: parsedData,
    status: 'parsed',
    telegram_message_id: idempotencyKey,
    created_at: createdAt,
    raw_message: rawMessage,
  }, tradeExecutor)
}

/**
 * Full ingest after TradingView has already been ACKed.
 */
export async function processTradingViewIngest(
  supabase: SupabaseClient,
  token: string,
  raw: string,
  tradeExecutor: TradeExecutor | null,
): Promise<void> {
  const [tokenHash, bodyHash] = [sha256Hex(token), sha256Hex(raw)]
  const { data } = await supabase
    .from('tradingview_webhooks')
    .select('id, user_id, channel_id, name, is_active')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  const webhook = (data ?? null) as TradingViewWebhookRow | null
  if (!webhook) {
    console.warn(`[tradingViewIngest] unknown token hash=${tokenHash.slice(0, 12)}`)
    return
  }

  if (!webhook.is_active) {
    await recordDelivery(supabase, webhook, 'skipped', `inactive:${bodyHash}`, 'inactive', null)
    return
  }

  const parsed = parseTradingViewAlert(raw)
  const idempotencyKey = parsed.ok && parsed.alert.idempotencyId
    ? parsed.alert.idempotencyId
    : `${bodyHash}:${randomUUID()}`

  if (!parsed.ok) {
    const skipStatus = parsed.reason === 'unknown_action'
      || parsed.reason.startsWith('unresolved_')
      ? 'skipped'
      : 'error'
    console.warn(
      `[tradingViewIngest] parse failed webhook=${webhook.id} reason=${parsed.reason} body=${JSON.stringify(raw.slice(0, 240))}`,
    )
    await recordDelivery(supabase, webhook, skipStatus, idempotencyKey, parsed.reason, null)
    return
  }

  await persistAcceptedAlert(supabase, webhook, raw, parsed, idempotencyKey, tradeExecutor)
}
