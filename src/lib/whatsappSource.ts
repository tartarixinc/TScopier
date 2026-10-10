import type { SupabaseClient } from '@supabase/supabase-js'
import { disconnectChannelFromBroker } from './brokerChannelLink'
import { isWhatsAppGroupJid, whatsappListenerBaseUrl, whatsappShadowChannelId } from './whatsappGroup'
import type { BrokerAccount } from '../types/database'

export { isWhatsAppGroupJid, whatsappListenerBaseUrl, whatsappShadowChannelId } from './whatsappGroup'

const WHATSAPP_CHANGED = 'whatsapp-sources-changed'

export type WhatsAppSessionStatus = 'qr' | 'connected' | 'disconnected'

function notifyWhatsAppSourcesChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(WHATSAPP_CHANGED))
}

export function subscribeWhatsAppSourcesChanged(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(WHATSAPP_CHANGED, onChange)
  return () => window.removeEventListener(WHATSAPP_CHANGED, onChange)
}

async function listenerFetch<T>(
  supabase: SupabaseClient,
  path: string,
  method: 'GET' | 'POST',
): Promise<{ data: T | null; error: string | null }> {
  const base = whatsappListenerBaseUrl()
  if (!base) return { data: null, error: 'listener_missing' }
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) return { data: null, error: 'unauthorized' }
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    })
  } catch {
    return { data: null, error: 'listener_unavailable' }
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) return { data: null, error: body.error || 'listener_failed' }
  return { data: body, error: null }
}

export async function pairWhatsApp(
  supabase: SupabaseClient,
): Promise<{ status: WhatsAppSessionStatus | null; qr: string | null; error: string | null }> {
  const result = await listenerFetch<{ status?: WhatsAppSessionStatus; qr?: string | null }>(supabase, '/whatsapp/pair', 'POST')
  if (result.error || !result.data) return { status: null, qr: null, error: result.error }
  return { status: result.data.status ?? null, qr: result.data.qr ?? null, error: null }
}

export async function fetchWhatsAppStatus(
  supabase: SupabaseClient,
): Promise<{ status: WhatsAppSessionStatus | null; qr: string | null; error: string | null }> {
  const result = await listenerFetch<{ status?: WhatsAppSessionStatus; qr?: string | null }>(supabase, '/whatsapp/status', 'GET')
  if (result.error || !result.data) return { status: null, qr: null, error: result.error }
  return { status: result.data.status ?? null, qr: result.data.qr ?? null, error: null }
}

export async function fetchWhatsAppGroups(
  supabase: SupabaseClient,
): Promise<{ groups: Array<{ group_jid: string; name: string }>; error: string | null }> {
  const result = await listenerFetch<{ groups?: Array<{ group_jid: string; name: string }> }>(supabase, '/whatsapp/groups', 'GET')
  if (result.error || !result.data) return { groups: [], error: result.error }
  return { groups: result.data.groups ?? [], error: null }
}

export async function logoutWhatsApp(supabase: SupabaseClient): Promise<{ error: string | null }> {
  const result = await listenerFetch<Record<string, unknown>>(supabase, '/whatsapp/logout', 'POST')
  if (!result.error) notifyWhatsAppSourcesChanged()
  return { error: result.error }
}

export async function addWhatsAppGroup(
  supabase: SupabaseClient,
  userId: string,
  groupJid: string,
  name: string,
): Promise<{ error: string | null; channelId: string | null }> {
  if (!isWhatsAppGroupJid(groupJid)) return { error: 'invalid_group', channelId: null }
  const label = name.trim().slice(0, 80) || 'WhatsApp'
  const { data: channel, error: channelError } = await supabase
    .from('telegram_channels')
    .insert({
      user_id: userId,
      channel_id: whatsappShadowChannelId(groupJid),
      channel_username: '',
      display_name: label,
      is_active: true,
      source_kind: 'whatsapp',
    })
    .select('id')
    .single()
  if (channelError || !channel) return { error: channelError?.message ?? 'create_failed', channelId: null }

  const { error: linkError } = await supabase.from('whatsapp_groups').insert({
    user_id: userId,
    group_jid: groupJid,
    name: label,
    channel_id: channel.id,
    is_active: true,
  })
  if (linkError) {
    await supabase.from('telegram_channels').delete().eq('id', channel.id).eq('user_id', userId)
    return { error: linkError.message, channelId: null }
  }
  notifyWhatsAppSourcesChanged()
  return { error: null, channelId: channel.id }
}

export async function setWhatsAppGroupActive(
  supabase: SupabaseClient,
  userId: string,
  groupRowId: string,
  shadowChannelId: string,
  isActive: boolean,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('telegram_channels')
    .update({ is_active: isActive })
    .eq('id', shadowChannelId)
    .eq('user_id', userId)
    .eq('source_kind', 'whatsapp')
  if (error) return { error: error.message }
  const { error: rowError } = await supabase
    .from('whatsapp_groups')
    .update({ is_active: isActive })
    .eq('id', groupRowId)
    .eq('user_id', userId)
  if (rowError) return { error: rowError.message }
  notifyWhatsAppSourcesChanged()
  return { error: null }
}

export async function removeWhatsAppGroup(
  supabase: SupabaseClient,
  userId: string,
  shadowChannelId: string,
  brokers: BrokerAccount[],
): Promise<{ error: string | null; brokers: BrokerAccount[] }> {
  const updated: BrokerAccount[] = []
  for (const broker of brokers) {
    const removed = await disconnectChannelFromBroker(supabase, userId, broker, shadowChannelId)
    if (removed.error) return { error: removed.error, brokers: updated }
    if (removed.broker && removed.broker !== broker) updated.push(removed.broker)
  }
  const { error } = await supabase
    .from('telegram_channels')
    .delete()
    .eq('id', shadowChannelId)
    .eq('user_id', userId)
    .eq('source_kind', 'whatsapp')
  if (error) return { error: error.message, brokers: updated }
  notifyWhatsAppSourcesChanged()
  return { error: null, brokers: updated }
}
