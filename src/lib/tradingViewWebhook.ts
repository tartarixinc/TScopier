import type { SupabaseClient } from '@supabase/supabase-js'
import { disconnectChannelFromBroker } from './brokerChannelLink'
import type { BrokerAccount } from '../types/database'

const MAX_WEBHOOKS_PER_USER = 20
const WEBHOOKS_CHANGED = 'tradingview-webhooks-changed'

function notifyTradingViewWebhooksChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(WEBHOOKS_CHANGED))
}

export function subscribeTradingViewWebhooksChanged(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(WEBHOOKS_CHANGED, onChange)
  return () => window.removeEventListener(WEBHOOKS_CHANGED, onChange)
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createTradingViewWebhook(
  supabase: SupabaseClient,
  userId: string,
  name: string,
): Promise<{ error: string | null; id: string | null }> {
  const { count, error: countError } = await supabase
    .from('tradingview_webhooks')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (countError) return { error: countError.message, id: null }
  if ((count ?? 0) >= MAX_WEBHOOKS_PER_USER) return { error: 'webhook_limit', id: null }

  const label = name.trim().slice(0, 80) || 'TradingView'
  const channelKey = `tv:${crypto.randomUUID()}`
  const { data: channel, error: channelError } = await supabase
    .from('telegram_channels')
    .insert({
      user_id: userId,
      channel_id: channelKey,
      channel_username: '',
      display_name: label,
      is_active: true,
      source_kind: 'tradingview',
    })
    .select('id')
    .single()
  if (channelError || !channel) return { error: channelError?.message ?? 'create_failed', id: null }

  const token = randomToken()
  const { data: webhook, error: webhookError } = await supabase.from('tradingview_webhooks').insert({
    user_id: userId,
    channel_id: channel.id,
    name: label,
    token_hash: await sha256Hex(token),
    token,
    is_active: true,
  }).select('id').single()
  if (webhookError || !webhook) {
    await supabase.from('telegram_channels').delete().eq('id', channel.id).eq('user_id', userId)
    return { error: webhookError?.message ?? 'create_failed', id: null }
  }
  notifyTradingViewWebhooksChanged()
  return { error: null, id: webhook.id }
}

export async function setTradingViewWebhookActive(
  supabase: SupabaseClient,
  userId: string,
  webhookId: string,
  isActive: boolean,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('tradingview_webhooks')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', webhookId)
    .eq('user_id', userId)
  return { error: error?.message ?? null }
}

export async function rotateTradingViewWebhook(
  supabase: SupabaseClient,
  userId: string,
  webhookId: string,
): Promise<{ error: string | null }> {
  const token = randomToken()
  const { error } = await supabase
    .from('tradingview_webhooks')
    .update({
      token,
      token_hash: await sha256Hex(token),
      updated_at: new Date().toISOString(),
    })
    .eq('id', webhookId)
    .eq('user_id', userId)
  return { error: error?.message ?? null }
}

export async function deleteTradingViewWebhook(
  supabase: SupabaseClient,
  userId: string,
  webhook: { id: string; channel_id: string },
  brokers: BrokerAccount[],
): Promise<{ error: string | null; brokers: BrokerAccount[] }> {
  const updated: BrokerAccount[] = []
  for (const broker of brokers) {
    const removed = await disconnectChannelFromBroker(supabase, userId, broker, webhook.channel_id)
    if (removed.error) return { error: removed.error, brokers: updated }
    if (removed.broker && removed.broker !== broker) updated.push(removed.broker)
  }
  const { error } = await supabase
    .from('telegram_channels')
    .delete()
    .eq('id', webhook.channel_id)
    .eq('user_id', userId)
    .eq('source_kind', 'tradingview')
  if (!error) notifyTradingViewWebhooksChanged()
  return { error: error?.message ?? null, brokers: updated }
}
